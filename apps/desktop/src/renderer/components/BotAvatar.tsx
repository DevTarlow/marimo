/**
 * One bot's icon, with the letter its name starts with as the fallback.
 *
 * The fallback is not decoration. Every path that can produce a picture can also
 * fail — an upload deleted outside the app, a profile written by a build that
 * shipped an icon this one does not, a custom file the user moved — and a
 * broken-image glyph in the rail would make the app look broken rather than the
 * picture look missing. A letter is honest, stable and needs no file.
 */
import {useEffect, useState} from 'react';

import type {AgentProfile} from '@marimo/protocol';

import {botAvatarSource} from '../bot-avatar.js';

export function BotAvatar({
  profile,
  size = 'md',
  className,
}: {
  profile: Pick<AgentProfile, 'id' | 'name' | 'avatar'>;
  size?: 'sm' | 'md';
  className?: string;
}): React.JSX.Element {
  const src = botAvatarSource(profile);
  const [failed, setFailed] = useState(false);

  // A new source is a new chance to paint: switching a bot from a broken custom
  // icon to a preset must not keep showing the letter forever.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const initial = [...profile.name][0]?.toUpperCase() ?? '?';
  const classes =
    className === undefined ? 'bot-avatar' : `bot-avatar ${className}`;

  if (src === undefined || failed) {
    return (
      <span
        className={classes}
        data-size={size}
        aria-hidden="true"
        title={profile.name}
      >
        {initial}
      </span>
    );
  }

  return (
    <span className={classes} data-size={size} aria-hidden="true">
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => {
          setFailed(true);
        }}
      />
    </span>
  );
}
