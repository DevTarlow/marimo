/**
 * The translation from a decoded file to the content parts the engine takes.
 *
 * The rule worth testing is a negative one: media carries **no task prefix**. A
 * text chunk goes in as `title: … | text: …`, and a picture that got the same
 * wrapper would be asking the model to read a training shape it was never given
 * beside one — and nothing about the result would show it.
 */
import {basename} from 'node:path';

import {describe, expect, it} from 'vitest';

import {encodeWav, mediaParts} from '../src/main/media/parts.js';

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header for the samples', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const wav = encodeWav(samples, 16_000);

    expect(wav.byteLength).toBe(44 + samples.length * 2);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2);
    // Clamped rather than wrapped: -1 is negative full scale, 2 is positive.
    expect(wav.readInt16LE(44 + 4 * 2)).toBe(-32_767);
    expect(wav.readInt16LE(44 + 5 * 2)).toBe(32_767);
  });
});

describe('mediaParts', () => {
  it('names the file and passes it with no task prefix', () => {
    const parts = mediaParts('/somewhere/holiday.png', {
      kind: 'image',
      mime: 'image/png',
      base64: 'AAAA',
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({type: 'text', text: 'holiday.png'});
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: {url: 'data:image/png;base64,AAAA'},
    });
    for (const part of parts) {
      if (part.type === 'text') {
        expect(part.text).not.toContain('title:');
        expect(part.text).not.toContain('text:');
      }
    }
  });

  it('sends audio as a 16 kHz mono WAV', () => {
    const samples = Float32Array.from([0, 0.25, -0.25]);
    const parts = mediaParts('/somewhere/clip.mp3', {
      kind: 'audio',
      sampleRate: 16_000,
      samples,
    });

    expect(parts[0]).toEqual({type: 'text', text: 'clip.mp3'});
    const audio = parts[1];
    expect(audio?.type).toBe('input_audio');
    if (audio?.type !== 'input_audio') {
      throw new Error('expected an audio part');
    }
    expect(audio.input_audio.format).toBe('wav');
    const wav = Buffer.from(audio.input_audio.data, 'base64');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
  });

  it('sends a video as one input of its frames', () => {
    const parts = mediaParts('/somewhere/take 1.mp4', {
      kind: 'video',
      frames: ['AAAA', 'BBBB', 'CCCC'],
    });

    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({type: 'text', text: basename('/somewhere/take 1.mp4')});
    expect(parts.slice(1)).toEqual([
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,BBBB'}},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,CCCC'}},
    ]);
  });
});
