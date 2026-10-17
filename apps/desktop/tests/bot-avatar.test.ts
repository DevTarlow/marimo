/**
 * Where the rail and Settings get a bot's picture.
 *
 * The fallback rule is the part worth pinning: absent means the default icon,
 * an unknown preset means the letter, and a custom icon means a versioned
 * `marimo-asset` URL. Getting the last two backwards would either show a picture
 * the user did not choose or a broken image glyph where a name should be.
 */
import {describe, expect, it} from 'vitest';

import {avatarSource, botAvatarSource, presetAvatarSource} from '../src/renderer/bot-avatar.js';

describe('bot avatar sources', () => {
  it('draws the default icon when a profile has no choice of its own', () => {
    expect(botAvatarSource({id: 'bot-1'})).toBe('./bot-avatars/marimo.svg');
    expect(avatarSource('bot-1', undefined)).toBe('./bot-avatars/marimo.svg');
  });

  it('draws a shipped preset by id', () => {
    expect(presetAvatarSource('wave')).toBe('./bot-avatars/wave.svg');
    expect(botAvatarSource({id: 'bot-1', avatar: {kind: 'preset', id: 'wave'}})).toBe(
      './bot-avatars/wave.svg',
    );
  });

  it('falls back to the initial for an icon this build does not ship', () => {
    expect(presetAvatarSource('from-the-future')).toBeUndefined();
    expect(
      botAvatarSource({
        id: 'bot-1',
        avatar: {kind: 'preset', id: 'from-the-future'},
      }),
    ).toBeUndefined();
  });

  it('routes a custom icon through the asset scheme, with its version', () => {
    const source = botAvatarSource({
      id: 'bot 1',
      avatar: {kind: 'custom', id: 'revision-2'},
    });
    expect(source).toContain('marimo-asset://bot/bot%201.png');
    expect(source).toContain('v=revision-2');
  });
});
