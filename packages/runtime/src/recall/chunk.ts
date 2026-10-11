/**
 * Cutting a file into pieces a vector can stand for.
 *
 * The unit is a *line*, not a sentence and not a token, and the reason is the one
 * that decides everything else in this file: a result has to be showable. A hit
 * is reported as `path:41-58` and the user (or the model) goes and reads those
 * lines, so a chunk is a range of lines and the text of the chunk is exactly
 * what those lines say. Cutting mid-sentence would make the range a lie.
 *
 * The size is 800 characters with 100 of overlap, and it is a judgement:
 *
 * - **Why characters and not tokens.** Counting tokens would mean shipping the
 *   model's tokenizer into a package that has no business knowing it. The number
 *   that actually matters is the engine's physical batch — 4,096 tokens — and 800
 *   characters of prose is roughly 200 tokens, so the margin is an order of
 *   magnitude rather than a coincidence.
 * - **Why 800.** A whole file as one vector averages everything in it and
 *   matches nothing in particular; a line at a time loses the context that makes
 *   a line mean anything. At 800 characters a chunk is a function or a paragraph,
 *   which is the size of thing a question is usually about.
 * - **Why overlap.** A fact that sits across a cut has to be findable from both
 *   halves, or where the cut falls decides whether search finds it — a bug that
 *   appears and disappears as a file's imports change length.
 *
 * One thing it does not preserve, on purpose: blank lines inside a chunk are
 * dropped. They cost tokens without carrying meaning, and a vector is an average
 * over what it is given. It also means a chunk's text is the *content* of its
 * lines rather than a byte-exact slice of the file — which is why a hit is shown
 * by cutting the file again with this same function rather than by arithmetic on
 * offsets, and why the range reported is still exactly the lines it came from.
 */
export interface TextChunk {
  /** 1-based, inclusive: the first line of `text`. */
  startLine: number;
  /** 1-based, inclusive: the last line of `text`. */
  endLine: number;
  text: string;
}

export const CHUNK_CHARS = 800;
export const CHUNK_OVERLAP_CHARS = 100;

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/**
 * One piece per `{startLine, endLine, text}`, in file order.
 *
 * Deterministic, which is load-bearing rather than tidy: a chunk's text is
 * hashed when it is indexed and hashed again when a result is shown, and a
 * reader that cut the file differently would report every hit as stale. It is
 * also why the same function is the only thing that ever cuts a file.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = options.maxChars ?? CHUNK_CHARS;
  const overlapChars = options.overlapChars ?? CHUNK_OVERLAP_CHARS;

  const segments = toSegments(text, maxChars);
  if (segments.length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let current: Segment[] = [];
  let length = 0;
  /*
   * Whether a segment has been added since the last chunk was emitted.
   *
   * Without it the loop's last iteration is ambiguous: `current` may be the
   * overlap carried out of the previous chunk, and emitting that would index the
   * same lines twice — a search that returns one paragraph at two scores.
   */
  let pending = false;

  const emit = (): void => {
    const first = current[0] as Segment;
    const last = current[current.length - 1] as Segment;
    chunks.push({
      startLine: first.line,
      endLine: last.line,
      text: current.map((segment) => segment.text).join('\n'),
    });
    current = tailOf(current, overlapChars);
    length = current.reduce((total, segment) => total + segment.text.length + 1, 0);
    pending = false;
  };

  for (const segment of segments) {
    const cost = segment.text.length + 1;
    if (pending && length + cost > maxChars) {
      emit();
    }
    current.push(segment);
    length += cost;
    pending = true;
  }
  if (pending) {
    emit();
  }

  return chunks;
}

/** One line, or one slice of a line too long to be a chunk on its own. */
interface Segment {
  line: number;
  text: string;
}

/**
 * The file as segments, with any line longer than a chunk pre-sliced.
 *
 * A minified bundle or a base64 blob is one line of hundreds of kilobytes, and
 * without this it would be one chunk: indexed as a single vector that matches
 * nothing, and re-embedded whole every time the file changes. Slicing keeps the
 * line number honest — every slice reports the line it came from — so a hit still
 * points somewhere a person can look.
 */
function toSegments(text: string, maxChars: number): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (line.length === 0) {
      continue;
    }
    if (line.length <= maxChars) {
      segments.push({line: index + 1, text: line});
      continue;
    }
    for (let at = 0; at < line.length; at += maxChars) {
      segments.push({line: index + 1, text: line.slice(at, at + maxChars)});
    }
  }
  return segments;
}

/** The last segments whose combined length fits in `overlapChars`. */
function tailOf(segments: readonly Segment[], overlapChars: number): Segment[] {
  if (overlapChars <= 0) {
    return [];
  }
  const kept: Segment[] = [];
  let length = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as Segment;
    const cost = segment.text.length + 1;
    if (length + cost > overlapChars) {
      break;
    }
    kept.unshift(segment);
    length += cost;
  }
  /*
   * Carrying *all* of the previous chunk forward is not an overlap, it is the
   * same text indexed twice: every line of it was just emitted, so the next
   * chunk would share its whole body and both would match the same question.
   * That happens when a chunk is shorter than the overlap budget — one long line
   * that was sliced, or a small `maxChars` — and the answer there is no overlap
   * rather than a duplicate.
   */
  return kept.length >= segments.length ? [] : kept;
}
