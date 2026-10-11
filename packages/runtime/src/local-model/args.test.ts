/**
 * The command line, asserted as data.
 *
 * This is where every mistake the built-in model can make at start-up actually
 * lives: a flag that is not what llama.cpp expects is a process that exits with
 * a usage message, and a missing `--jinja` is worse — the engine runs perfectly
 * and the agent is offered no tools at all, because the model's chat template is
 * the only thing that turns a `<tool_call>` block into a call this app can see.
 * Neither is visible from a test that starts a real server, and one of them
 * cannot be seen from the window at all.
 */
import {LOCAL_MODEL_ID} from '@marimo/protocol';
import {describe, expect, it} from 'vitest';

import {defaultGpuLayers, engineArgs} from './args.js';

function args(overrides: Partial<Parameters<typeof engineArgs>[0]> = {}) {
  return engineArgs({
    engine: '/opt/model/engine/llama-server',
    model: '/opt/model/Qwen3-1.7B-Q4_K_M.gguf',
    port: 8137,
    contextSize: 8192,
    thinking: false,
    platform: 'linux',
    ...overrides,
  });
}

describe('engineArgs', () => {
  it('is the whole command line, in the order the engine documents', () => {
    expect(args()).toEqual([
      '--model',
      '/opt/model/Qwen3-1.7B-Q4_K_M.gguf',
      '--alias',
      LOCAL_MODEL_ID,
      '--host',
      '127.0.0.1',
      '--port',
      '8137',
      '--ctx-size',
      '8192',
      '--n-gpu-layers',
      '0',
      '--parallel',
      '1',
      '--jinja',
      '--no-webui',
      '--chat-template-kwargs',
      '{"enable_thinking":false}',
    ]);
  });

  /*
   * The one flag the whole feature depends on, named by its own test so that
   * deleting it fails here rather than in a conversation where the agent
   * cheerfully refuses to use any of its tools.
   */
  it('always asks the engine to apply the model template', () => {
    expect(args({thinking: true})).toContain('--jinja');
  });

  it('binds to loopback and never to a network address', () => {
    const argv = args();
    expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
  });

  it('names the model with the app’s own id, not the file', () => {
    const argv = args();
    expect(argv[argv.indexOf('--alias') + 1]).toBe('qwen3-1.7b');
    expect(argv[argv.indexOf('--alias') + 1]).not.toContain('.gguf');
  });

  it('runs one request at a time, like the app does', () => {
    const argv = args();
    expect(argv[argv.indexOf('--parallel') + 1]).toBe('1');
  });

  /*
   * Thinking is off unless asked for, and the switch is *absent* when it is off
   * rather than sent as `true`. The template's own default is to think, so
   * turning it on is done by saying nothing — one fewer argument to disagree
   * about against an engine built by somebody else.
   */
  it('only passes the thinking switch when it is being turned off', () => {
    expect(args({thinking: false})).toContain('--chat-template-kwargs');
    expect(args({thinking: true})).not.toContain('--chat-template-kwargs');
  });

  it('carries the context window the user chose', () => {
    const argv = args({contextSize: 32768});
    expect(argv[argv.indexOf('--ctx-size') + 1]).toBe('32768');
  });

  /*
   * The port is a string in the status card before anything is running, because
   * `--port <port>` is a truer thing to show a user than a zero that looks like
   * an answer.
   */
  it('prints a placeholder port when there is not one yet', () => {
    expect(args({port: '<port>'})[args().indexOf('--port') + 1]).toBe('<port>');
  });
});

describe('defaultGpuLayers', () => {
  /*
   * Not a preference: a fact about which binary was unpacked. macOS ships the
   * Metal build, and the Linux and Windows ones are the plain CPU builds — so
   * the number follows the platform, and somebody with a GPU on Linux points the
   * "Local" provider at a server of their own instead of setting a number they
   * would have to know their hardware to choose.
   */
  it('offloads everything where the shipped engine has a GPU backend', () => {
    expect(defaultGpuLayers('darwin')).toBe(99);
  });

  it('offloads nothing on the CPU builds', () => {
    expect(defaultGpuLayers('linux')).toBe(0);
    expect(defaultGpuLayers('win32')).toBe(0);
  });
});
