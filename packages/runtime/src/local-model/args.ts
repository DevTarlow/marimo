/**
 * The command line the app hands the engine, as data.
 *
 * A function that returns an array rather than a `spawn` call with the flags
 * inline, for the reason `service/plan.ts` is split the same way: every mistake
 * worth catching is in the *content* of what gets run, and a test can assert on
 * an array in a millisecond where starting a multi-gigabyte model takes seconds
 * and a machine. The one caller that spawns is tested with a fake.
 *
 * Every flag here has been run against the pinned engine with the real weights —
 * `--jinja`, the quantized cache and `--flash-attn on` together, at 16K, with a
 * tool call coming back structured. That is the standard this file is held to,
 * because each of these fails silently in a different way.
 */
import {LOCAL_MODEL_ID} from '@marimo/protocol';

import type {EmbeddingPooling} from './manifest.js';

export interface EngineSpec {
  /** The `llama-server` binary. */
  engine: string;
  /** The weights. */
  model: string;
  /**
   * The loopback port it came up on.
   *
   * A string is allowed for the one caller that has no port yet: the status the
   * Settings card draws shows the command *before* anything is running, and
   * `--port <port>` is a truer answer there than a zero that looks like one.
   */
  port: number | string;
  contextSize: number;
  thinking: boolean;
}

/**
 * How many layers to offload.
 *
 * All of them, always, and there is no CPU value: the app ships GPU engine builds
 * only, and it refuses to start rather than fall back to a processor. A number
 * that could be zero would be a configuration nobody should be in — a 4.7B model
 * on a CPU is a wait rather than an answer — so it is a constant rather than a
 * setting with a wrong default.
 */
const GPU_LAYERS = 99;

/**
 * The KV cache type.
 *
 * `q8_0` halves the cache at a measured cost of about zero perplexity, and at 32K
 * that half is the difference between 1 GB and 500 MB on a card where the
 * difference decides whether the bigger tier fits. It requires flash attention,
 * which is why that flag is explicit below rather than left on `auto`: an engine
 * that resolved `auto` to `off` would quietly store the cache at f16 and use the
 * memory this exists to save.
 */
const KV_CACHE_TYPE = 'q8_0';

/**
 * The whole argv, in the order the engine documents it.
 *
 * The flags that matter, and why each is here rather than being left to a
 * default:
 *
 * - `--jinja` is load-bearing. Without it llama.cpp does not apply the model's
 *   own chat template, and Qwen3.5's template is the only thing that turns its
 *   `<tool_call>` block into a call this app can see. The engine runs perfectly,
 *   every request succeeds, and the agent is offered no tools at all — which
 *   looks like a model that is merely unhelpful. Verified against the pinned
 *   build: with `--jinja` a tool call arrives as a structured `tool_calls` delta
 *   with its arguments intact.
 * - `--alias` names the model so the id in a request is the app's own
 *   (`LOCAL_MODEL_ID`) rather than a path with a quantization in it.
 * - `--host 127.0.0.1` keeps it off the network. This is a server, and the one
 *   thing it must never be is reachable from somewhere else on the LAN.
 * - `--no-webui` because there is no browser to serve: it is a chat page for a
 *   human, and leaving it on would open a port with a UI on it for no reason.
 * - `--parallel 1`, because this app runs one turn at a time by design.
 */
export function engineArgs(spec: EngineSpec): string[] {
  return [
    '--model',
    spec.model,
    '--alias',
    LOCAL_MODEL_ID,
    '--host',
    '127.0.0.1',
    '--port',
    String(spec.port),
    '--ctx-size',
    String(spec.contextSize),
    '--n-gpu-layers',
    String(GPU_LAYERS),
    '--flash-attn',
    'on',
    '--cache-type-k',
    KV_CACHE_TYPE,
    '--cache-type-v',
    KV_CACHE_TYPE,
    '--parallel',
    '1',
    '--jinja',
    '--no-webui',
    ...chatTemplateArgs(spec.thinking),
  ];
}

/**
 * Whether the model thinks before it answers, as the engine's own switch.
 *
 * `--chat-template-kwargs` is passed through to the model's Jinja template, and
 * Qwen3.5's template is where `enable_thinking` is read. Only sent when it is
 * being turned *off*: the template's own default is to think, so sending `true`
 * would be saying what is already true — and one fewer argument is one fewer
 * thing to go wrong against an engine built by somebody else.
 *
 * This is worth having verified rather than assumed, because it is not universal:
 * a template can ignore the flag entirely and force thinking on, which reads as
 * "thinking is off" while every turn pays for it. Qwen3.5's honours it — checked
 * on the pinned build, where the reply carried no `reasoning_content` and the
 * thought stream arrived as one when the flag was flipped the other way.
 */
function chatTemplateArgs(thinking: boolean): string[] {
  return thinking
    ? []
    : ['--chat-template-kwargs', '{"enable_thinking":false}'];
}

/**
 * The id the recall engine answers to, as `--alias` and as the request's `model`.
 *
 * The same constant on both sides of the wire, for the reason `LOCAL_MODEL_ID`
 * is: the file name has a quantization in it, and a request that named the file
 * would be a second place the quantization is written down.
 */
export const EMBEDDING_ALIAS = 'embeddinggemma-2';

/**
 * Everything a recall input is given, in tokens.
 *
 * Not a tuning knob but the boundary that makes a media request possible at all:
 * llama.cpp's physical batch defaults to 512, and an input larger than it is
 * refused with a 500 rather than truncated. Measured, on the pinned build: a
 * two-second video is 669 tokens and failed at the default, and the largest
 * input this app will ever send — a 120-second WAV, at about 27 tokens per
 * second — is around 3,000. Two thousand and forty-eight was tried first and is
 * not enough for that WAV, which is why this is a measured number and not a
 * round one.
 */
const EMBEDDING_BATCH = 4096;

/**
 * The command line for the recall model.
 *
 * A second function rather than a branch inside `engineArgs`, because the two
 * servers have almost nothing in common: this one applies no chat template, has
 * no thoughts to switch off, keeps no KV cache worth quantizing, and must *not*
 * be pinned to the GPU. Every flag that is absent here is absent on purpose:
 *
 * - No `--jinja`. There is no template and no tool call; the input is text the
 *   caller assembled, and `--jinja` on an embedding server would be a flag that
 *   does nothing while looking load-bearing.
 * - No `--flash-attn` and no quantized cache. Those exist to make a long chat
 *   context affordable. An embedding input is one pass over at most 8K tokens.
 * - **`--n-gpu-layers 0`**: the recall engine runs on the processor. Two
 *   reasons, and the second is the one that is easy to miss. `plan.ts` decides
 *   the chat tier by assuming the engine may use *all* the free device memory,
 *   and a second client holding a slice of it would make that estimate a lie. And
 *   this model's card warns that its activations exceed float16's range and
 *   return NaN in it, while the CPU backend accumulates in f32 — so the slower
 *   path is also the one that does not need the model card's warning.
 * - No `--no-webui` omission: there is still no browser to serve.
 *
 * `--batch-size` and `--ubatch-size` are both set, and setting only the second
 * would be wrong: llama.cpp clamps `n_batch` down to `n_ubatch` with a warning,
 * so an install that raised one and not the other would silently lose the batching
 * that makes indexing a folder quick.
 */
export function embeddingArgs(spec: EmbeddingSpec): string[] {
  return [
    '--model',
    spec.model,
    ...(spec.projector === undefined
      ? []
      : ['--mmproj', spec.projector]),
    '--alias',
    EMBEDDING_ALIAS,
    '--host',
    '127.0.0.1',
    '--port',
    String(spec.port),
    '--ctx-size',
    String(spec.contextSize),
    '--n-gpu-layers',
    '0',
    '--embeddings',
    '--pooling',
    spec.pooling,
    '--parallel',
    '1',
    '--batch-size',
    String(EMBEDDING_BATCH),
    '--ubatch-size',
    String(EMBEDDING_BATCH),
    '--no-webui',
  ];
}

export interface EmbeddingSpec {
  /** The `llama-server` binary. */
  engine: string;
  /** The text backbone's GGUF. */
  model: string;
  /**
   * The vision and audio projector, when this install has one.
   *
   * Absent is not "text preferred": without it the engine has no image encoder
   * in the process, and a picture cannot be embedded at all.
   */
  projector?: string;
  port: number | string;
  contextSize: number;
  pooling: EmbeddingPooling;
}
