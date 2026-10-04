/**
 * Preload bridge.
 *
 * A sandboxed preload must be CommonJS and cannot `require` an ESM package, so
 * this file imports types only (`import type` is erased at emit) and repeats the
 * two channel names as literals. `apps/desktop/tests/preload-channels.test.ts`
 * asserts those literals still match the protocol, which is what stops the
 * duplication from drifting into a bridge that listens on a channel nobody sends
 * to.
 *
 * Nothing else is exposed: no filesystem, no shell, no broad IPC. `window.marimo`
 * is the whole of the renderer's reach, and every call through it is validated
 * by the main process before a handler sees it.
 */
import {contextBridge, ipcRenderer} from 'electron';

import type {
  AgentBridge,
  AgentCallMethod,
  AgentCallParams,
  AgentCallResults,
  AgentUiEvent,
} from '@marimo/protocol';

const CALL_CHANNEL = 'marimo:call';
const EVENT_CHANNEL = 'marimo:event';

const bridge: AgentBridge = {
  call<M extends AgentCallMethod>(
    method: M,
    params: AgentCallParams<M>,
  ): Promise<AgentCallResults[M]> {
    return ipcRenderer.invoke(CALL_CHANNEL, method, params) as Promise<
      AgentCallResults[M]
    >;
  },
  onEvent(listener: (event: AgentUiEvent) => void): () => void {
    const handler = (_event: unknown, payload: AgentUiEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.off(EVENT_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld('marimo', bridge);
