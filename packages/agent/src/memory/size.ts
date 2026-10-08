/**
 * How full memory is allowed to get before somebody says so.
 *
 * `MAX_MEMORY_BYTES` is the hard cap: a write over it throws and the tool turns
 * that into a message. Between "fine" and "the write failed" there was nothing,
 * and that is the whole problem — memory is injected into every future system
 * prompt, so by the time the cap is what stops you, every turn has been carrying
 * the noise for a while. A soft limit is the warning that arrives while there is
 * still room to act on it.
 *
 * 8 KiB, and the number is a judgement rather than a measurement. It is roughly
 * 100 durable bullets, which is more real facts than a year of use tends to
 * produce and far more than a model reads attentively. It is an eighth of the
 * hard cap, so crossing it leaves room to fix the file by hand; and at roughly
 * 2k tokens it is a rounding error next to the conversation in the same request,
 * so crossing it is worth a sentence and not worth a rewrite.
 *
 * The warning is advisory on purpose. A memory just over the line is still
 * working memory — refusing writes at 8 KiB would turn a suggestion into the
 * same hard wall the cap already is, this time one nobody agreed to.
 */

/** The size, in bytes, past which memory is worth pruning. */
export const MEMORY_SOFT_LIMIT_BYTES = 8 * 1024;

/**
 * The sentence to add to a tool result when memory is over the soft limit.
 *
 * Empty below the limit, so a caller can concatenate it unconditionally. It
 * names a byte count and a percentage because "getting full" is not something a
 * model can act on and "10,240 bytes, 125% of the 8,192-byte target" is.
 */
export function memorySizeWarning(
  bytes: number,
  softLimit: number = MEMORY_SOFT_LIMIT_BYTES,
): string {
  if (bytes <= softLimit) {
    return '';
  }
  const percent = Math.round((bytes / softLimit) * 100);
  return (
    `memory.md is ${String(bytes)} bytes, over the ${String(softLimit)}-byte ` +
    `soft limit (${String(percent)}%). Consider prune_memory with a ` +
    'deduplicated rewrite: drop what is outdated, merge repeats, and keep ' +
    'every fact that still matters.'
  );
}
