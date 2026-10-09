/**
 * The OpenAI-compatible provider for Google ADK-JS.
 *
 * ADK ships Gemini and Apigee model classes only, so an OpenAI-compatible
 * provider is a normal `BaseLlm` implementation registered with `LLMRegistry`.
 * Everything here is transport: message translation lives in
 * `openai-mapping.ts`, SSE framing in `sse.ts`.
 *
 * One client serves every backend the app offers — DeepSeek, a local server
 * (llama.cpp, LM Studio, Unsloth), and Gemini through Google's
 * OpenAI-compatibility layer — because all three expose the same
 * `/chat/completions` shape. What differs between them is
 * a property of the endpoint rather than of a request, so it arrives as the
 * `provider` option and is looked up in the protocol's catalogue instead of
 * being branched on here. The one real difference today is
 * `stream_options.include_usage`, which Gemini's compatibility layer rejects:
 * sending it there would fail every turn, while omitting it elsewhere would only
 * cost the token counts in the UI.
 *
 * Protocol references:
 *   https://api-docs.deepseek.com/api/create-chat-completion
 *   https://ai.google.dev/gemini-api/docs/openai
 */
import {BaseLlm} from '@google/adk';
import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {FinishReason} from '@google/genai';
import type {
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';

import {PROVIDERS} from '@marimo/protocol';
import type {ProviderId} from '@marimo/protocol';

import {
  systemInstructionToText,
  toOpenAiMessages,
  toOpenAiTools,
} from './openai-mapping.js';
import type {OpenAiMessage} from './openai-mapping.js';
import {iterateSseData} from './sse.js';

export interface OpenAiCompatLlmOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /**
   * Which backend is behind `baseUrl`. Absent means DeepSeek, so a caller with
   * no settings file (a test, a future CLI) keeps the behaviour it had.
   */
  provider?: ProviderId;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Raised when the provider answers with a non-2xx status or the call fails. */
export class OpenAiCompatRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenAiCompatRequestError';
    this.status = status;
  }
}

interface StreamToolCallAccumulator {
  id?: string;
  name?: string;
  args: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenAiCompatLlm extends BaseLlm {
  /**
   * Only documentation, today: `AgentHost` constructs this class directly and
   * never consults `LLMRegistry`, so nothing here decides which client runs.
   *
   * Deliberately not a wildcard. A locally served model id is whatever file the
   * server loaded — `Qwen3-30B-A3B-Q4_K_M`, say — so no pattern can claim it
   * honestly, and a match-everything entry would let this class answer a
   * registry lookup meant for ADK's native Gemini client.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /^deepseek-.*$/,
    /^gemini-.*$/,
  ];

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly temperature?: number;
  private readonly maxOutputTokens?: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly provider: ProviderId;

  constructor(options: OpenAiCompatLlmOptions) {
    super({model: options.model});
    this.provider = options.provider ?? 'deepseek';
    this.apiKey = options.apiKey;
    this.baseUrl = (
      options.baseUrl ?? PROVIDERS[this.provider].defaultBaseUrl
    ).replace(/\/+$/, '');
    this.temperature = options.temperature;
    this.maxOutputTokens = options.maxOutputTokens;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, undefined> {
    // The wire call always streams, even when ADK asks for a single response.
    // One path means the reasoning channel and the usage chunk are always
    // available; a non-streaming caller just receives the aggregated final
    // response instead of the partial chunks before it.
    const body = this.buildRequestBody(llmRequest, true);
    const response = await this.post(body, abortSignal);

    if (stream) {
      yield* this.streamResponse(response, abortSignal);
      return;
    }

    let final: LlmResponse | undefined;
    for await (const chunk of this.streamResponse(response, abortSignal)) {
      final = chunk;
    }
    if (final) {
      yield final;
    }
  }

  /**
   * These endpoints expose no bidirectional/live transport. ADK only calls this
   * for live-audio agents, which this app does not run.
   */
  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(
      `${this.label} does not support live (bidirectional) connections.`,
    );
  }

  /** How the provider is named in an error the user will read. */
  private get label(): string {
    return PROVIDERS[this.provider].label;
  }

  private buildRequestBody(
    llmRequest: LlmRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages: OpenAiMessage[] = [];

    const system = systemInstructionToText(
      llmRequest.config?.systemInstruction,
    );
    if (system.length > 0) {
      messages.push({role: 'system', content: system});
    }
    messages.push(...toOpenAiMessages(llmRequest.contents));

    const tools = toOpenAiTools(functionDeclarations(llmRequest));

    const body: Record<string, unknown> = {
      model: llmRequest.model ?? this.model,
      messages,
      stream,
    };

    const temperature = llmRequest.config?.temperature ?? this.temperature;
    if (typeof temperature === 'number') {
      body.temperature = temperature;
    }
    const maxTokens =
      llmRequest.config?.maxOutputTokens ?? this.maxOutputTokens;
    if (typeof maxTokens === 'number') {
      body.max_tokens = maxTokens;
    }
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (stream && PROVIDERS[this.provider].usageInStream) {
      // Ask for a trailing usage-only chunk so token counts reach the UI. Not
      // every endpoint understands the field, and the ones that do not answer
      // with an error rather than ignoring it.
      body.stream_options = {include_usage: true};
    }

    return body;
  }

  private async post(
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const signal = this.combineSignals(abortSignal);
    /*
     * A local server — llama.cpp, LM Studio, Unsloth — usually runs without a
     * key and does not care what is in the header, but an empty `Bearer ` is
     * still a lie about there being a credential; the header is simply left off
     * when there is nothing to send.
     */
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey.length > 0) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (abortSignal?.aborted) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenAiCompatRequestError(
        0,
        `${this.label} request failed: ${reason}`,
      );
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new OpenAiCompatRequestError(
        response.status,
        `${this.label} returned ${response.status}: ${detail}`,
      );
    }

    return response;
  }

  private async *streamResponse(
    response: Response,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, undefined> {
    if (!response.body) {
      throw new OpenAiCompatRequestError(
        response.status,
        `${this.label} returned a streaming response with no body.`,
      );
    }

    let text = '';
    let reasoning = '';
    let usage: GenerateContentResponseUsageMetadata | undefined;
    let finishReason: FinishReason | undefined;
    const toolCalls = new Map<number, StreamToolCallAccumulator>();

    for await (const payload of iterateSseData(response.body)) {
      if (abortSignal?.aborted) {
        return;
      }
      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAiStreamChunk;
      } catch {
        // A keep-alive or malformed frame is not worth failing the turn over.
        continue;
      }

      if (chunk.usage) {
        usage = toUsageMetadata(chunk.usage);
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }

      const delta = choice.delta ?? {};

      /*
       * Parsed for every provider rather than only the ones that document it.
       * The field is DeepSeek's, and llama.cpp emits it for reasoning models
       * under `--reasoning-format deepseek`; an endpoint that never sends it
       * costs one `typeof` check. Refusing to read it would throw away thinking
       * that did arrive.
       */
      if (
        typeof delta.reasoning_content === 'string' &&
        delta.reasoning_content
      ) {
        reasoning += delta.reasoning_content;
        yield {
          content: {
            role: 'model',
            parts: [{text: delta.reasoning_content, thought: true}],
          },
          partial: true,
        };
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        yield {
          content: {role: 'model', parts: [{text: delta.content}]},
          partial: true,
        };
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const accumulator = toolCalls.get(index) ?? {args: ''};
        if (call.id) {
          accumulator.id = call.id;
        }
        if (call.function?.name) {
          accumulator.name = call.function.name;
        }
        if (call.function?.arguments) {
          accumulator.args += call.function.arguments;
        }
        toolCalls.set(index, accumulator);
      }

      if (choice.finish_reason) {
        finishReason = mapFinishReason(choice.finish_reason);
      }
    }

    const parts: Part[] = [];
    // Reasoning first, as a thought part: ADK persists it with the turn, the UI
    // shows it as the reasoning block, and the mapping layer echoes it back as
    // `reasoning_content` on the next request, which DeepSeek requires whenever
    // tools are in play.
    if (reasoning.length > 0) {
      parts.push({text: reasoning, thought: true});
    }
    if (text.length > 0) {
      parts.push({text});
    }
    for (const [, accumulator] of [...toolCalls.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (!accumulator.name) {
        continue;
      }
      parts.push({
        functionCall: {
          id: accumulator.id,
          name: accumulator.name,
          args: parseArguments(accumulator.args),
        },
      });
    }

    yield {
      content: {role: 'model', parts},
      partial: false,
      turnComplete: true,
      finishReason,
      usageMetadata: usage,
    };
  }

  private combineSignals(abortSignal?: AbortSignal): AbortSignal | undefined {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    if (!abortSignal) {
      return timeout;
    }
    return AbortSignal.any([abortSignal, timeout]);
  }
}

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {name?: string; arguments?: string};
}

interface OpenAiDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiChoice {
  index?: number;
  delta?: OpenAiDelta;
  message?: OpenAiDelta & {tool_calls?: OpenAiToolCallDelta[]};
  finish_reason?: string | null;
}

interface OpenAiStreamChunk {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage | null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toUsageMetadata(
  usage: OpenAiUsage,
): GenerateContentResponseUsageMetadata {
  return {
    promptTokenCount: usage.prompt_tokens ?? 0,
    candidatesTokenCount: usage.completion_tokens ?? 0,
    totalTokenCount:
      usage.total_tokens ??
      (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

function mapFinishReason(reason: string | undefined): FinishReason | undefined {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    case undefined:
    case null:
      return undefined;
    default:
      return FinishReason.OTHER;
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {value: parsed};
  } catch {
    return {__raw: trimmed};
  }
}

function functionDeclarations(llmRequest: LlmRequest): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    const candidate = tool as {functionDeclarations?: FunctionDeclaration[]};
    if (Array.isArray(candidate.functionDeclarations)) {
      declarations.push(...candidate.functionDeclarations);
    }
  }
  return declarations;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return response.statusText || 'no response body';
    }
    return trimmed.slice(0, 500);
  } catch {
    return response.statusText || 'unreadable response body';
  }
}
