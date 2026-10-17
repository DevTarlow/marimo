/**
 * Turning a file the user picked into one bot's icon.
 *
 * The renderer never sees the chosen path and never writes a file: the picker,
 * the decoder and the one PNG the app owns all live here, in the process that
 * has `nativeImage` and a real filesystem. What crosses back is the profile's new
 * marker, which names the picture but cannot name a directory.
 *
 * PNG is the format written regardless of what was picked. It is lossless, has
 * alpha, and Chromium decodes it without a codec question — and re-encoding is
 * also what stops a file that is an image by extension and something else by
 * content from being served as one.
 */
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {BrowserWindow, dialog, nativeImage} from 'electron';
import type {OpenDialogOptions} from 'electron';

import {avatarFileName} from '@marimo/runtime';

/**
 * The largest file worth decoding.
 *
 * A ten-megabyte JPEG is already far larger than a 512-pixel icon needs, and the
 * size is checked before `nativeImage` allocates anything: a user can point the
 * picker at a 100 MB photograph, and the refusal should be a sentence rather
 * than a stalled main process.
 */
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/** The longest side of the stored image, in pixels. */
export const MAX_AVATAR_EDGE = 512;

/**
 * How large an image of this shape becomes.
 *
 * The aspect ratio is preserved because the picture is drawn inside a square
 * with `object-fit: cover`; stretching it here would leave the rail showing a
 * squashed face. Never upscaled: a 64-pixel icon is already as sharp as it is,
 * and a bigger canvas would only make the file larger.
 */
export function avatarTargetSize(
  width: number,
  height: number,
  maxEdge: number = MAX_AVATAR_EDGE,
): {width: number; height: number} {
  if (width <= 0 || height <= 0) {
    return {width: 1, height: 1};
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The picker, parented so a modal cannot hide behind the window that opened it. */
async function pickImage(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Choose an icon for this bot',
    buttonLabel: 'Use this image',
    properties: ['openFile'],
    filters: [{name: 'Images', extensions: ['png', 'jpg', 'jpeg']}],
  };
  const parent = BrowserWindow.getFocusedWindow();
  const result =
    parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  return result.canceled ? undefined : result.filePaths[0];
}

/**
 * Asks for an image and writes it as this bot's icon.
 *
 * Answers whether anything changed, so a closed picker is an ordinary answer
 * rather than an error. The write is atomic and happens before the profile is
 * pointed at it: a failed write leaves the old icon in place, and a profile
 * update that fails leaves an unreferenced PNG rather than a broken image.
 */
export async function uploadBotAvatar(
  avatarsDir: string,
  profileId: string,
): Promise<boolean> {
  const picked = await pickImage();
  if (picked === undefined) {
    return false;
  }

  const stats = await stat(picked).catch(() => undefined);
  if (stats === undefined || !stats.isFile()) {
    throw new Error('That file is no longer there.');
  }
  if (stats.size > MAX_AVATAR_BYTES) {
    throw new Error(
      `That image is ${Math.ceil(stats.size / (1024 * 1024))} MB. ` +
        'Choose one under 10 MB.',
    );
  }

  const decoded = nativeImage.createFromBuffer(await readFile(picked));
  if (decoded.isEmpty()) {
    throw new Error('That file is not a PNG or JPEG this app can read.');
  }
  const size = decoded.getSize();
  const target = avatarTargetSize(size.width, size.height);
  const resized =
    target.width === size.width && target.height === size.height
      ? decoded
      : decoded.resize({...target, quality: 'best'});
  const png = resized.toPNG();
  if (png.length === 0) {
    throw new Error('That image could not be prepared for the app.');
  }

  await mkdir(avatarsDir, {recursive: true});
  const targetPath = join(avatarsDir, avatarFileName(profileId));
  const temporary = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporary, png);
  await rename(temporary, targetPath);
  return true;
}

