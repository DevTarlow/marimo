/**
 * What a memory write should say about the search index.
 *
 * Memory is stored the moment `update_memory` returns, and it is *searchable*
 * only once the recall index has embedded it again — which happens during a
 * search, because that is the only thing that knows memory changed. So there is
 * always a window where the file and its vectors disagree, and the agent is the
 * only party who can act on that: it is holding a turn that may want to search
 * for the fact it just wrote.
 *
 * Two rules shape the wording.
 *
 * **It is only said when it is news.** A memory with nothing in the index, or one
 * whose bullets have moved since they were embedded, is worth a sentence. A
 * memory that is current gets nothing, which is the common case after a search
 * and the reason this is a note rather than a line on every write.
 *
 * **It is a fact, not an instruction.** The model is told what is true and left
 * to decide: there is no "call recall first" here, because a prompt line telling
 * a small model what to do next is the first thing it loses. The one deliberate
 * exception is the sentence pointing at the file itself, and that exists because
 * the alternative is the model concluding its write vanished.
 *
 * Sibling of `size.ts`, and reported in the same register: both are appended to
 * a tool result that already succeeded, and neither is an error.
 */

/**
 * Whether the memory vectors describe the memory file as it is now.
 *
 * Declared here rather than imported from the package that produces it, because
 * `@marimo/agent` sits below the runtime: what crosses that seam is a shape,
 * which is the same rule `RecallHit` follows on the tool side. It lives beside
 * the note that renders it because the three states are exactly what the
 * sentences need, and a boolean would leave a caller unable to tell "nothing has
 * been indexed" from "memory was indexed and has moved since".
 */
export interface MemoryIndexState {
  /** Memory vectors in the index. */
  vectors: number;
  /** Whether an index exists at all. */
  index: boolean;
  /** Whether the file has changed since its bullets were embedded. */
  behind: boolean;
}

export interface MemoryIndexNoteOptions {
  /**
   * The index as it stands *after* the write, so `behind` is known rather than
   * guessed.
   */
  state: MemoryIndexState;
  /** Bullets in the file, so a note can avoid claiming an empty memory is lost. */
  bullets: number;
}

/**
 * The note for a memory write, or `''` when there is nothing worth saying.
 *
 * `bullets` is the file's own count rather than the index's: a caller that just
 * wrote the first line into an empty memory has one bullet and nothing indexed,
 * and telling it the write is not searchable yet is useful. A caller whose memory
 * has no bullets at all has nothing to be behind about.
 */
export function memoryIndexNote(options: MemoryIndexNoteOptions): string {
  const {state, bullets} = options;
  if (bullets === 0) {
    return '';
  }
  if (!state.index) {
    return (
      '[These bullets are not in the search index yet, so a `recall` with scope ' +
      '"memory" will not find them until the index has been built. The memory ' +
      'file itself is current, and every bullet in it is in your prompt on the ' +
      'next request.]'
    );
  }
  if (!state.behind) {
    return '';
  }
  return (
    `[The search index holds ${String(state.vectors)} memory bullet${
      state.vectors === 1 ? '' : 's'
    } from before this write, so a \`recall\` with scope "memory" may miss what ` +
    'you just added until the next search re-embeds memory. The file itself is ' +
    'current.]'
  );
}
