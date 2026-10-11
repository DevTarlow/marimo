/**
 * The last step of a decode: what the embedding client is handed.
 *
 * `decode-window.ts` produces pictures, samples and frames; the engine takes
 * *content parts*, and the two are not the same shape. This is the translation,
 * and it is a separate file because it is the one place the model's own rules
 * about media are actually applied:
 *
 * - **No task prefix.** A text chunk goes in as `title: … | text: …`, which is a
 *   retrieval-document instruction the model was trained with. An image, a WAV or
 *   an MP4 is passed with no instruction at all — the guide is explicit — so the
 *   only text that ever accompanies one here is the file's own name. That name is
 *   not decoration: a folder of holiday photographs embeds differently when each
 *   vector knows which file it is, and it is the one thing a search result can
 *   show.
 * - **Audio is 16 kHz mono.** The decoder already resampled it — this file would
 *   be the wrong place to change it and does not — and it is encoded as a WAV
 *   because that is the only container the client's `input_audio` part names.
 * - **A video is one input.** Its frames go in together with the name, so the
 *   clip is one point in the space rather than a dozen unrelated stills, which is
 *   what the guide's own video recipe describes.
 */
import {basename} from 'node:path';

import type {EmbeddingPart} from '@marimo/runtime';

import type {DecodedMedia} from './decode-window.js';

/**
 * Mono 16-bit PCM in a WAV container, as the bytes the client base64s.
 *
 * 16-bit rather than float: `input_audio` names `wav` and nothing more specific,
 * and the model's own preprocessing reads a conventional PCM file. Clamped rather
 * than wrapped, because a sample outside `[-1, 1]` — which a lossy decoder can
 * produce — wrapped around would be a loud click embedded into the vector.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // one channel: mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); // byte rate
  bytes.writeUInt16LE(2, 32); // block align
  bytes.writeUInt16LE(16, 34); // bits per sample
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (const [index, sample] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, sample));
    bytes.writeInt16LE(Math.round(clamped * 32_767), 44 + index * 2);
  }
  return bytes;
}

/**
 * The content parts for one decoded file.
 *
 * One input, whatever the kind: the name and the media, in that order. The empty
 * case is impossible — the decoder throws rather than returning a picture with no
 * bytes or a clip with no frames — so a caller that gets parts gets something the
 * engine can embed.
 */
export function mediaParts(path: string, decoded: DecodedMedia): EmbeddingPart[] {
  const name: EmbeddingPart = {type: 'text', text: basename(path)};

  switch (decoded.kind) {
    case 'image':
      return [
        name,
        {
          type: 'image_url',
          image_url: {url: `data:${decoded.mime};base64,${decoded.base64}`},
        },
      ];
    case 'audio':
      return [
        name,
        {
          type: 'input_audio',
          input_audio: {
            data: encodeWav(decoded.samples, decoded.sampleRate).toString('base64'),
            format: 'wav',
          },
        },
      ];
    case 'video':
      return [
        name,
        ...decoded.frames.map(
          (frame): EmbeddingPart => ({
            type: 'image_url',
            image_url: {url: `data:image/png;base64,${frame}`},
          }),
        ),
      ];
  }
}
