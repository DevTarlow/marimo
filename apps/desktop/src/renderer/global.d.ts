import type {AgentBridge} from '@marimo/protocol';

declare global {
  interface Window {
    /**
     * The preload bridge, and the renderer's only way to reach the machine.
     *
     * Declared here rather than imported so the renderer can be type-checked
     * without pretending it can import a CommonJS preload. It is the same
     * `AgentBridge` the preload implements, from the same module, so the two
     * cannot describe different things.
     */
    marimo: AgentBridge;
  }
}

export {};
