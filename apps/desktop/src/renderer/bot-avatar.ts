/**
 * Where a bot's picture comes from.
 *
 * Two kinds, and they are built differently on purpose. A preset is one of the
 * SVGs this app ships, so it is a path relative to the renderer bundle — the
 * same file in development and in a packaged build. A custom icon lives in the
 * user's data directory, which the sandboxed renderer cannot read, so it comes
 * through `marimo-asset://` and its version makes a replacement a different URL.
 *
 * Absent means the default preset. That is what every profile written before
 * icons existed carries, and falling back to a picture rather than to an initial
 * is what makes "every bot has an icon" true on upgrade.
 */
import {
  BOT_AVATAR_PRESETS,
  DEFAULT_BOT_AVATAR_ID,
  botAvatarUrl,
} from '@marimo/protocol';
import type {AgentProfile, BotAvatar} from '@marimo/protocol';

const PRESET_IDS = new Set<string>(
  BOT_AVATAR_PRESETS.map((preset) => preset.id),
);

/** One of the shipped icons, by id; undefined for an id this build does not ship. */
export function presetAvatarSource(id: string): string | undefined {
  return PRESET_IDS.has(id) ? `./bot-avatars/${id}.svg` : undefined;
}

/**
 * The image source for a bot, or undefined when it has to be drawn as an initial.
 *
 * The undefined case is an unknown preset id from a newer build or a hand-edited
 * file. It is deliberately not "the default icon": a picture the person did not
 * choose is a worse lie than the initial their name already provides.
 */
export function botAvatarSource(
  profile: Pick<AgentProfile, 'id' | 'avatar'>,
): string | undefined {
  return avatarSource(profile.id, profile.avatar);
}

export function avatarSource(
  profileId: string,
  avatar: BotAvatar | undefined,
): string | undefined {
  if (avatar === undefined) {
    return presetAvatarSource(DEFAULT_BOT_AVATAR_ID);
  }
  if (avatar.kind === 'custom') {
    return botAvatarUrl(profileId, avatar.id);
  }
  return presetAvatarSource(avatar.id);
}
