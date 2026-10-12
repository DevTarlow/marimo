/**
 * Turning attached files into the message the agent reads.
 *
 * What travels is the file's *path*, never its contents. The agent has its own
 * reader for that: `read_file` is confined to the conversation's folder, caps
 * what it returns and says so when it truncated, and is gated by the same rules
 * as every other file the agent touches. Inlining the bytes here instead would
 * be a second reader to keep in step with that one, a transcript showing a
 * twenty-kilobyte message the user only meant to hand over, and — worst of the
 * three — a stored message whose text was not what the model was sent.
 *
 * So the paths are spelled out in the message, relative to the folder the agent
 * works in, because a relative path is what its tools already describe
 * themselves in terms of and what does not put the user's home directory into
 * every conversation that ever mentioned a file.
 */
import {ATTACHED_FILES_HEADING} from '@marimo/protocol';
import type {PickedFile, SkippedFile} from '@marimo/protocol';

/**
 * The line the paths sit under.
 *
 * Written out rather than left as a bare list: a message that is only file names
 * reads as a question about them, and the agent has no way to tell whether the
 * user wants them read, edited or ignored. This says what they are.
 *
 * The string itself lives in the protocol, because the runtime reads this block
 * back out of the message to tell the model what was attached — two literals
 * would be a block that stops being recognised the day one of them is reworded.
 */
export const ATTACHED_HEADING = ATTACHED_FILES_HEADING;

/**
 * The message to send: what was typed, then what was attached.
 *
 * A message with nothing typed but files attached is a real message — "look at
 * this" is what it means — so the heading stands alone rather than the send
 * being refused. The order is the order they were thought in: the question
 * first, the material after it.
 */
export function composeMessage(
  text: string,
  files: readonly PickedFile[],
): string {
  const body = text.trim();
  if (files.length === 0) {
    return body;
  }
  const list = files.map((file) => `- ${file.relative}`).join('\n');
  return body.length === 0
    ? `${ATTACHED_HEADING}\n${list}`
    : `${body}\n\n${ATTACHED_HEADING}\n${list}`;
}

/**
 * What to say about files the picker refused, in one line.
 *
 * One line because it is drawn in the composer's hint slot, which is a single
 * row: the reasons are sentences from the main process, and the row ellipsises
 * rather than wrapping the layout. The first reason is the readable one, and a
 * second file refused for the same cause reads as the same explanation twice —
 * which is why the names are joined rather than each reason repeated.
 */
export function describeSkipped(skipped: readonly SkippedFile[]): string | null {
  if (skipped.length === 0) {
    return null;
  }
  return skipped.map((file) => `${file.name}: ${file.reason}`).join(' ');
}
