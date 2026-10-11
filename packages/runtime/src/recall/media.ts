/**
 * Which files are media, and when a video's frames are taken.
 *
 * Two small decisions, and both belong in this package rather than in the window
 * that does the decoding, for the reason `prefixes.ts` gives about its own rules:
 * they are facts about what the *model* was trained with, not about Electron. The
 * indexer has to find the same files the decoder is asked to open, and the
 * decoder has to take the frames the guide specifies — if either lived only in
 * `apps/desktop`, the two would be free to drift, and the symptom would be a
 * video that indexes one frame instead of twelve.
 *
 * **Six extensions per kind.** Not every extension that exists — the ones a
 * decoder on every platform this app ships can actually open, which is the
 * honest bound. A file outside the table is text as far as the indexer is
 * concerned, which means it is read as UTF-8 and refused for its NUL bytes, and
 * nothing about the result says the real problem was an unsupported container.
 * So the table is deliberately the intersection rather than a wish list.
 *
 * **One frame per second, capped.** The model's guide samples video at one frame
 * per second. The cap is this app's addition: a forty-minute recording at one
 * frame a second is two thousand frames and an embedding request measured in
 * minutes, and the guide's own examples are clips. `frameTimes` spreads the cap
 * evenly over the clip instead of taking the first N seconds, because a clip's
 * last minute is as likely to hold the answer as its first.
 */
import {extname} from 'node:path';

export type MediaKind = 'image' | 'audio' | 'video';

/**
 * The extensions each kind is discovered by, with the leading dot.
 *
 * Lower-case, because `mediaKindOf` lower-cases the extension it is handed rather
 * than carrying both cases here.
 */
export const MEDIA_EXTENSIONS: Record<MediaKind, readonly string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  audio: ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'],
  video: ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'],
};

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'audio', 'video'];

/**
 * The largest media file worth opening, in bytes.
 *
 * A bound rather than a target, and it exists because the decoder reads the file
 * into the window: sixty-four megabytes is a long song, a several-minute clip and
 * any photograph, and past it the answer is not "a bigger ceiling" but "this file
 * was not meant to be indexed by a feature that samples it at a frame a second".
 */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/**
 * Which kind a path is, or `undefined` when it is not media.
 *
 * `extname` rather than a pattern over the whole string: a directory named
 * `notes.mp4` holding a `.ts` file must not make that file media, and a regex
 * that does not anchor to the basename gets exactly that wrong.
 */
export function mediaKindOf(path: string): MediaKind | undefined {
  const extension = extname(path).toLowerCase();
  if (extension.length === 0) {
    return undefined;
  }
  for (const kind of MEDIA_KINDS) {
    if (MEDIA_EXTENSIONS[kind].includes(extension)) {
      return kind;
    }
  }
  return undefined;
}

/**
 * The times to take a frame from, in seconds.
 *
 * One per second by default, and never at or past the end of the clip. When the
 * clip is long enough that one a second would exceed the cap, `cap` times are
 * spread evenly across the whole clip instead — a forty-minute recording sampled
 * at one frame a second is two thousand frames and a request measured in
 * minutes, and taking the first `cap` seconds would embed the title card and
 * nothing the question was about.
 *
 * A duration of zero or less is no frames: there is nothing to look at, and one
 * frame at time 0 from a file whose metadata says nothing would be a black
 * rectangle embedded as the whole clip.
 */
export function frameTimes(
  durationSeconds: number,
  cap: number,
  fps = 1,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [];
  }
  if (!Number.isFinite(cap) || cap < 1 || !Number.isFinite(fps) || fps <= 0) {
    return [];
  }

  const interval = 1 / fps;
  /*
   * How many marks at one per interval fall strictly inside the clip. A
   * half-second clip is one frame at the start, not zero because a whole second
   * never fits.
   */
  const marks = Math.max(1, Math.ceil(durationSeconds / interval));
  const count = Math.min(cap, marks);
  const spread = marks <= cap;

  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    // Rounded to microseconds so a test comparing floats is comparing the rule
    // rather than the representation of 1/3.
    const at = spread
      ? interval * index
      : (durationSeconds / (count + 1)) * (index + 1);
    times.push(Number(at.toFixed(6)));
  }
  return times;
}
