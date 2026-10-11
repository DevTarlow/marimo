/**
 * The halves of the decode window that are pure.
 *
 * Nothing here constructs a `BrowserWindow`: a test that opens one is a test
 * that needs a display, a GPU and a decoder, and the answer it gives depends on
 * the machine it ran on. What is left is what the window is fed and what comes
 * back — the mime tables, the URL the page loads, the byte ranges `<video>`
 * asks for, and the page results turned into the typed ones. Those are where
 * the quiet failures are: a wrong content type is a video that will not load, a
 * wrong range is a seek that never finishes, and a page result taken on trust
 * is a frame that is not an image.
 */
import {describe, expect, it} from 'vitest';

import {
  IMAGE_MIME_TYPES,
  MEDIA_SCHEME,
  VIDEO_MIME_TYPES,
  audioDecodeScript,
  mediaPathFromUrl,
  mediaUrl,
  parseRange,
  toDecodedAudio,
  toDecodedVideo,
  videoDuration,
  videoFramesScript,
  videoMetadataScript,
  videoMimeType,
} from '../src/main/media/decode-window.js';
import {MEDIA_EXTENSIONS} from '@marimo/runtime';

describe('IMAGE_MIME_TYPES', () => {
  it('names a type for every image extension and nothing else', () => {
    // A discovered image with no type is a data URL the engine cannot read, and
    // the failure arrives as "the model refused the request".
    expect(Object.keys(IMAGE_MIME_TYPES).sort()).toEqual(
      [...MEDIA_EXTENSIONS.image].sort(),
    );
    for (const mime of Object.values(IMAGE_MIME_TYPES)) {
      expect(mime).toMatch(/^image\//);
    }
  });
});

describe('VIDEO_MIME_TYPES', () => {
  it('names a type for every video extension and nothing else', () => {
    expect(Object.keys(VIDEO_MIME_TYPES).sort()).toEqual(
      [...MEDIA_EXTENSIONS.video].sort(),
    );
    for (const mime of Object.values(VIDEO_MIME_TYPES)) {
      expect(mime).toMatch(/^video\//);
    }
  });

  it('does not claim to serve an image', () => {
    // The handler is offered whatever path is allowed, and an image must not be
    // answerable over the scheme that exists to feed `<video>`.
    expect(videoMimeType('/tmp/photo.png')).toBeUndefined();
  });

  it('answers from the extension, ignoring case', () => {
    expect(videoMimeType('/tmp/CLIP.MP4')).toBe('video/mp4');
    expect(videoMimeType('/tmp/screen.webm')).toBe('video/webm');
    expect(videoMimeType('/tmp/notes.txt')).toBeUndefined();
    expect(videoMimeType('/tmp/no-extension')).toBeUndefined();
  });
});

describe('mediaUrl', () => {
  it('survives URL parsing for names a person would type', () => {
    // The path is one percent-encoded segment. A `/` left raw would turn the
    // user's directories into path structure, and a `#` or `?` left raw would
    // end the path early — the request would be for `take 1`.
    for (const path of [
      '/tmp/clip.mp4',
      '/tmp/take 1 #2.mp4',
      '/tmp/naïve (1).mov',
      '/tmp/100%off.mkv',
      "/tmp/it's a video.webm",
      '/tmp/plus+and&amp.m4v',
    ]) {
      expect(mediaUrl(path)).toContain(MEDIA_SCHEME);
      expect(mediaUrl(path)).not.toContain(path);
      expect(mediaPathFromUrl(mediaUrl(path))).toBe(path);
    }
  });
});

describe('mediaPathFromUrl', () => {
  it('refuses anything that is not this scheme', () => {
    for (const url of [
      'https://media/%2Ftmp%2Fclip.mp4',
      'file:///tmp/clip.mp4',
      'marimo-media://other/%2Ftmp%2Fclip.mp4',
      'marimo-media://media/',
      'marimo-media://media',
      'not a url at all',
      'marimo-media://media/%2Ftmp%2F%ZZ',
    ]) {
      expect(mediaPathFromUrl(url)).toBeUndefined();
    }
  });
});

describe('parseRange', () => {
  it('reads an open-ended range as the rest of the file', () => {
    // `bytes=0-` is what Chromium opens with, and answering it with 200 and no
    // `content-range` is what makes every later seek a re-read.
    expect(parseRange('bytes=0-', 1000)).toEqual({start: 0, end: 999});
    expect(parseRange('bytes=500-', 1000)).toEqual({start: 500, end: 999});
  });

  it('reads a closed range and clamps an end past the file', () => {
    expect(parseRange('bytes=0-0', 1000)).toEqual({start: 0, end: 0});
    expect(parseRange('bytes=100-199', 1000)).toEqual({start: 100, end: 199});
    expect(parseRange('bytes=900-99999', 1000)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('reads a suffix range as the last bytes of the file', () => {
    // How a container's footer — the index an MP4 seeks by — is read.
    expect(parseRange('bytes=-100', 1000)).toEqual({start: 900, end: 999});
    expect(parseRange('bytes=-5000', 1000)).toEqual({start: 0, end: 999});
  });

  it('refuses a range that is not there', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=200-100', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('sends the whole file rather than a body Chromium must demux', () => {
    expect(parseRange(null, 1000)).toBeUndefined();
    expect(parseRange('bytes=0-9, 20-29', 1000)).toBeUndefined();
    expect(parseRange('items=0-9', 1000)).toBeUndefined();
    expect(parseRange('bytes=-', 1000)).toBeUndefined();
  });
});

describe('videoDuration', () => {
  it('takes the length the page reported', () => {
    expect(videoDuration({duration: 2.5})).toBe(2.5);
  });

  it('refuses a length that cannot be sampled', () => {
    // `<video>` answers `NaN` for a container it could not parse and
    // `Infinity` for a stream, and `frameTimes` would call both "no frames" —
    // an error about the sampling rather than about the file.
    for (const raw of [
      {duration: 0},
      {duration: -1},
      {duration: Number.NaN},
      {duration: Number.POSITIVE_INFINITY},
      {duration: '2'},
      {},
      null,
      'text',
    ]) {
      expect(() => videoDuration(raw)).toThrow(/length/);
    }
  });
});

describe('toDecodedAudio', () => {
  const samples = new Float32Array([0.5, -0.25, 1, 0]);
  const base64 = Buffer.from(samples.buffer).toString('base64');

  it('turns the page result into mono 16 kHz samples', () => {
    const decoded = toDecodedAudio({sampleRate: 16000, base64});
    expect(decoded.kind).toBe('audio');
    expect(decoded.sampleRate).toBe(16000);
    expect(Array.from(decoded.samples)).toEqual([0.5, -0.25, 1, 0]);
  });

  it('refuses a rate that is not the one the model was trained at', () => {
    // 44.1 kHz stereo is what the file was, and the guide is what the model was
    // trained with. A wrong rate here is not a rounding difference.
    expect(() => toDecodedAudio({sampleRate: 44100, base64})).toThrow(/16000/);
    expect(() => toDecodedAudio({sampleRate: '16000', base64})).toThrow(/16000/);
  });

  it('refuses samples that are not a whole number of samples', () => {
    expect(() => toDecodedAudio({sampleRate: 16000, base64: ''})).toThrow();
    expect(() =>
      toDecodedAudio({
        sampleRate: 16000,
        base64: Buffer.from([1, 2, 3]).toString('base64'),
      }),
    ).toThrow(/samples/);
    expect(() => toDecodedAudio({sampleRate: 16000})).toThrow();
    expect(() => toDecodedAudio(null)).toThrow();
    expect(() => toDecodedAudio('text')).toThrow();
  });
});

describe('toDecodedVideo', () => {
  it('drops the data URL prefix the client does not want', () => {
    // The engine is handed base64 picture data; a `data:` prefix left on is
    // sent as the first bytes of the image.
    expect(toDecodedVideo(['data:image/png;base64,iVBORw0KGgo='])).toEqual({
      kind: 'video',
      frames: ['iVBORw0KGgo='],
    });
    expect(toDecodedVideo(['iVBORw0KGgo=', 'AAAA'])).toEqual({
      kind: 'video',
      frames: ['iVBORw0KGgo=', 'AAAA'],
    });
  });

  it('refuses a clip that produced nothing', () => {
    // An input with no frames is a vector that matches nothing while looking
    // exactly like an embedding.
    for (const raw of [[], {frames: ['AAAA']}, 'text', null, undefined]) {
      expect(() => toDecodedVideo(raw)).toThrow(/no frames/);
    }
  });

  it('refuses a frame that is not an image', () => {
    for (const raw of [[42], [''], ['AAAA', null]]) {
      expect(() => toDecodedVideo(raw)).toThrow(/not an image/);
    }
  });
});

describe('the page scripts', () => {
  it('are syntactically valid JavaScript', () => {
    // They only ever run inside a page, where a syntax error reads as "the
    // video could not be decoded". Parsing them here is the cheap way to catch
    // that, the way `search-parse.test.ts` does for the extraction script.
    expect(() => new Function(audioDecodeScript('AAAA'))).not.toThrow();
    expect(() =>
      new Function(videoMetadataScript('marimo-media://media/x')),
    ).not.toThrow();
    expect(() => new Function(videoFramesScript([0, 1.5]))).not.toThrow();
  });

  it('quotes the video URL rather than pasting it into the script', () => {
    const source = mediaUrl('/tmp/take "1".mp4');
    expect(videoMetadataScript(source)).toContain(JSON.stringify(source));
    expect(() => new Function(videoMetadataScript(source))).not.toThrow();
  });

  it('asks the page for the frames it was given', () => {
    const script = videoFramesScript([0, 1.25]);
    expect(script).toContain(JSON.stringify([0, 1.25]));
    expect(script).toContain('toDataURL');
    expect(script).toContain('seeked');
  });
});
