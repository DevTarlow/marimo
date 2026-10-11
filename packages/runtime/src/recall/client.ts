/**
 * The one place that speaks to the recall engine.
 *
 * llama-server is an OpenAI-shaped HTTP server, so this is a small client rather
 * than a binding: one POST, a batch of inputs in, a batch of vectors out. What is
 * worth reading before changing anything here is *which* request shape works,
 * because the published documentation is wrong about it.
 *
 * The model card and the llama.cpp docs both describe the non-OpenAI endpoint:
 *
 *   POST /embedding   {"content": {"prompt_string": "...",
 *                                  "multimodal_data": ["<base64>"]}}
 *
 * On the pinned build that answers **HTTP 500, "Failed to tokenize prompt"** —
 * verified, not guessed. What works is the typed-content form of the normal
 * embeddings endpoint, added to llama.cpp after the docs page was written:
 *
 *   POST /v1/embeddings
 *   {"input": [{"content": [
 *      {"type": "text",              "text": "..."},
 *      {"type": "image_url",         "image_url": {"url": "data:...;base64,..."}},
 *      {"type": "input_audio",       "input_audio": {"data": "...", "format": "wav"}}
 *   ]}]}
 *
 * and one input yields exactly one vector, which is what makes an interleaved
 * input — a file name, then a picture, in one request — a single point in the
 * space rather than several.
 *
 * Three more things this file is responsible for:
 *
 * - **Order.** The engine answers with an `index` per vector, and the vectors
 *   are not guaranteed to arrive in the order they were sent. They are sorted by
 *   that index before anything else touches them, because a folder indexed with
 *   its vectors out of order is a search that returns the wrong lines forever.
 * - **Width.** Every vector is checked against the width the index was written
 *   in. A mismatched vector does not throw on its own — it scores against
 *   nothing, which reads as a model that finds nothing rather than as two files
 *   that do not belong together.
 * - **Finite values.** This model's card warns that its activations exceed
 *   float16's range and return NaN in it. A NaN vector stored in an index is
 *   permanent: it is not an error anywhere, it just never matches and never
 *   ranks, and it is invisible from the window. So it is refused at the door.
 */
export type EmbeddingPart =
  | {type: 'text'; text: string}
  | {type: 'image_url'; image_url: {url: string}}
  | {type: 'input_audio'; input_audio: {data: string; format: 'wav'}};

/** Raised with a sentence meant for a person, like every other failure here. */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface EmbeddingResult {
  vectors: Float32Array[];
  /** Prompt tokens the engine counted, for a caller that reports cost. */
  tokens: number;
}

/**
 * How long one request may take before it is abandoned.
 *
 * Generous on purpose, and it is a guard against a wedged engine rather than a
 * service level: the slowest thing this app will ever send is a two-dozen-frame
 * video, measured at about nineteen seconds on a processor. A caller with a
 * tighter budget — a memory lookup inside a turn — passes its own, because that
 * deadline belongs to the turn rather than to the transport.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** How many inputs go in one request when the caller does not say. */
const DEFAULT_BATCH_SIZE = 32;

export interface EmbeddingClientOptions {
  /**
   * Where the engine is, asked per call.
   *
   * A function rather than an address because the port is whatever was free when
   * the engine started: there is no stored address to go stale, which is
   * invariant 16 and the reason a fixed port is never written down anywhere.
   * `undefined` means it is not running, which is a sentence rather than a
   * request sent to nothing.
   *
   * May be asynchronous, and is awaited either way, because the honest answer to
   * "where is it" is the supervisor's own status — a copy kept beside it would
   * be an address that outlives the process it points at.
   */
  baseUrl: () => string | undefined | Promise<string | undefined>;
  /** The width the index is written in; every vector is checked against it. */
  dims: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

export class EmbeddingClient {
  constructor(private readonly options: EmbeddingClientOptions) {}

  /** Text in, one vector out per input. */
  async embedText(
    texts: readonly string[],
    call: {timeoutMs?: number} = {},
  ): Promise<EmbeddingResult> {
    return await this.embed(
      texts.map((text) => [{type: 'text', text}] as EmbeddingPart[]),
      call,
    );
  }

  /**
   * Inputs in, one vector out per input.
   *
   * Batched by count. Media callers send one input per request — not because of
   * this function but because each one is huge and slow, and the engine's
   * physical batch is a shared budget rather than a per-request one.
   */
  async embed(
    inputs: readonly EmbeddingPart[][],
    call: {timeoutMs?: number} = {},
  ): Promise<EmbeddingResult> {
    if (inputs.length === 0) {
      return {vectors: [], tokens: 0};
    }
    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const vectors: Float32Array[] = [];
    let tokens = 0;

    for (let at = 0; at < inputs.length; at += batchSize) {
      const batch = inputs.slice(at, at + batchSize);
      const answer = await this.request(batch, call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      vectors.push(...answer.vectors);
      tokens += answer.tokens;
    }

    return {vectors, tokens};
  }

  private async request(
    batch: readonly EmbeddingPart[][],
    timeoutMs: number,
  ): Promise<EmbeddingResult> {
    const baseUrl = await this.options.baseUrl();
    if (baseUrl === undefined) {
      throw new EmbeddingError(
        'The recall model is not running. Settings → Recall will say whether it ' +
          'is installed.',
      );
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          input: batch.map((content) => ({content})),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (failure) {
      throw new EmbeddingError(
        `The recall model could not be reached: ${describe(failure)}.`,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      /*
       * The engine's own words, when it has any. It answers a bad request with a
       * message that names the cause — "input (669 tokens) is too large to
       * process" was how the physical-batch limit was found — and replacing that
       * with "HTTP 500" would throw away the only useful half.
       */
      throw new EmbeddingError(
        `The recall model refused the request (${String(response.status)})${
          serverMessage(body) === undefined ? '' : `: ${serverMessage(body)}`
        }.`,
      );
    }

    const parsed = parseAnswer(body);
    if (parsed.vectors.length !== batch.length) {
      throw new EmbeddingError(
        `The recall model returned ${String(parsed.vectors.length)} vectors for ` +
          `${String(batch.length)} inputs, so the results cannot be matched to ` +
          'what was sent.',
      );
    }

    const dims = this.options.dims;
    const vectors = parsed.vectors.map((vector, index) => {
      if (vector.length !== dims) {
        throw new EmbeddingError(
          `The recall model returned a ${String(vector.length)}-value vector ` +
            `where this index holds ${String(dims)}. The model file and the ` +
            'index do not match, so the index has to be built again.',
        );
      }
      for (const value of vector) {
        if (!Number.isFinite(value)) {
          throw new EmbeddingError(
            `The recall model returned a vector with values that are not finite ` +
              `numbers (input ${String(index + 1)}). Its own card warns that this ` +
              'happens in half precision, so the engine is being run on the ' +
              'processor on purpose — something has changed.',
          );
        }
      }
      /*
       * A zero vector is checked for the same reason a NaN is: cosine is scale
       * invariant, so the only way to get one is a model that failed to produce
       * anything, and a stored zero matches nothing at all while looking like a
       * perfectly good row.
       */
      if (norm(vector) === 0) {
        throw new EmbeddingError(
          `The recall model returned an all-zero vector (input ` +
            `${String(index + 1)}), which is not an embedding.`,
        );
      }
      return vector;
    });

    return {vectors, tokens: parsed.tokens};
  }
}

/**
 * The engine's answer, as vectors in the order they were sent.
 *
 * Sorted by `index` rather than trusted: the endpoints are allowed to answer in
 * any order, and a folder indexed out of order is a search that returns the wrong
 * text at the right score.
 */
function parseAnswer(body: string): {vectors: Float32Array[]; tokens: number} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EmbeddingError('The recall model answered with something that is not JSON.');
  }
  const record = parsed as {
    data?: Array<{index?: number; embedding?: number[]}>;
    usage?: {prompt_tokens?: number};
  };
  if (!Array.isArray(record.data)) {
    throw new EmbeddingError('The recall model answered with no embeddings.');
  }

  const rows = record.data
    .map((entry, position) => ({position, entry}))
    .sort((left, right) => {
      const a = left.entry.index ?? left.position;
      const b = right.entry.index ?? right.position;
      return a - b;
    });

  const vectors = rows.map(({entry}) => {
    if (!Array.isArray(entry.embedding)) {
      throw new EmbeddingError('The recall model answered with an entry that holds no vector.');
    }
    /*
     * A hole in the vector, which is how a NaN actually arrives.
     *
     * JSON has no NaN, so a non-finite value is serialized as `null` by the
     * engine, and `Float32Array.from([1, null, 0])` is `[1, 0, 0]` — a perfectly
     * plausible vector with a zero where the model produced nothing. Nothing
     * later in this file could tell that apart from a real value, and an index
     * built from it would be quietly wrong at that coordinate forever. So the
     * raw entries are checked as numbers *before* anything converts them.
     */
    for (const [at, value] of entry.embedding.entries()) {
      if (typeof value !== 'number') {
        throw new EmbeddingError(
          `The recall model returned ${value === null ? 'null' : typeof value} ` +
            `where a vector value belongs (position ${String(at + 1)}). A ` +
            'non-finite value cannot be written in JSON and arrives as null, ' +
            'which would otherwise be indexed as a zero.',
        );
      }
    }
    return Float32Array.from(entry.embedding);
  });

  return {vectors, tokens: record.usage?.prompt_tokens ?? 0};
}

/** The engine's `error.message`, when the body holds one. */
function serverMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {error?: {message?: unknown}};
    const message = parsed.error?.message;
    return typeof message === 'string' && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}

function norm(vector: Float32Array): number {
  let total = 0;
  for (const value of vector) {
    total += value * value;
  }
  return Math.sqrt(total);
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
