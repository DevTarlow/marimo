/**
 * Turning a media file into what the embedding client can send.
 *
 * The engine takes an image as a data URL, audio as samples, and video as a
 * handful of still frames, and none of those is a file. Getting from one to the
 * other is this file: a read and a base64 for an image, a hidden renderer for
 * everything that needs a decoder.
 *
 * Isolation, and it is the same shape as `search-window.ts`: a non-persistent
 * session partition (nothing survives the window, nothing is shared with the
 * app's own session), sandbox on, no preload, no node integration, permissions
 * denied, navigation and `window.open` denied, and the window destroyed in
 * `finally` so a timeout, a crash or a quit cannot leave a stray renderer
 * holding a video decoder. Decodes are serialized for the same reason searches
 * are: one hidden window at a time is a promise this class can keep, and two is
 * a memory spike nobody asked for.
 *
 * **Video goes through a custom scheme, not a `file://` URL.** A page cannot
 * read the filesystem, and it should not be able to: the alternative is a
 * preload or reduced web security, either of which hands the renderer more than
 * a decoder needs. So the main process serves the one file it has allowed, over
 * `marimo-media://`, and refuses everything else — see `permitted` for why that
 * set is the security boundary rather than a bookkeeping detail.
 *
 * **Audio is resampled in the page, and the numbers are not preferences.**
 * 16 kHz mono is what the model's guide was trained with, so a 44.1 kHz stereo
 * file embedded as-is is a shape the model has never been shown. And the
 * resample has to happen wherever `decodeAudioData` lives — the renderer — so
 * the bytes cross to the page even though the file does not.
 */
import {open, readFile} from 'node:fs/promises';
import {basename, extname} from 'node:path';

import {BrowserWindow, protocol, session as electronSession} from 'electron';

import {frameTimes} from '@marimo/runtime';
import type {MediaKind} from '@marimo/runtime';

/** The scheme the decode page loads a video from; see `registerMediaScheme`. */
export const MEDIA_SCHEME = 'marimo-media';

/**
 * The session the decode window lives in. Non-persistent, and separate from the
 * app's own session, so a decoder and the protocol handler that feeds it share
 * nothing with the window the user is looking at.
 */
const PARTITION = 'marimo-media';

const DEFAULT_MAX_FRAMES = 24;
const DEFAULT_FPS = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

/** The rate the model's guide was trained at, so it is a rule and not a knob. */
const SAMPLE_RATE = 16_000;

export interface DecodedImage {
  kind: 'image';
  mime: string;
  base64: string;
}
/** Mono, 16 kHz — the only shape the engine accepts audio in. */
export interface DecodedAudio {
  kind: 'audio';
  sampleRate: 16000;
  samples: Float32Array;
}
/** Base64 PNGs, no `data:` prefix, in the order the frames were taken. */
export interface DecodedVideo {
  kind: 'video';
  frames: string[];
}
export type DecodedMedia = DecodedImage | DecodedAudio | DecodedVideo;

export interface MediaDecodingWindowOptions {
  /** The most video frames one clip contributes. Default 24. */
  maxFrames?: number;
  /** Frames per second. Default 1 — the model's guide's own rule. */
  fps?: number;
  /** Whole-operation deadline. Default 120_000. */
  timeoutMs?: number;
}

/**
 * The content type of each image extension, because the engine is handed a
 * `data:` URL and a data URL's type is part of what it is.
 *
 * The value type admits `undefined`: the honest answer for an extension this
 * table does not hold is that there is none, and a `Record<string, string>`
 * types that lookup as a plain `string` — an `=== undefined` check the compiler
 * believes is dead and a fallback that can never run.
 */
export const IMAGE_MIME_TYPES: Readonly<Record<string, string | undefined>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * The content type the protocol handler serves each video extension with.
 *
 * It has to be right: Chromium picks its demuxer from this header, so an MP4
 * answered as `application/octet-stream` is a video the page cannot load and an
 * error that says nothing about why.
 */
export const VIDEO_MIME_TYPES: Readonly<Record<string, string | undefined>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
};

/** The content type to serve a video path with, or undefined when unknown. */
export function videoMimeType(path: string): string | undefined {
  return VIDEO_MIME_TYPES[extname(path).toLowerCase()];
}

/**
 * Registers the scheme, and **must be called before Electron's `app` is ready**.
 *
 * Electron reads a scheme's privileges once, when it builds the URL request
 * job factory inside the ready sequence; a call after that is a warning nobody
 * reads and a scheme that stays non-standard. `main.ts` calls it at boot, and
 * nothing here calls it at import time — a module that registers a process-wide
 * scheme as a side effect of being imported is a scheme registered by whichever
 * test or tool happened to import it first.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        /*
         * `stream` is the one that matters for video: without it Chromium's
         * media elements buffer a custom scheme's whole response before they
         * will look at it, and a buffered response has no byte ranges to seek
         * in, so `seeked` never arrives for any frame but the first.
         */
        stream: true,
        standard: true,
        secure: true,
        /*
         * The decode page is not this scheme's origin, so the load is
         * cross-origin and CORS is what decides whether it is allowed — and
         * whether the canvas it is drawn into stays untainted. Turning it off
         * does not make the request simpler, it makes it refusable.
         */
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * The URL the decode page loads `path` from.
 *
 * The path is a single percent-encoded segment rather than a series of path
 * segments, because it is absolute: `encodeURIComponent` encodes the `/` that
 * would otherwise turn the user's directory names into path structure, and it
 * keeps a `?` or a `#` in a file name from ending the path early — which is how
 * a video called `take 1 #2.mp4` becomes a request for `take 1`. The authority
 * is a constant, and it is only there so the URL has an origin for CORS to
 * reason about; the segment below it is the entire encoded path.
 */
export function mediaUrl(path: string): string {
  return `${MEDIA_SCHEME}://media/${encodeURIComponent(path)}`;
}

/**
 * The path a `marimo-media://` URL names, or undefined for a URL this app never
 * writes.
 *
 * A parser that can name any file on the disk is not the hazard people take it
 * for. What makes it safe is that naming a file and being served it are
 * different questions, and the answer to the second is the allowlist below.
 */
export function mediaPathFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== 'media') {
    return undefined;
  }
  /*
   * `media` is the URL's authority, so it is already gone from `pathname` — the
   * path is `/<encoded>`, one segment and a leading slash. Slicing the length
   * of `/media/` off it instead cuts seven characters out of the encoded path,
   * which is a 403 for every file rather than a hint that anything is wrong.
   */
  const encoded = parsed.pathname.replace(/^\//, '');
  if (encoded.length === 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/**
 * The paths the one registered handler may serve, for the decode running now.
 *
 * Module-level because Electron refuses a second handler on the same scheme, so
 * a second `MediaDecodingWindow` cannot have a handler of its own and the set
 * has to be shared with the one that exists. The class is the only writer, it
 * holds at most one path (decodes are serialized) and it removes it in
 * `finally`, so an empty set means nothing is being decoded.
 *
 * It is also the whole of the security story: a handler that answers with
 * whatever path a page names is a file-read primitive handed to a renderer, and
 * "the renderer is ours" is exactly the assumption that stops being true the
 * first time a decoder has a bug.
 */
const permitted = new Set<string>();
let handlerInstalled = false;

/** Gives the partition session a handler for the scheme, once. */
function installMediaHandler(): void {
  if (handlerInstalled) {
    return;
  }
  handlerInstalled = true;
  const mediaSession = electronSession.fromPartition(PARTITION);
  mediaSession.protocol.handle(MEDIA_SCHEME, (request) =>
    serveMediaRequest(request),
  );
}

async function serveMediaRequest(request: Request): Promise<Response> {
  const target = mediaPathFromUrl(request.url);
  if (target === undefined || !permitted.has(target)) {
    return refuse(403, 'That file was not opened for decoding.');
  }
  const mime = videoMimeType(target);
  if (mime === undefined) {
    return refuse(415, 'That file is not a video this app can serve.');
  }

  let handle;
  try {
    handle = await open(target, 'r');
  } catch {
    // The file was allowed a moment ago. It can still be gone: a decode is
    // allowed to race a user who moved the folder, and that is a 404 rather
    // than an exception in the protocol handler.
    return refuse(404, 'That file is no longer there.');
  }

  try {
    const size = (await handle.stat()).size;
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {'content-range': `bytes */${String(size)}`},
      });
    }
    const start = range === undefined ? 0 : range.start;
    const end = range === undefined ? size - 1 : range.end;
    const length = size === 0 ? 0 : end - start + 1;
    const body = Buffer.allocUnsafe(length);
    if (length > 0) {
      await handle.read(body, 0, length, start);
    }
    return new Response(length === 0 ? null : body, {
      status: range === undefined ? 200 : 206,
      headers: {
        'content-type': mime,
        /*
         * Without this the media stack does not know it may ask for a slice, so
         * it reads the whole file once and every seek is a re-read from the
         * start — or, worse, a seek that never completes.
         */
        'accept-ranges': 'bytes',
        'content-length': String(length),
        ...(range === undefined
          ? {}
          : {'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`}),
        // The page is a different origin from this scheme, and the header is
        // what lets it draw the frames instead of tainting the canvas — a
        // tainted canvas throws on `toDataURL`, after every frame was decoded.
        'access-control-allow-origin': '*',
      },
    });
  } finally {
    await handle.close();
  }
}

/** The bytes a `Range` header asks for, inclusive at both ends. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The slice a `Range` header asks for, `'unsatisfiable'` when it asks for one
 * past the end, or undefined when there is no range to honour.
 *
 * Only a single range is parsed. A multi-range request is answered by ignoring
 * the header and sending the whole file, which is a legal answer to a range
 * request; a `multipart/byteranges` body is the one Chromium's media stack then
 * has to demux as if it were a video.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  if (header === null || size === 0) {
    return header === null ? undefined : 'unsatisfiable';
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return undefined;
  }
  const from = match[1] ?? '';
  const to = match[2] ?? '';
  if (from === '' && to === '') {
    return undefined;
  }
  if (from === '') {
    // `bytes=-N` is the last N bytes, which is how a container's footer is read.
    const wanted = Number(to);
    if (wanted === 0) {
      return 'unsatisfiable';
    }
    return {start: Math.max(0, size - wanted), end: size - 1};
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) {
    return 'unsatisfiable';
  }
  return {start, end};
}

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {'content-type': 'text/plain; charset=utf-8'},
  });
}

export class MediaDecodingWindow {
  private readonly maxFrames: number;
  private readonly fps: number;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private active: BrowserWindow | undefined;
  private disposed = false;

  constructor(options: MediaDecodingWindowOptions = {}) {
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.fps = options.fps ?? DEFAULT_FPS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  decode(path: string, kind: MediaKind): Promise<DecodedMedia> {
    const run = this.queue.then(
      () => this.run(path, kind),
      () => this.run(path, kind),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Destroys any live decode window and refuses further decodes. */
  dispose(): void {
    this.disposed = true;
    const window = this.active;
    this.active = undefined;
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
  }

  private async run(path: string, kind: MediaKind): Promise<DecodedMedia> {
    if (this.disposed) {
      throw new Error('media decoding is shutting down');
    }
    installMediaHandler();

    /*
     * An image needs no window and no deadline: it is bytes the engine takes as
     * a data URL, so reading it here is the whole decode. Opening a renderer to
     * base64-encode a PNG would add a process, a window and a way to hang to a
     * step that has none of them.
     */
    if (kind === 'image') {
      return await readImage(path);
    }

    /*
     * The deadline covers the whole operation rather than one call inside it: a
     * clip that takes two minutes to produce its frames is a clip this app is
     * not going to index, whatever it is stuck on. The abort destroys the
     * window, which rejects whatever page call is outstanding.
     */
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      if (kind === 'audio') {
        return await this.decodeAudio(path, controller.signal);
      }
      return await this.decodeVideo(path, controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) {
        throw new Error(
          `Decoding ${basename(path)} took longer than ` +
            `${String(Math.round(this.timeoutMs / 1000))} seconds, so it was stopped.`,
        );
      }
      throw failure instanceof Error ? failure : new Error(String(failure));
    } finally {
      clearTimeout(timer);
    }
  }

  private async decodeAudio(
    path: string,
    signal: AbortSignal,
  ): Promise<DecodedAudio> {
    const bytes = await readBytes(path);
    /*
     * The bytes cross to the page because the decoder lives there — Web Audio
     * is the only decoder this app has for an MP3, and a native one would be a
     * second dependency per platform. Base64 rather than a number array: a
     * three-minute track is nearly three million samples, and JSON numbers
     * would spend tens of megabytes of IPC to say the same thing.
     */
    return await this.withWindow(signal, async (window) => {
      await window.loadURL('about:blank');
      const raw: unknown = await window.webContents.executeJavaScript(
        audioDecodeScript(bytes.toString('base64')),
        true,
      );
      return toDecodedAudio(raw);
    });
  }

  private async decodeVideo(
    path: string,
    signal: AbortSignal,
  ): Promise<DecodedVideo> {
    const source = mediaUrl(path);
    /*
     * Allowed for exactly as long as this decode runs, and cleared after the
     * window is gone rather than before: the grant outlives the last range
     * request Chromium makes, and the handler is left with an empty set.
     */
    permitted.add(path);
    try {
      return await this.withWindow(signal, async (window) => {
        await window.loadURL('about:blank');
        const metadata: unknown = await window.webContents.executeJavaScript(
          videoMetadataScript(source),
          true,
        );
        const duration = videoDuration(metadata);
        /*
         * The rule is applied here rather than in the page script so that the
         * one function with a test decides the sampling. The page is handed the
         * answer, which also means a bug in the arithmetic cannot become a page
         * that seeks forever.
         */
        const times = frameTimes(duration, this.maxFrames, this.fps);
        if (times.length === 0) {
          throw new Error(
            `The clip length (${String(duration)} seconds) leaves nothing to sample.`,
          );
        }
        const frames: unknown = await window.webContents.executeJavaScript(
          videoFramesScript(times),
          true,
        );
        return toDecodedVideo(frames);
      });
    } finally {
      permitted.delete(path);
    }
  }

  private async withWindow<T>(
    signal: AbortSignal,
    run: (window: BrowserWindow) => Promise<T>,
  ): Promise<T> {
    const window = new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        /*
         * A hidden window is a throttled one, and a throttled renderer is one
         * whose `seeked` arrives late or not at all — the decode would look like
         * a video that cannot be decoded rather than like a page Chromium put
         * to sleep.
         */
        backgroundThrottling: false,
      },
    });
    this.active = window;

    const destroy = (): void => {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    };
    const onAbort = (): void => destroy();
    signal.addEventListener('abort', onAbort, {once: true});
    hardenSession();

    try {
      /*
       * The page may load the one URL it is given and open nothing. It has no
       * links and no preload, but a decoder that redirects or calls
       * `window.open` would put a second document in a window meant to hold one.
       */
      window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      window.webContents.on('will-navigate', (event) => {
        event.preventDefault();
      });
      return await run(window);
    } finally {
      signal.removeEventListener('abort', onAbort);
      destroy();
      if (this.active === window) {
        this.active = undefined;
      }
    }
  }
}

let sessionHardened = false;

/** Denies every permission, once, on the partition the decoder runs in. */
function hardenSession(): void {
  if (sessionHardened) {
    return;
  }
  sessionHardened = true;
  electronSession
    .fromPartition(PARTITION)
    .setPermissionRequestHandler((_contents, _permission, callback) => {
      // Nothing this page does needs a camera, a microphone or a location, and
      // a decoder that asks for one is not the code this app wrote.
      callback(false);
    });
}

async function readImage(path: string): Promise<DecodedImage> {
  const mime = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
  if (mime === undefined) {
    throw new Error(`${basename(path)} is not an image this app can decode.`);
  }
  return {kind: 'image', mime, base64: (await readBytes(path)).toString('base64')};
}

async function readBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (failure) {
    throw new Error(`${basename(path)} could not be read: ${describe(failure)}`);
  }
}

/**
 * The duration a page reported for a video, as a number that can be sampled.
 *
 * A separate check because `<video>` reports `NaN` for a container whose
 * metadata it could not parse and `Infinity` for one it thinks never ends, and
 * `frameTimes` answers both with no frames — which arrives as "the video
 * produced no frames" rather than as a file this app cannot read.
 */
export function videoDuration(raw: unknown): number {
  const record = raw as {duration?: unknown} | null;
  const duration = record === null ? undefined : record.duration;
  if (
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      'The video does not report a length, so there is no way to sample it.',
    );
  }
  return duration;
}

/**
 * The page's audio result as the typed one.
 *
 * The samples come back base64-encoded bytes rather than a number array: they
 * are little-endian `Float32` on both sides of the boundary because it is the
 * same machine, and a `Buffer` is the cheap way across.
 */
export function toDecodedAudio(raw: unknown): DecodedAudio {
  const record = raw as {sampleRate?: unknown; base64?: unknown} | null;
  if (record === null || typeof record !== 'object') {
    throw new Error('The audio decoder answered with something that is not a result.');
  }
  if (record.sampleRate !== SAMPLE_RATE) {
    throw new Error(
      `The audio decoder answered at ${String(record.sampleRate)} Hz where ` +
        `${String(SAMPLE_RATE)} Hz is the only rate the model accepts.`,
    );
  }
  if (typeof record.base64 !== 'string') {
    throw new Error('The audio decoder answered with no samples.');
  }
  const bytes = Buffer.from(record.base64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    throw new Error(
      `The audio decoder answered with ${String(bytes.byteLength)} bytes, ` +
        'which is not a whole number of samples.',
    );
  }
  const samples = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return {kind: 'audio', sampleRate: SAMPLE_RATE, samples};
}

/**
 * The page's frames as the typed result.
 *
 * A clip with no frames is a failure rather than an empty result, for the same
 * reason a turn with no text is: the engine would be handed an input with
 * nothing in it, and what comes back is a vector that matches nothing while
 * looking exactly like an embedding.
 */
export function toDecodedVideo(raw: unknown): DecodedVideo {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('The video produced no frames, so there is nothing to embed.');
  }
  const frames = raw.map((frame) => {
    if (typeof frame !== 'string' || frame.length === 0) {
      throw new Error('The video produced a frame that is not an image.');
    }
    // `toDataURL` hands back `data:image/png;base64,…`; the client wants the
    // base64 alone, and a prefix left on would be sent as picture data.
    const comma = frame.indexOf(',');
    return frame.startsWith('data:') && comma !== -1
      ? frame.slice(comma + 1)
      : frame;
  });
  return {kind: 'video', frames};
}

/**
 * The page-side half of an audio decode.
 *
 * The resample happens in the page because the page is where the decoder is:
 * `decodeAudioData` lives on `BaseAudioContext`, so there is no main-process
 * way to turn an MP3 into samples without shipping a second decoder. Two
 * contexts rather than one because `decodeAudioData` resamples to *its own*
 * context's rate, and `startRendering` into a one-channel context is what
 * downmixes — so the first context is the resampler and the second is the
 * mixer, in that order, in one pass.
 */
export function audioDecodeScript(base64: string): string {
  return `(async () => {
  const binary = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(
    bytes.buffer,
  );
  const length = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, length, 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const raw = new Uint8Array(
    samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
  );
  let text = '';
  for (let at = 0; at < raw.length; at += 0x8000) {
    text += String.fromCharCode.apply(null, raw.subarray(at, at + 0x8000));
  }
  return {sampleRate: rendered.sampleRate, base64: btoa(text)};
})()`;
}

/**
 * The page-side half of a video decode: load it and report its length.
 *
 * Separate from the frames script rather than one long script, because the
 * sampling rule is decided in the main process between the two calls.
 *
 * `crossOrigin` is what keeps the canvas untainted — the response carries
 * `access-control-allow-origin: *` and this is the other half of that bargain.
 * Without it every frame decodes and `toDataURL` throws a `SecurityError`,
 * which reads as a decode failure at the last possible step.
 */
export function videoMetadataScript(source: string): string {
  return `(async () => {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.src = ${JSON.stringify(source)};
  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => {
      resolve();
    }, {once: true});
    video.addEventListener('error', () => {
      reject(new Error('the video could not be decoded'));
    }, {once: true});
  });
  window.__marimoDecodeVideo = video;
  return {duration: video.duration};
})()`;
}

/**
 * The page-side half of a video decode: seek and capture, once per time.
 *
 * `loadedmetadata` is not enough to draw from — the element knows the picture
 * size and not one pixel of it — so a seek to where the video already is
 * resolves only once `readyState` says a frame is there, and every other time
 * waits for `seeked`.
 */
export function videoFramesScript(times: readonly number[]): string {
  return `(async () => {
  const video = window.__marimoDecodeVideo;
  if (!video) {
    throw new Error('the video is no longer loaded');
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('this machine cannot draw video frames');
  }
  const frames = [];
  for (const time of ${JSON.stringify(times)}) {
    await new Promise((resolve, reject) => {
      const clean = () => {
        video.removeEventListener('seeked', settle);
        video.removeEventListener('error', failed);
      };
      const settle = () => {
        clean();
        resolve();
      };
      const failed = () => {
        clean();
        reject(new Error('the video stopped while seeking'));
      };
      // Seeking to where the video already is fires no event at all, so the
      // first time - always 0 - would hang here without this check.
      if (video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.001) {
        resolve();
        return;
      }
      video.addEventListener('seeked', settle, {once: true});
      video.addEventListener('error', failed, {once: true});
      video.currentTime = time;
    });
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    if (canvas.width === 0 || canvas.height === 0) {
      throw new Error('the video reports no picture size');
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL('image/png'));
  }
  return frames;
})()`;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
