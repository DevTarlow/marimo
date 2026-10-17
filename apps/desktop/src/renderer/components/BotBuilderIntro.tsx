/**
 * Marimo's opening question in a builder conversation.
 *
 * A card rather than a stored model message, and that is deliberate. A first
 * request whose history begins with a model turn is accepted by some providers
 * and not others, and a small model can lose an instruction it was never given;
 * the card is drawn from the conversation's stored *purpose* and the same
 * constant the builder instruction quotes, so the question cannot be missing
 * after a reload and cannot disagree with what Marimo thinks it asked.
 *
 * It stops being the whole story the moment somebody types: the card is a
 * pinned opening, not a message, and the model's answer follows it.
 */
import {BOT_BUILDER_OPENING} from '@marimo/protocol';
import type {AgentProfile} from '@marimo/protocol';

import {BotAvatar} from './BotAvatar.js';

export function BotBuilderIntro({
  lead,
}: {
  lead: AgentProfile | undefined;
}): React.JSX.Element {
  return (
    <div className="builder-intro">
      <div className="builder-intro-head">
        {lead !== undefined ? (
          <BotAvatar profile={lead} size="sm" />
        ) : (
          <span className="agent-mark" aria-hidden="true">
            M
          </span>
        )}
        <span className="builder-intro-who">{lead?.name ?? 'Marimo Bot'}</span>
        <span className="builder-intro-tag">Making a bot</span>
      </div>
      <p className="builder-intro-question">{BOT_BUILDER_OPENING}</p>
      <p className="builder-intro-note">
        Answer in your own words. When Marimo has enough, it drafts the bot and
        shows it to you in a card — nothing is made until you say so.
      </p>
    </div>
  );
}
