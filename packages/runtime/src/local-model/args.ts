/**
 * The command line the app hands the engine, as data.
 *
 * A function that returns an array rather than a `spawn` call with the flags
 * inline, for the reason `service/plan.ts` is split the same way: every mistake
 * worth catching is in the *content* of what gets run, and a test can assert on
 * an array in a millisecond where starting a 1.1 GB model takes seconds and a
 * machine. The one caller that spawns is tested with a fake.
 */
import {MODEL_ALIAS} from './files.js';

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
  platform?: NodeJS.Platform;
}

/**
 * How many layers to offload to the GPU.
 *
 * All of them where the engine that ships has a GPU backend, and none where it
 * does not. This is not a preference with a good default — it is a fact about
 * which binary was unpacked: the macOS build is Metal, and the Linux and Windows
 * ones are the plain CPU builds. A number the user had to set would be a number
 * they had to know their own hardware to set, so the only place it is decided is
 * here, and somebody with a GPU who wants more can point the "Local" provider at
 * a server of their own — the path that already exists.
 */
export function defaultGpuLayers(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === 'darwin' ? 99 : 0;
}

/**
 * The whole argv, in the order the engine documents it.
 *
 * The flags that matter, and why each is here rather than being left to a
 * default:
 *
 * - `--jinja` is load-bearing. Without it llama.cpp does not apply the model's
 *   own chat template, and Qwen3's template is the only thing that turns a
 *   `<tool_call>` block in the output into a tool call this app can see. Without
 *   it the agent has no tools at all — every request succeeds and nothing is
 *   ever called, which is the failure that looks like a model that is merely
 *   unhelpful.
 * - `--alias` names the model so the id in a request is the app's own
 *   (`qwen3-1.7b`) rather than a path with a quantization in it.
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
    MODEL_ALIAS,
    '--host',
    '127.0.0.1',
    '--port',
    String(spec.port),
    '--ctx-size',
    String(spec.contextSize),
    '--n-gpu-layers',
    String(defaultGpuLayers(spec.platform ?? process.platform)),
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
 * Qwen3's template is where `enable_thinking` is read. Only sent when it is being
 * turned *off*: the template's own default is to think, so sending `true` would
 * be saying what is already true — and one fewer argument is one fewer thing to
 * go wrong against an engine built by somebody else.
 */
function chatTemplateArgs(thinking: boolean): string[] {
  return thinking
    ? []
    : ['--chat-template-kwargs', '{"enable_thinking":false}'];
}
