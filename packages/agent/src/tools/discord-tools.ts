/**
 * The Discord tools: what lets the agent talk in a server the user connected.
 *
 * These are the agent's half of the integration. The app owns the bot token, the
 * gateway connection and the channel that is watched; this file knows only the
 * three things an agent can do — post a message, read recent ones, and find out
 * which channels exist — behind a port the desktop main process implements and a
 * test implements over an array.
 *
 * Two rules are deliberate:
 *
 * - **Reading is free, posting may not be.** The only destructive act here is
 *   sending, so that is the one behind ADK's confirmation gate, and only when the
 *   message is going somewhere other than the channel the user already pointed
 *   the bot at. Replying where the user asked to be answered needs no approval;
 *   posting into some other server does.
 * - **The model never sees the token.** Nothing in this file can authenticate:
 *   the port it talks to is already authenticated, which is what keeps a bot
 *   token out of a prompt and out of a transcript.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import type {DiscordChannel, DiscordMessage} from '@marimo/protocol';

/**
 * Everything the tools need from the app that owns the connection.
 *
 * This is the whole coupling between the agent package and Discord: no Electron,
 * no HTTP, no token — the desktop main process implements it over its REST
 * client, and a test implements it over an array.
 */
export interface DiscordService {
  /**
   * The channel the user pointed the bot at: where mentions arrive, and where the
   * agent posts unless it names somewhere else.
   *
   * Synchronous on purpose. It is the answer to "may this send run without asking
   * the user?", and a confirmation gate that had to open a connection to decide
   * would make every call wait on Discord.
   */
  defaultChannel(): {id: string; name: string} | undefined;
  /** Posts one message. `channel` is an id or a name; omitted means the default. */
  send(input: {
    channel?: string;
    text: string;
    replyTo?: string;
  }): Promise<{id: string; channel: string}>;
  /** Recent messages, newest last, for context. */
  history(input: {channel?: string; limit: number}): Promise<DiscordMessage[]>;
  /** Every channel the bot can post to, for finding one by name. */
  channels(): Promise<DiscordChannel[]>;
}

export interface DiscordToolContext {
  discord: DiscordService;
}

/** Discord's own hard limit for one message. */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** How many messages a read may ask for, and its default. */
export const DISCORD_READ_DEFAULT = 20;
export const DISCORD_READ_MAX = 50;

/**
 * The three tools as one group, so the catalogue in `tools/index.ts` stays a list
 * of what the agent can do rather than of how it is wired.
 */
export function discordTools(context: DiscordToolContext) {
  return [
    createSendDiscordMessageTool(context),
    createReadDiscordMessagesTool(context),
    createListDiscordChannelsTool(context),
  ];
}

export function createSendDiscordMessageTool(context: DiscordToolContext) {
  return new FunctionTool({
    name: 'send_discord_message',
    description:
      'Post a message to Discord, as the bot the user connected. With no ' +
      '`channel`, it goes to the channel the user pointed the bot at, which is ' +
      'also where @mentions of you arrive — answering an ordinary question there ' +
      'is what this is for. Name another `channel` (id or name, see ' +
      '`list_discord_channels`) only when the user asked for that. Posting ' +
      'anywhere other than the watched channel needs the user to approve it ' +
      'first, so prefer a reply in the watched channel when it fits — naming ' +
      'the watched channel, by id or by name, is the same as omitting it and ' +
      'needs no approval. Use ' +
      '`replyTo` with the id of a message to make your message a visible reply to ' +
      'it. Discord markdown works; one message is at most ' +
      `${DISCORD_MESSAGE_LIMIT} characters.`,
    parameters: z.object({
      text: z.string().describe('The message to post, in Discord markdown.'),
      channel: z
        .string()
        .optional()
        .describe(
          'Channel id or name to post to. Omit for the watched channel, which ' +
            'the user has already approved.',
        ),
      replyTo: z.string().optional().describe('Id of the message to reply to.'),
    }),
    /*
     * Approval is asked for exactly when the message is not going where the user
     * pointed the bot. Comparing against the stored default rather than resolving
     * the name here keeps the gate synchronous: a predicate that had to ask
     * Discord which channel "general" is would turn every send into a round trip
     * before the user even saw a prompt.
     */
    requireConfirmation: (input) => needsApproval(context, input.channel),
    execute: async ({text, channel, replyTo}) => {
      if (text.trim().length === 0) {
        return 'Nothing to post: the message text was empty.';
      }
      if (text.length > DISCORD_MESSAGE_LIMIT) {
        // Refused here rather than sent and rejected: Discord answers an over-long
        // message with a 400, and the model can act on this sentence.
        return (
          `That message is ${text.length} characters, over Discord's ` +
          `${DISCORD_MESSAGE_LIMIT}-character limit. Split it into shorter ` +
          'messages and send them one at a time.'
        );
      }
      try {
        const sent = await context.discord.send({
          ...(channel !== undefined ? {channel} : {}),
          text,
          ...(replyTo !== undefined && replyTo.length > 0 ? {replyTo} : {}),
        });
        const where =
          channel === undefined ? 'the watched channel' : `#${sent.channel}`;
        return `Posted to ${where} (message id ${sent.id}).`;
      } catch (error) {
        return `Could not post to Discord: ${describe(error)}`;
      }
    },
  });
}

export function createReadDiscordMessagesTool(context: DiscordToolContext) {
  return new FunctionTool({
    name: 'read_discord_messages',
    description:
      'Read recent messages from a Discord channel, oldest first, so you can ' +
      'answer with the conversation in front of you instead of guessing at it. ' +
      'With no `channel`, this reads the channel the user pointed the bot at. ' +
      'Messages are returned with their ids, so one can be answered with ' +
      '`send_discord_message` and `replyTo`. Reading needs no approval.',
    parameters: z.object({
      channel: z
        .string()
        .optional()
        .describe('Channel id or name. Omitted reads the watched channel.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(DISCORD_READ_MAX)
        .optional()
        .describe(
          `How many messages to read, at most ${DISCORD_READ_MAX}. Defaults to ` +
            `${DISCORD_READ_DEFAULT}.`,
        ),
    }),
    execute: async ({channel, limit}) => {
      try {
        const messages = await context.discord.history({
          ...(channel !== undefined ? {channel} : {}),
          limit: limit ?? DISCORD_READ_DEFAULT,
        });
        if (messages.length === 0) {
          return 'That channel has no messages this bot can read.';
        }
        return messages.map(formatMessage).join('\n');
      } catch (error) {
        return `Could not read Discord: ${describe(error)}`;
      }
    },
  });
}

export function createListDiscordChannelsTool(context: DiscordToolContext) {
  return new FunctionTool({
    name: 'list_discord_channels',
    description:
      'List the Discord channels this bot can post to, with their ids. Use it ' +
      'before sending anywhere other than the watched channel, so you are ' +
      'naming a channel that exists rather than one you assumed.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const channels = await context.discord.channels();
        if (channels.length === 0) {
          return 'This bot is not in any server it can post to yet.';
        }
        const watched = context.discord.defaultChannel();
        return channels
          .map((channel) => {
            const mark = channel.id === watched?.id ? ' (watched)' : '';
            const guild = channel.guild.length > 0 ? ` — ${channel.guild}` : '';
            return `- ${channel.id} · #${channel.name}${guild}${mark}`;
          })
          .join('\n');
      } catch (error) {
        return `Could not list Discord channels: ${describe(error)}`;
      }
    },
  });
}

/**
 * Whether a send has to be approved: everything except the watched channel.
 *
 * An omitted channel is the watched one by definition, so it never asks. An
 * explicit reference asks only when it names somewhere *else* — and both the id
 * and the name of the watched channel count as the same destination.
 *
 * The name has to count. The mention prompt tells the model which channel it was
 * mentioned in ("#general in Marimo HQ"), so being explicit about where the
 * answer goes is the natural thing for it to do — and treating that as a
 * different channel posted an approval card for a reply the user had already
 * asked for. Comparing names is the *less* safe direction only for two channels
 * sharing a name across servers; requiring the user to approve their own
 * channel's reply on every mention is the worse failure, so the name wins.
 *
 * `#general`, `general` and ` general ` are all the same channel here, which is
 * what the REST client's own lookup already assumes.
 */
function needsApproval(
  context: DiscordToolContext,
  channel: string | undefined,
): boolean {
  if (channel === undefined) {
    return false;
  }
  const watched = context.discord.defaultChannel();
  if (!watched) {
    return true;
  }
  const wanted = normaliseChannel(channel);
  if (wanted.length === 0) {
    // An empty or whitespace-only reference means "the watched channel", which
    // is what the REST client resolves it to.
    return false;
  }
  if (channel.trim() === watched.id) {
    return false;
  }
  return wanted !== normaliseChannel(watched.name);
}

/** A channel reference with the sigil, the case and the padding taken off. */
function normaliseChannel(channel: string): string {
  return channel.trim().replace(/^#/u, '').toLowerCase();
}

/** One message, in the form the model reads: header, then the text. */
function formatMessage(message: DiscordMessage): string {
  const who = message.bot ? `${message.author} (bot)` : message.author;
  const body =
    message.content.trim().length > 0 ? message.content : '(no text)';
  return `- id ${message.id} · ${who} · ${message.createdAt}\n  ${body.replace(/\n/gu, '\n  ')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
