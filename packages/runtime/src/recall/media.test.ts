/**
 * The media discovery table, and when a clip's frames are taken.
 *
 * Both are rules the model's guide states rather than choices this app made —
 * six extensions each, one frame per second — and the failure when they drift is
 * invisible: a video indexes one frame instead of twelve and a result list finds
 * nothing, with no error anywhere.
 */
import {describe, expect, it} from 'vitest';

import {
  frameTimes,
  MEDIA_EXTENSIONS,
  MEDIA_KINDS,
  mediaKindOf,
} from './media.js';

describe('media discovery', () => {
  it('knows exactly six extensions for each kind', () => {
    for (const kind of MEDIA_KINDS) {
      expect(MEDIA_EXTENSIONS[kind]).toHaveLength(6);
      for (const extension of MEDIA_EXTENSIONS[kind]) {
        expect(extension.startsWith('.')).toBe(true);
        expect(extension).toBe(extension.toLowerCase());
      }
    }
  });

  it('classifies a path by its own extension', () => {
    expect(mediaKindOf('a/photo.PNG')).toBe('image');
    expect(mediaKindOf('a/song.mp3')).toBe('audio');
    expect(mediaKindOf('a/clip.webm')).toBe('video');
    expect(mediaKindOf('a/notes.txt')).toBeUndefined();
    expect(mediaKindOf('a/noextension')).toBeUndefined();
  });

  /*
   * A directory that happens to be called `notes.mp4` must not make every file
   * under it media: the extension has to belong to the basename.
   */
  it('is not fooled by a dot in a directory name', () => {
    expect(mediaKindOf('notes.mp4/readme.md')).toBeUndefined();
    expect(mediaKindOf('holiday.png/notes.txt')).toBeUndefined();
  });
});

describe('frameTimes', () => {
  it('takes one frame a second while the clip fits under the cap', () => {
    expect(frameTimes(3, 24)).toEqual([0, 1, 2]);
  });

  it('spreads the cap across a clip that is longer than it', () => {
    const times = frameTimes(100, 4);
    expect(times).toHaveLength(4);
    expect(times[0]).toBeCloseTo(20);
    expect(times[3]).toBeCloseTo(80);
  });

  it('gives a short clip one frame at the start', () => {
    expect(frameTimes(0.4, 24)).toEqual([0]);
  });

  it('gives nothing for a clip with no length', () => {
    expect(frameTimes(0, 24)).toEqual([]);
    expect(frameTimes(-5, 24)).toEqual([]);
    expect(frameTimes(Number.NaN, 24)).toEqual([]);
  });

  it('gives nothing for a cap that is not a number of frames', () => {
    expect(frameTimes(10, 0)).toEqual([]);
    expect(frameTimes(10, -1)).toEqual([]);
  });
});
