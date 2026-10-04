/**
 * The single typed contract between the Marimo Desktop main process and its
 * renderer.
 *
 * Both sides import this module: the main process validates every inbound call
 * with `callSchemas`, and the renderer gets compile-time checking for the same
 * calls through `MarimoBridge`. Nothing here depends on Electron, Node, or
 * React, so it can be reused by a future CLI or test harness.
 */
import {z} from 'zod';

import {parseCron} from './cron.js';
import {mcpServerSchema, mcpServersAreDistinct} from './mcp.js';

export {describeCron, nextCronRun, nextRunAfter, parseCron} from './cron.js';
export type {CronSpec} from './cron.js';

/*
 * The approval summary is here rather than in the renderer because the window's
 * card and the Discord message both have to say the same thing about a gate.
 */
export {meaningfulHint, summarizeApproval} from './approval.js';
export type {ApprovalPreview} from './approval.js';

/*
 * MCP servers, the documents that describe them, and the naming rule that keeps
 * their tools from colliding with this app's own.
 */
export {
  MCP_SERVER_NAME_HELP,
  MCP_SERVER_NAME_PATTERN,
  mcpSecretRefSchema,
  mcpServerSchema,
  mcpToolName,
  mcpToolPrefix,
  mcpTransportSchema,
} from './mcp.js';
export type {McpSecretRef, McpServer, McpTransport} from './mcp.js';
import type {McpServer} from './mcp.js';

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The model backends the app can talk to.
 *
 * Every one of them speaks the OpenAI chat-completions dialect, so a single
 * transport serves them all and switching provider is a base URL, a key and a
 * model id rather than a second client. Gemini and OpenRouter are reached through
 * an OpenAI-compatibility layer rather than a vendor client for exactly that
 * reason: one code path to test, and one place where tool calls are translated.
 *
 * `deepseek` is first because it is the default and the only one a fresh install
 * is pointed at.
 */
export const PROVIDER_IDS = [
  'deepseek',
  'llamacpp',
  'gemini',
  'openrouter',
] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * Everything about a provider that is not a user choice.
 *
 * The two wire flags are here rather than in the transport because they are
 * facts about the endpoint, not preferences: DeepSeek and llama.cpp both stream a
 * `reasoning_content` channel and honour `stream_options.include_usage`, while
 * Gemini's compatibility layer rejects the latter and has no equivalent of the
 * former. Sending an unsupported field is not a cosmetic mistake — it is a 400
 * on every request — so the flags travel with the provider id and the transport
 * stays free of `if (provider === ...)`.
 */
export interface ProviderDescriptor {
  id: ProviderId;
  /** What the picker shows. */
  label: string;
  /** One line under the picker: where the requests actually go. */
  blurb: string;
  defaultBaseUrl: string;
  /**
   * Placeholder model ids, used only until the provider has been asked what it
   * actually serves.
   *
   * `GET /models` is authoritative and replaces this list as soon as a call
   * succeeds, because these names do go stale: DeepSeek has already renamed its
   * models once (`deepseek-chat` / `deepseek-reasoner` are legacy names now), and
   * Gemini renames its line far more often than that. Nothing the user sees
   * should depend on this list surviving.
   */
  fallbackModels: readonly string[];
  /**
   * False for a llama.cpp server on the LAN, which usually takes no key at all.
   * The app still stores one if the user pastes it — `llama-server --api-key`
   * exists — but nothing is blocked on it.
   */
  requiresApiKey: boolean;
  keyPlaceholder: string;
  keyHelp: string;
  /** Whether thinking arrives as a `reasoning_content` delta. */
  reasoningChannel: boolean;
  /** Whether `stream_options.include_usage` may be sent. */
  usageInStream: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    blurb: 'DeepSeek’s own API, over the public internet.',
    defaultBaseUrl: 'https://api.deepseek.com',
    fallbackModels: ['deepseek-flash', 'deepseek-v4-pro'],
    requiresApiKey: true,
    keyPlaceholder: 'sk-…',
    keyHelp: 'From platform.deepseek.com → API keys.',
    reasoningChannel: true,
    usageInStream: true,
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'Local llama.cpp',
    blurb:
      'A llama-server on this machine or your network. Nothing leaves your LAN.',
    /*
     * Loopback is the one address that is right for anybody running the server
     * beside the app; a server on the network is a host the user has to type, and
     * the field below is where they type it.
     */
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    fallbackModels: ['local-model'],
    requiresApiKey: false,
    keyPlaceholder: 'not needed',
    keyHelp:
      'Only if you started llama-server with --api-key. Leave it empty otherwise.',
    reasoningChannel: true,
    usageInStream: true,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    blurb: 'Gemini through Google’s OpenAI-compatible endpoint.',
    // Trailing slash included, as Google documents it; the transport strips it.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    fallbackModels: ['gemini-3.6-flash', 'gemini-3.1-pro'],
    requiresApiKey: true,
    keyPlaceholder: 'AIza…',
    keyHelp: 'From aistudio.google.com/apikey.',
    reasoningChannel: false,
    /*
     * The compatibility layer documents no `stream_options` support and answers
     * a request that carries it with an error rather than ignoring it. Usage
     * arrives as zeroes and the token badge stays quiet, which is a much smaller
     * loss than every turn failing.
     */
    usageInStream: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb: 'One key for many vendors’ models, routed by OpenRouter.',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    /*
     * `openrouter/auto` is the one name that cannot go stale: it is the service's
     * own router, which picks a model per request and is documented to keep
     * working as the catalogue behind it changes. Anything more specific is a
     * snapshot of today's line-up.
     */
    fallbackModels: ['openrouter/auto'],
    requiresApiKey: true,
    keyPlaceholder: 'sk-or-…',
    keyHelp: 'From openrouter.ai/keys.',
    /*
     * Both true, and that is the honest answer to a question the flag does not
     * quite ask. OpenRouter *does* accept `stream_options.include_usage`, so the
     * token badge works. Its reasoning arrives under `reasoning` rather than
     * `reasoning_content`, which this transport does not read: thinking from an
     * OpenRouter reasoning model therefore stays inside the answer's text
     * instead of appearing as a thought part. Reading it means the provider
     * catalogue can no longer be keyed on a plain string id — see the README.
     */
    reasoningChannel: true,
    usageInStream: true,
  },
};

export function providerDescriptor(provider: ProviderId): ProviderDescriptor {
  return PROVIDERS[provider];
}

/** A copy, so a caller cannot reorder the catalogue's own array. */
export function fallbackModelsFor(provider: ProviderId): string[] {
  return [...PROVIDERS[provider].fallbackModels];
}

/** Kept for the DeepSeek-shaped callers that predate the picker. */
export const FALLBACK_MODELS: readonly string[] =
  PROVIDERS.deepseek.fallbackModels;
export const DEFAULT_MODEL: string = PROVIDERS.deepseek.fallbackModels[0]!;
export const DEFAULT_BASE_URL = PROVIDERS.deepseek.defaultBaseUrl;

/** How to reach one provider, and which model to use by default there. */
export const providerConfigSchema = z.object({
  baseUrl: z.string().min(1),
  model: z.string().min(1),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * The provider choice: which one is live, and what each one was last set to.
 *
 * Every provider keeps its own base URL and model rather than sharing one pair,
 * so switching to the local server and back does not cost the user the address
 * they typed. Keys are not here — they are secrets, and they live in the
 * keychain under one file per provider (see the main process's `paths`).
 */
export const providersSchema = z.object({
  active: providerIdSchema,
  configs: z.object({
    deepseek: providerConfigSchema,
    llamacpp: providerConfigSchema,
    gemini: providerConfigSchema,
    openrouter: providerConfigSchema,
  }),
});

export type Providers = z.infer<typeof providersSchema>;

/**
 * A patch of the provider block.
 *
 * Nested one level deeper than Discord's, deliberately: the block holds a
 * sub-object per provider, and `providersSchema.partial()` would make the whole
 * `configs` optional while still requiring every entry inside it — so setting one
 * base URL would mean sending all the others, and a stale window's copy of those
 * is exactly what must not win. The store merges each named provider over what it
 * has.
 */
export const providersPatchSchema = z.object({
  active: providerIdSchema.optional(),
  configs: z
    .object({
      deepseek: providerConfigSchema.partial().optional(),
      llamacpp: providerConfigSchema.partial().optional(),
      gemini: providerConfigSchema.partial().optional(),
      openrouter: providerConfigSchema.partial().optional(),
    })
    .optional(),
});

export type ProvidersPatch = z.infer<typeof providersPatchSchema>;

export function defaultProviders(): Providers {
  return {
    active: 'deepseek',
    configs: {
      deepseek: {
        baseUrl: PROVIDERS.deepseek.defaultBaseUrl,
        model: PROVIDERS.deepseek.fallbackModels[0]!,
      },
      llamacpp: {
        baseUrl: PROVIDERS.llamacpp.defaultBaseUrl,
        model: PROVIDERS.llamacpp.fallbackModels[0]!,
      },
      gemini: {
        baseUrl: PROVIDERS.gemini.defaultBaseUrl,
        model: PROVIDERS.gemini.fallbackModels[0]!,
      },
      openrouter: {
        baseUrl: PROVIDERS.openrouter.defaultBaseUrl,
        model: PROVIDERS.openrouter.fallbackModels[0]!,
      },
    },
  };
}

/** What every request is answered by, as one value. */
export function activeProvider(
  providers: Providers,
): ProviderConfig & {id: ProviderId} {
  return {id: providers.active, ...providers.configs[providers.active]};
}

/* -------------------------------------------------------------------------- */
/* Appearance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The UI scale presets.
 *
 * Four steps rather than a slider: each one is a set of text and spacing tokens
 * in the stylesheet, so the choice is a name the CSS already understands rather
 * than a number the renderer has to interpolate into a variable.
 */
export const UI_SCALES = [
  'compact',
  'default',
  'comfortable',
  'large',
] as const;
export const uiScaleSchema = z.enum(UI_SCALES);
export type UiScale = z.infer<typeof uiScaleSchema>;

export const UI_SCALE_LABELS: Record<UiScale, string> = {
  compact: 'Compact',
  default: 'Default',
  comfortable: 'Comfortable',
  large: 'Large',
};

/**
 * The accent colour, as `#rrggbb`. The empty string means "whatever the
 * stylesheet says", so a user who never opens the picker keeps the design's own
 * blue and a future theme change is not fought by a stored value.
 *
 * Validated here rather than at the `input[type=color]` that writes it: the value
 * ends up in a CSS custom property, and the field is a text box in a JSON file a
 * user can edit.
 */
export const accentColorSchema = z.union([
  z.literal(''),
  z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour'),
]);

/**
 * How dark the window is behind the conversation, as a percentage.
 *
 * This is the alpha of the tint laid over the photograph, so it is the one
 * control that makes an arbitrary picture readable: the design's own tinting
 * assumes a picture of roughly the same brightness as the one it ships with, and
 * a bright or busy photograph needs more of it while a dark one needs less. The
 * value is the *centre* column's tint — the rails are always a fixed step darker,
 * which is what makes them read as panels — so 74 reproduces the design exactly
 * and 100 hides the picture altogether.
 *
 * An integer percentage rather than a 0–1 float: it is a slider position, it is
 * shown to the user as a number, and rounding is not something the renderer
 * should be deciding.
 */
export const DEFAULT_BACKGROUND_DARKNESS = 74;

/** The darkest the rails can get before the tint stops being a tint. */
export const BACKGROUND_DARKNESS_MAX = 100;

export const backgroundDarknessSchema = z
  .number()
  .int()
  .min(0)
  .max(BACKGROUND_DARKNESS_MAX);

/**
 * How the window decides its colours.
 *
 * `system` is the default and is not the same as "dark": it means the app has no
 * opinion and follows the OS, which can change while the app is running. The
 * resolved answer is reported separately in `AppInfo`, so a window never has to
 * guess which way `system` went.
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const;
export const themeModeSchema = z.enum(THEME_MODES);
export type ThemeMode = z.infer<typeof themeModeSchema>;

/** Which way the OS (or the user) actually went. */
export const themeSchema = z.enum(['light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;

export const appearanceSchema = z.object({
  /**
   * Light, dark, or whatever the machine is set to.
   *
   * A preference rather than a reading: `system` is the default and is resolved
   * against the OS at the moment it is drawn, so a machine that switches to dark
   * at sunset takes the window with it.
   */
  theme: themeModeSchema,
  /**
   * Imported background file name inside the app's backgrounds directory. Empty
   * means the picture shipped with the app.
   */
  background: z.string(),
  accent: accentColorSchema,
  uiScale: uiScaleSchema,
  backgroundDarkness: backgroundDarknessSchema,
});

export type Appearance = z.infer<typeof appearanceSchema>;
export const appearancePatchSchema = appearanceSchema.partial();

export function defaultAppearance(): Appearance {
  return {
    // Follows the machine until told otherwise, which is what most people want
    // and what a window should do before anybody has an opinion about it.
    theme: 'system',
    background: '',
    accent: '',
    uiScale: 'default',
    backgroundDarkness: DEFAULT_BACKGROUND_DARKNESS,
  };
}

/**
 * The custom scheme the renderer loads imported backgrounds through.
 *
 * Backgrounds live in the user-data directory, which the renderer cannot read:
 * it is sandboxed, and in development it is served from `http://localhost`, so a
 * `file://` URL would be blocked by both the origin and the CSP. A scheme of the
 * app's own is registered in the main process and allowed in `img-src`, so a
 * wallpaper is fetched the same way in development and in a packaged build.
 *
 * Both sides build the URL, so the literal lives here rather than in either one.
 */
export const BACKGROUND_SCHEME = 'marimo-asset';

/** `marimo-asset://background/<file>`, percent-encoded. */
export function backgroundUrl(name: string): string {
  return `${BACKGROUND_SCHEME}://background/${encodeURIComponent(name)}`;
}

/*
 * MCP server documents used to be declared here, as a stub with an `id`, a
 * `name`, an `enabled` flag and a transport. They now live in `./mcp.ts` with
 * the two things the stub could not express and the plan needs: a per-server
 * `trusted` flag, which is what decides whether that server's tools ask before
 * they run, and `headers`, which is the only way to authenticate against a
 * remote server at all.
 */

/**
 * What the settings file holds about Discord.
 *
 * The token is deliberately absent: it is a secret, it lives in the OS keychain
 * beside the API key, and the only fact this contract exposes about it is
 * `hasDiscordToken` on `PublicSettings`. Everything here is either a choice the
 * user made or a name Discord reported back, kept so the dialog can describe the
 * connection without a network round trip.
 */
export const discordSettingsSchema = z.object({
  /** Connect at launch and watch `channelId` for mentions of the bot. */
  enabled: z.boolean(),
  /** The channel the agent watches, and its default destination when sending. */
  channelId: z.string(),
  /** That channel's name, as Discord reports it, so the dialog can show it. */
  channelName: z.string(),
  /** The guild the channel is in, for the same reason. */
  guildName: z.string(),
  /**
   * Post the agent's answer back to the channel when it is mentioned.
   *
   * Off means a mention is still picked up — the agent runs and the conversation
   * appears in the sidebar — but nothing is posted on the user's behalf.
   */
  autoReply: z.boolean(),
  /** The bot's own account, learned when the token was verified. */
  botUserId: z.string(),
  botName: z.string(),
});

export type DiscordSettings = z.infer<typeof discordSettingsSchema>;

/** Discord is off until the user sets it up: a bot needs a token first. */
export function defaultDiscordSettings(): DiscordSettings {
  return {
    enabled: false,
    channelId: '',
    channelName: '',
    guildName: '',
    // Mentions are the whole point of connecting a bot, so answering them is the
    // default once the user turns the connection on.
    autoReply: true,
    botUserId: '',
    botName: '',
  };
}

/** The bot's own account, as `GET /users/@me` reports it. */
export interface DiscordBot {
  id: string;
  name: string;
}

/** One channel the bot may post to, flattened to what the picker needs. */
export interface DiscordChannel {
  id: string;
  name: string;
  /** Guild name; empty for a direct message channel. */
  guild: string;
}

/** One message, flattened to what the agent needs to read. */
export interface DiscordMessage {
  id: string;
  /** Display name of whoever wrote it. */
  author: string;
  content: string;
  createdAt: string;
  /** Whether the author is a bot, so the agent can tell its own posts apart. */
  bot: boolean;
}

/**
 * Whether the app is connected to Discord right now.
 *
 * Reported separately from the settings because it changes on its own: the
 * gateway drops, Discord refuses the token, the network goes away. `detail` is
 * what the dialog shows under the badge when the state is not `online`.
 */
export type DiscordConnectionState = 'off' | 'connecting' | 'online' | 'error';

export interface DiscordConnectionStatus {
  state: DiscordConnectionState;
  /** The bot's name once Discord has confirmed the token; empty before that. */
  botName: string;
  /** Why it is not online, when it is not. */
  detail: string;
}

/**
 * The size and position of the app window, as the last close left them.
 *
 * The bounds are not clamped here. A window is moved and resized by the window
 * manager, so the numbers that arrive are the OS's own and can legitimately
 * describe a display that is no longer attached; deciding what to do about that
 * needs to know about displays, which belongs to the process that owns the
 * window rather than to the settings file. This schema only refuses values that
 * cannot describe a window at all.
 */
export const windowStateSchema = z.object({
  width: z.number().int().min(200).max(20_000),
  height: z.number().int().min(200).max(20_000),
  /** Null means "no position to restore, let the OS place it". */
  x: z.number().int().min(-20_000).max(20_000).nullable(),
  y: z.number().int().min(-20_000).max(20_000).nullable(),
});

export type WindowState = z.infer<typeof windowStateSchema>;

/**
 * The size a first launch opens at, and the window's own bounds in the CSS
 * pixels Electron reports.
 *
 * `x`/`y` are null rather than a number so the first window is placed by the OS,
 * which is the only thing that knows what else is on the screen.
 */
export function defaultWindowState(): WindowState {
  return {width: 1180, height: 780, x: null, y: null};
}

/**
 * Settings are what applies to the app as a whole: how to reach the provider,
 * and the escape hatches. Anything about *an agent's* behaviour — who it is,
 * which folder it works in, which tools it may use — lives in a profile below,
 * because that is the unit the user switches between.
 */
export const settingsSchema = z.object({
  /**
   * Which model backend is live, and where each one lives.
   *
   * A block rather than two flat fields because every provider remembers its own
   * address and model: the pair used to be top-level `baseUrl`/`model`, which is
   * exactly the shape that cannot survive a second provider.
   */
  providers: providersSchema,
  /** Background, accent and text size: how the app looks, not what it does. */
  appearance: appearanceSchema,
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Opt-in escape hatch for `http_fetch` hitting loopback/private hosts. */
  allowPrivateNetworkFetch: z.boolean(),
  /**
   * Only consulted when the OS keychain is unavailable. Without it the app
   * refuses to write the API key to disk in plaintext.
   */
  allowPlaintextApiKey: z.boolean(),
  /**
   * The MCP servers this install knows about.
   *
   * Uniqueness is enforced here rather than on the entry schema because neither
   * rule is a property of one server — it takes the whole list to see a
   * duplicate name or a repeated id — and both are worth catching at the door: a
   * duplicated name would offer two sets of identically-named tools.
   */
  mcpServers: z.array(mcpServerSchema).superRefine((servers, context) => {
    for (const problem of mcpServersAreDistinct(servers)) {
      context.addIssue({
        code: 'custom',
        path: [problem.index, problem.field],
        message: problem.message,
      });
    }
  }),
  /**
   * The Discord bot. Here rather than on a profile because there is one token,
   * one gateway connection and one watched channel for the whole app; whether an
   * agent may *use* Discord is a tool checkbox, like every other tool.
   */
  discord: discordSettingsSchema,
  /**
   * How wide the two rails are, in pixels. Clamped here rather than trusted: a
   * width is dragged, and a drag can end anywhere including off the screen, so
   * the bounds belong to the contract rather than to the drag handler.
   */
  sidebarWidth: z.number().int().min(200).max(560),
  todosWidth: z.number().int().min(200).max(560),
  /** The jobs rail's width. Separate from `todosWidth` so each is remembered. */
  jobsWidth: z.number().int().min(200).max(560),
  /** Notes and Files have their own widths for the same reason. */
  notesWidth: z.number().int().min(200).max(560),
  filesWidth: z.number().int().min(200).max(560),
  /**
   * Whether the Files rail is open.
   *
   * The to-do and jobs rails keep this in their own documents, because each of
   * those *is* a document. The file tree is a view of whatever the active
   * workspace happens to hold, so there is nothing of its own to keep it beside
   * and it lives here with the rest of the layout.
   */
  filesOpen: z.boolean(),
  /**
   * The settings dialog's sections the user has folded away, by title.
   *
   * Layout state, like the widths above, and here for the same reason: a dialog
   * five sections deep is one the user collapses to get to the section they came
   * for, and having to do that again on every launch is the annoyance the folding
   * was meant to remove.
   *
   * Free-form strings rather than an enum of the sections, because the sections
   * are the renderer's business and this is a list of names it no longer cares
   * about — a renamed section simply loses its folded state instead of failing to
   * load, and adding one needs no protocol change. `.catch` for the same
   * forgivingness: this is a flat field, so without it a hand-edited file holding
   * something that is not an array would fail the whole settings schema and cost
   * the user every other setting they had.
   */
  collapsedSections: z.array(z.string()).catch([]),
  /**
   * Where the window last was, so it opens where the user left it.
   *
   * A block rather than four flat fields because the four only mean anything
   * together: a width without a height is not a window, and a position whose
   * monitor is gone has to be considered with the size to decide whether any of
   * the window would still be on screen.
   *
   * `x` and `y` are nullable and default to null, which is "let the OS place it"
   * — a fresh install has no position to restore, and neither has one whose
   * display was unplugged since.
   */
  window: windowStateSchema,
});

/**
 * A patch of the Discord block: any subset of it, merged over what is stored.
 *
 * `settingsSchema.partial()` alone would make the whole block optional but still
 * require every field inside it, so flipping one switch would mean sending the
 * token, the channel name and the bot's name back — and a stale window's copy of
 * those is exactly what must not win. The store merges this over the stored
 * block for the same reason.
 */
export const discordSettingsPatchSchema = discordSettingsSchema.partial();

export const settingsPatchSchema = settingsSchema.partial().extend({
  discord: discordSettingsPatchSchema.optional(),
  providers: providersPatchSchema.optional(),
  appearance: appearancePatchSchema.optional(),
});

/**
 * What the settings file actually holds: the user's choices plus state derived
 * from the provider.
 *
 * Kept separate from `Settings` so the renderer can never write
 * `availableModels` — it is a report from the provider, not a preference, and a
 * stale renderer must not be able to overwrite it with a guess.
 *
 * One list per provider, because the lists are answers about a *specific*
 * endpoint: remembering DeepSeek's while the app is pointed at a llama.cpp server
 * would offer the user models that server has never heard of.
 */
export const storedSettingsSchema = settingsSchema.extend({
  availableModels: z.record(providerIdSchema, z.array(z.string())),
});

/*
 * `McpServer` and `McpTransport` are inferred in `./mcp.ts` and re-exported
 * above, rather than declared here as they used to be. Two ways to name one
 * shape is two ways for them to disagree, and the settings schema below is what
 * makes the shape load-bearing.
 */
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type StoredSettings = z.infer<typeof storedSettingsSchema>;

/* -------------------------------------------------------------------------- */
/* Agent profiles and workspaces                                               */
/* -------------------------------------------------------------------------- */

/**
 * A folder the agent may work in. `name` is the user's label for it; `path` is
 * the real directory, and it is the confinement root for every file tool and for
 * shell commands.
 */
export const workspaceSchema = z.object({
  id: z.string().min(1),
  // Trimmed: a blank label would be persisted, fail the schema on the next read,
  // and take the whole profile down with it.
  name: z.string().trim().min(1),
  path: z.string().min(1),
});

/**
 * An agent: its identity (the system prompt), the folders it knows about, and
 * the tools and skills it is allowed to use. Switching profile is what makes the
 * app feel like a different agent, so each one also owns its conversations.
 */
export const agentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  /** The system prompt, presented to the user as the agent's identity. */
  identity: z.string(),
  workspaces: z.array(workspaceSchema),
  /** Folder this profile is currently working in; null until one is added. */
  activeWorkspaceId: z.string().nullable(),
  /** Tool names this profile may use, from `profiles.catalog`. */
  enabledTools: z.array(z.string()),
  /** Skill names this profile carries, from `profiles.catalog`. */
  enabledSkills: z.array(z.string()),
});

export const profilePatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  identity: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  enabledSkills: z.array(z.string()).optional(),
});

/** One entry in the pick-lists Settings renders, reported by the agent. */
export interface CatalogEntry {
  name: string;
  description: string;
}

export type Workspace = z.infer<typeof workspaceSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/**
 * A skill the user created, rather than one the app ships.
 *
 * The shape is the agent package's `Skill` — name, description, instructions —
 * with an id and a timestamp, because unlike the built-in skills these are the
 * user's data: they are listed in Settings, they can be deleted, and one saved
 * under a name that already exists replaces it.
 *
 * `instructions` is the whole point and is stored verbatim: it is prompt text,
 * so anything that trimmed or reformatted it would be changing the agent's
 * behaviour rather than its file.
 */
export const storedSkillSchema = z.object({
  id: z.string().min(1),
  /** Kebab-case, and what a profile's `enabledSkills` names it by. */
  name: z.string().trim().min(1),
  /** One line, for the pick-list in Settings. */
  description: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  createdAt: z.string().min(1),
});

export type StoredSkill = z.infer<typeof storedSkillSchema>;

/**
 * The longest set of instructions worth carrying in every request.
 *
 * Here rather than in the agent package because two sides need it and only one
 * of them may import that package: `save_skill` refuses an over-long skill, and
 * the Settings editor has to say the same number while the user is typing. A
 * limit enforced on one path and not the other would mean the window could write
 * a skill the tool would have refused.
 */
export const SKILL_INSTRUCTIONS_MAX = 8_000;

/** What a skill is written from, on either path into `skills.json`. */
export const skillDraftSchema = storedSkillSchema.pick({
  name: true,
  description: true,
  instructions: true,
});

export type SkillDraft = z.infer<typeof skillDraftSchema>;

export const skillsFileSchema = z.object({
  version: z.literal(1),
  skills: z.array(storedSkillSchema),
});

export type SkillsFile = z.infer<typeof skillsFileSchema>;

export function emptySkillsFile(): SkillsFile {
  return {version: 1, skills: []};
}

/**
 * What the renderer is allowed to see. The API key itself never crosses the
 * IPC boundary; `hasApiKey` and `encryptionAvailable` are the only facts the
 * settings screen needs to describe its own state.
 */
export type PublicSettings = Settings & {
  /**
   * Whether the app can reach the *active* provider right now: either a key is
   * stored, or the provider does not need one. This is the fact the chat window
   * turns into "add a key" copy, so it follows the picker rather than DeepSeek.
   */
  hasApiKey: boolean;
  /**
   * Which providers have a key on file. One file per provider in the keychain,
   * so switching provider does not mean re-entering the previous key.
   */
  providerKeys: Record<ProviderId, boolean>;
  /**
   * Whether this machine can encrypt a secret at rest.
   *
   * The window needs it to explain the plain-text choice honestly: on a machine
   * with no keychain there is no encryption to give up, and the warning should
   * say so rather than reading as a scare.
   */
  encryptionAvailable: boolean;
  /** What the active provider reported, or the placeholder list before it has. */
  availableModels: string[];
  profiles: AgentProfile[];
  activeProfileId: string;
  /** Where an agent with no folder of its own would work. */
  defaultWorkspace: string;
};

/* -------------------------------------------------------------------------- */
/* Sessions and transcripts                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a conversation came from, when it was not started at the keyboard.
 *
 * There is one source today and it is the reason the field exists: a Discord
 * mention runs a turn the user did not type, and the sidebar files those under
 * their own heading instead of under a folder. Where the files are and where the
 * conversation came from are different questions, and a conversation that
 * arrives on its own should not be buried inside a folder that had nothing to do
 * with it.
 */
export type SessionSource = 'discord';

export interface SessionSummary {
  /**
   * The conversation's own id, and the only name for it that never changes.
   *
   * A UUID assigned when the conversation is created, shown and copyable from
   * its `…` menu: it is what a job, a Discord mention and an on-disk file all
   * refer to, and unlike the title it is not something anyone edits.
   */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /**
   * Model chosen for this conversation. Absent means "follow the current
   * default", so changing the default in Settings also moves conversations
   * that never picked one.
   */
  model?: string;
  /**
   * Folder this conversation was started in, recorded once when it is created.
   * The sidebar nests a conversation under the workspace it belongs to.
   *
   * Absent for conversations that predate workspaces, and deliberately left
   * dangling when a folder is removed: such a chat is still listed, under
   * "Other chats", rather than vanishing with the folder.
   */
  workspaceId?: string;
  /**
   * Set when the app, rather than the user, started the conversation — a Discord
   * mention, today. Such a conversation is listed under its source's own section
   * and never under a folder, whatever `workspaceId` happens to say.
   */
  source?: SessionSource;
}

export interface ToolCallRecord {
  callId: string;
  tool: string;
  args: unknown;
  result?: string;
  ok?: boolean;
}

export type TranscriptRole = 'user' | 'assistant';

/**
 * The name the main agent is built under, and therefore the `author` on its
 * events.
 *
 * One value in one place because two things depend on it agreeing with itself:
 * the agent is constructed under this name, and the transcript decides whether a
 * message came from a helper by asking whether its author is *not* this. A
 * second literal would not fail; it would silently attribute the agent's own
 * words to a helper called "marimo".
 */
export const MAIN_AGENT_NAME = 'marimo';

export interface TranscriptMessage {
  id: string;
  role: TranscriptRole;
  /**
   * The helper agent that wrote this, when one did.
   *
   * A sub-agent runs in the parent's conversation — it has to, because that is
   * where its approval requests have to be visible — so without this its words
   * and the parent's would merge into one bubble and read as a single answer
   * from one mind.
   */
  subagent?: string;
  text: string;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  createdAt: string;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* To-dos                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One item on the to-do list.
 *
 * `text` is trimmed and non-empty as a contract: the panel has no way to render
 * a blank row, so an empty item is refused at the boundary instead of being
 * stored and shown as a gap the user cannot explain.
 */
export const todoItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  done: z.boolean(),
  createdAt: z.string().min(1),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * The list, which is also the whole document on disk.
 *
 * Sent and stored as one value rather than as per-item calls: the list is small,
 * the editing rules live in one place, and replacing it wholesale means there is
 * no way for the window and the file to disagree about what an edit did.
 */
export const todosSchema = z
  .object({
    /** In the order they were added; the pinned item is not reordered here. */
    items: z.array(todoItemSchema),
    /** The item currently picked out at the top of the panel, if any. */
    activeId: z.string().nullable(),
    /** Whether the panel is open. Part of the document so the layout sticks. */
    open: z.boolean(),
  })
  // A pin pointing at nothing would render as a highlight with no item under it,
  // so the tie between the two fields is enforced rather than tolerated.
  .refine(
    (todos) =>
      todos.activeId === null ||
      todos.items.some((item) => item.id === todos.activeId),
    {message: 'activeId must name an item on the list'},
  );

export type Todos = z.infer<typeof todosSchema>;

/**
 * The list as it is stored: a version beside it, so the file format can change
 * without the list's own schema having to carry the version.
 *
 * It lives here rather than in the store because `zod` belongs to this package;
 * the main process reads the file through this schema.
 */
export const todosFileSchema = z.object({
  version: z.literal(1),
  todos: todosSchema,
});

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One note: a scrap of text the user means to paste somewhere.
 *
 * Deliberately as small as a to-do item minus the checkbox — there is nothing to
 * tick off and nothing to schedule, so a note is its text and when it was
 * written. Blank text is refused here for the same reason it is on a to-do: the
 * rail has no way to draw a row with nothing in it.
 */
export const noteItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  createdAt: z.string().min(1),
});

export type NoteItem = z.infer<typeof noteItemSchema>;

/**
 * The notes, and whether their rail is open — the same shape as the to-do list,
 * down to the view state travelling in the document, so closing and reopening
 * the window comes back to the rail the user left open.
 */
export const notesSchema = z.object({
  /** In the order they were written. */
  items: z.array(noteItemSchema),
  open: z.boolean(),
});

export type Notes = z.infer<typeof notesSchema>;

export const notesFileSchema = z.object({
  version: z.literal(1),
  notes: notesSchema,
});

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What one entry in a folder is.
 *
 * `link` is its own kind rather than being folded into whichever target it
 * points at: the app resolves nothing through a symlink, because a link is the
 * one way a listing inside a workspace could describe a file outside it.
 */
export const fileEntryKindSchema = z.enum(['directory', 'file', 'link']);

export type FileEntryKind = z.infer<typeof fileEntryKindSchema>;

export const fileEntrySchema = z.object({
  name: z.string().min(1),
  kind: fileEntryKindSchema,
  /** Bytes. Zero for a directory, and for a link, whose target is not read. */
  size: z.number().int().nonnegative(),
  /** When it was last written, ISO, or `null` if that could not be read. */
  modifiedAt: z.string().nullable(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

/**
 * One folder of the active workspace, as the Files rail shows it.
 *
 * Both the root and the folder being listed travel back, because the window
 * never sends a path it made up: it asks for a folder *relative to the
 * workspace* and is told what that resolved to. `relative` is the same path
 * normalized — `''` at the root — which is what the breadcrumb is built from.
 */
export const fileListingSchema = z.object({
  /** Absolute path of the workspace root. */
  root: z.string().min(1),
  /** Absolute path of the folder being listed. */
  path: z.string().min(1),
  /** `path` relative to `root`, normalized: `''` names the root itself. */
  relative: z.string(),
  entries: z.array(fileEntrySchema),
  /** True when the folder held more entries than one listing carries. */
  truncated: z.boolean(),
});

export type FileListing = z.infer<typeof fileListingSchema>;

/**
 * How many entries one listing carries.
 *
 * A folder can hold hundreds of thousands of names, and the rail is a list a
 * person scrolls: past this the tail is dropped and the panel says so, which is
 * more honest than a window that appears to hang.
 */
export const FILE_LISTING_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* Jobs                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One time a job runs, as a five-field cron expression.
 *
 * Validated here rather than at the scheduler: the two writers are the agent's
 * own tools and the IPC boundary, and a schedule the runner cannot evaluate must
 * not become a document on disk. `parseCron` is the same parser the scheduler
 * uses, so "accepted" and "will run" cannot drift apart.
 */
export const jobScheduleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => parseCron(value) !== null, {
    message: 'Not a 5-field cron expression',
  });

/**
 * How a job last went, for the badge on its card.
 *
 * `busy` is the one that is not an outcome: a job that came due while the agent
 * was already answering something else is not lost, it is deferred, and saying
 * so is more honest than an error.
 */
export const jobStatusSchema = z.enum([
  'ok',
  'error',
  'aborted',
  'busy',
  'awaiting-approval',
  'chatting',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * A scheduled job: what to do, when, and where the conversation about it lives.
 *
 * `sessionId` is the thing that makes a job editable. It is nullable because the
 * conversation can be deleted from the sidebar while the job survives; the run
 * then starts a fresh one under the job's name rather than failing.
 */
export const jobSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  /** The instruction the job runs. Empty is allowed; the name is the prompt then. */
  description: z.string(),
  /** One or more cron expressions, in local time. */
  schedules: z.array(jobScheduleSchema).min(1).max(5),
  enabled: z.boolean(),
  /** The agent that owns this job and is the one that runs it. */
  profileId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  lastRunAt: z.string().min(1).optional(),
  lastStatus: jobStatusSchema.optional(),
  lastError: z.string().optional(),
  /** The next time it will run, computed by the main process; absent when paused. */
  nextRunAt: z.string().min(1).optional(),
  /**
   * The occurrence the scheduler is watching, moved on once it has been dealt
   * with.
   *
   * `nextRunAt` is always in the future — it is what the card promises — so it
   * cannot also be the moment that says "this one is now due". This is that
   * moment: the most recent occurrence the schedule named. A job is due when it
   * has passed, and dealing with it moves it on to the next one, which is what
   * keeps a daily job from firing once a minute all day.
   *
   * "Dealt with" means run, failed, or dropped for being too late to run at all.
   * It does not mean deferred: a job the agent was too busy to take keeps this
   * marker where it is, so the run happens as soon as the agent is free rather
   * than at the next scheduled time.
   */
  dueAt: z.string().min(1).optional(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * What may be changed about a job from outside the owner.
 *
 * A patch rather than the whole job, deliberately: `lastRunAt`, `lastStatus` and
 * `nextRunAt` belong to the scheduler, and `profileId`/`sessionId` are what tie
 * a job to an agent and a conversation. A stale window can rename a job, change
 * its times, or pause it — and cannot do anything else.
 */
export const jobPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  schedules: z.array(jobScheduleSchema).min(1).max(5).optional(),
  enabled: z.boolean().optional(),
});

export type JobPatch = z.infer<typeof jobPatchSchema>;

/**
 * The whole jobs document, which is also what `jobs.json` holds.
 *
 * One document rather than per-job files: the list is small, the panel shows all
 * of it at once, and every mutation answers with the new document, so the window
 * and the file cannot disagree about what a change did.
 */
export const jobsSchema = z.object({
  jobs: z.array(jobSchema),
  /** Whether the rail is open. Part of the document so the layout sticks. */
  open: z.boolean(),
  /**
   * The job whose conversation is showing, if any.
   *
   * In the document rather than in the window because it is a view the user can
   * leave and come back to: reopening the rail should return to the job they
   * were editing, not to the list. A stale id — the job was deleted — means
   * "list", which the panel reads as no card expanded.
   */
  openJobId: z.string().min(1).nullable(),
});

export type Jobs = z.infer<typeof jobsSchema>;

/** A fresh document. Closed: a rail the user asked for is a rail they open. */
export function emptyJobs(): Jobs {
  return {jobs: [], open: false, openJobId: null};
}

export const jobsFileSchema = z.object({
  version: z.literal(1),
  jobs: jobsSchema,
});

/* -------------------------------------------------------------------------- */
/* Calls: renderer -> main                                                     */
/* -------------------------------------------------------------------------- */

/*
 * The call table for this app is `agentCallSchemas`, further down, with its
 * results in `AgentCallResults` and the bridge in `AgentBridge`.
 *
 * There used to be a second, larger table here — the full surface of the
 * project this app was extracted from, some hundred methods nothing
 * implemented. It was carried along by the vendoring and never trimmed, and it
 * was actively misleading: `settings.get` looked like a call that existed, and
 * the profile calls answered a different shape from the ones that do. A
 * contract that describes a program nobody wrote is worse than no contract.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AgentUiEvent =
  | {type: 'turn.started'; sessionId: string; messageId: string}
  | {type: 'text.delta'; sessionId: string; messageId: string; text: string}
  | {
      type: 'reasoning.delta';
      sessionId: string;
      messageId: string;
      text: string;
    }
  | {
      type: 'tool.started';
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      args: unknown;
    }
  | {
      type: 'tool.finished';
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      ok: boolean;
      result: string;
    }
  | {
      type: 'approval.request';
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      args: unknown;
      hint: string;
    }
  | {
      type: 'turn.completed';
      sessionId: string;
      messageId: string;
      usage?: TokenUsage;
    }
  | {type: 'turn.aborted'; sessionId: string; messageId: string}
  | {
      type: 'turn.failed';
      sessionId: string;
      messageId: string;
      code?: string;
      message: string;
    }
  | {type: 'session.changed'; sessionId: string}
  /**
   * The Discord connection changed state on its own: it connected, dropped, or
   * was refused. Carries the whole status rather than a diff, because the dialog
   * draws a badge from it and has nothing to reconcile.
   */
  | {type: 'discord.status'; status: DiscordConnectionStatus}
  /**
   * A job was created, edited, ran, or deleted.
   *
   * Carries the id rather than the job: the panel reloads the whole document,
   * which is one call and cannot leave it showing half of two versions.
   */
  | {type: 'job.changed'; jobId: string}
  /**
   * The agent wrote to the to-do list or the notes through its own tools.
   *
   * The rail is showing the copy that was just replaced, and — worse — the
   * renderer's copy is what the *next* edit is computed from, so a rail that did
   * not reload would write the agent's change away on the user's next click.
   * There is no id to carry: the document is small and is reloaded whole.
   */
  | {type: 'todos.changed'}
  | {type: 'notes.changed'}
  /**
   * The agent saved a skill through `/learn`.
   *
   * The catalogue is read once when Settings opens, so without this a skill the
   * user just made would be missing from the pick-list until the next launch —
   * which is precisely the moment they are most likely to go looking for it.
   */
  | {type: 'skills.changed'}
  /**
   * The active profile or workspace changed, so what the window is looking at is
   * no longer what the agent would answer as. The renderer reloads its session
   * list on `profile` (conversations are per profile) and drops the turn in
   * flight on either.
   */
  | {type: 'scope.changed'; scope: 'profile' | 'workspace'}
  /**
   * An MCP server changed state on its own: it connected, dropped, or was
   * refused. Carries the whole status rather than a diff, because the badge is
   * drawn from it and there is nothing to reconcile.
   */
  | {type: 'mcp.status'; serverId: string; status: McpStatus}
  /*
   * The tray asking the window to open Settings.
   *
   * A message rather than a navigation the main process performs, because the
   * window owns what it is looking at — and a process that reached in and
   * changed the view would be a second place that decides.
   */
  | {type: 'window.openSettings'}
  /*
   * The theme preference changed.
   *
   * An event as well as a field on `AppInfo`, because it changes without the
   * window asking — a second window, or a settings write from anywhere — and a
   * window that had to re-ask would be one that only notices on reload.
   */
  | {type: 'theme.changed'; mode: ThemeMode}
  /*
   * A helper agent, while it runs.
   *
   * Three events rather than a nested `AgentUiEvent`, deliberately. A child's
   * work is a *tool call* from the parent's point of view, and the window draws
   * it as one: a labelled group that opens, streams what the helper is saying,
   * and closes with how it went. Nesting a whole event union inside another
   * would mean every future variant being legal in two places, and the window
   * having to be right about both.
   */
  | {type: 'subagent.started'; sessionId: string; callId: string; name: string; task: string}
  | {type: 'subagent.event'; sessionId: string; callId: string; name: string; text: string}
  | {
      type: 'subagent.finished';
      sessionId: string;
      callId: string;
      name: string;
      ok: boolean;
      ms: number;
      error?: string;
    };

export const IPC_CALL_CHANNEL = 'marimo:call';
export const IPC_EVENT_CHANNEL = 'marimo:event';

/** Shape of an error result returned by the main-process dispatcher. */
export interface IpcErrorResult {
  ok: false;
  error: string;
}

/* -------------------------------------------------------------------------- */
/* Marimo Agent's own surface                                                  */
/* -------------------------------------------------------------------------- */
/*
 * The block above is the contract Marimo Desktop grew, kept because the agent
 * package still refers to its vocabulary (`AgentProfile`, `Job`, `ProviderId`).
 * This block is Marimo Agent's own surface, and it starts deliberately small:
 * a call is added here when the feature behind it lands, so the contract is a
 * description of what the app does rather than a wish list. The entries above
 * that this app will not implement are pruned as their replacements arrive.
 */

/**
 * A gate a conversation is still waiting on.
 *
 * A wire shape rather than an agent-internal one, because it is exactly what a
 * card is drawn from and a card outlives the process that raised it: the window
 * asks for the pending gates of whatever conversation it is showing, and gets
 * them from the event log rather than from memory.
 */
export const pendingGateSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
  hint: z.string(),
  /**
   * When the question was asked, so a card can say how long it has waited.
   *
   * There is deliberately no expiry: a desktop agent's user may be away for
   * hours, and a gate that lapsed while they were out would silently throw away
   * the work they asked for.
   */
  askedAt: z.string(),
});

export type PendingGate = z.infer<typeof pendingGateSchema>;

/**
 * What the window needs to describe this install.
 *
 * Versions and paths are here rather than assembled in the renderer because the
 * renderer cannot know them: it has no `process`, no `app`, and no business
 * reading either.
 */
/**
 * Whether jobs run while the app is closed.
 *
 * Three facts rather than one boolean, because each has a different remedy and a
 * single "off" would leave the user guessing which one they have.
 */
export interface ServiceStatus {
  /** Whether the OS is set up to wake the runner. */
  installed: boolean;
  /**
   * Whether the keys this install holds could be read by a process with no
   * keychain.
   *
   * The runner has no `safeStorage`, so an encrypted key is one it cannot
   * decrypt. False here means a background run would start, refuse for want of a
   * key, and record that — every time, unattended, with nobody watching. Worth
   * knowing *before* switching it on rather than after.
   */
  keysReadable: boolean;
  /** The definition's location, shown so a user can go and look. */
  definitionPath: string;
}

export interface AppInfo {
  /** The product name, which is also the user-data directory's name. */
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  /**
   * `process.platform`: `'linux'`, `'darwin'`, `'win32'` and so on.
   *
   * A plain string rather than `NodeJS.Platform`, because this package is also
   * read by the renderer and carries no Node types on purpose — importing them
   * here to name one field would put Node's whole ambient surface in scope for
   * every file in the contract.
   */
  platform: string;
  /**
   * Where conversations, jobs and secrets live.
   *
   * Shown in Settings, and the thing to ask for in a bug report: the headless
   * runner has to resolve this same directory for itself, so a disagreement
   * between the two is a real and otherwise invisible failure.
   */
  userData: string;
  /**
   * Whether an OS keychain is available to encrypt secrets.
   *
   * False is not an error. It is what makes "run jobs while the app is closed"
   * need the plain-text opt-in, so the window has to know before it offers the
   * toggle.
   */
  secretsEncrypted: boolean;
  /**
   * Something wrong that the user has to know about but that has not stopped
   * the app working.
   *
   * A place for the failures whose only symptom is a feature quietly not doing
   * anything — the app and the job runner disagreeing about where the data lives
   * is the one that exists today. A console line is not enough for those: in a
   * packaged app nobody has a console, and the evidence otherwise is a scheduled
   * job that never fires and no reason given.
   */
  warning?: string;
  /** The mode the user chose. */
  themeMode: ThemeMode;
  /** Which way that resolved, right now. */
  theme: Theme;
}

/**
 * The calls this app's window can make.
 *
 * Kept as a map of zod schemas so the main process validates every inbound call
 * at one door, and the renderer gets the same shapes as types. A method absent
 * from here is not callable at all.
 */
export const agentCallSchemas = {
  'app.info': z.object({}),

  /* The agents this install has. */
  'profiles.list': z.object({}),

  /* Conversations. */
  'sessions.list': z.object({profileId: z.string().min(1).optional()}),
  'sessions.create': z.object({profileId: z.string().min(1)}),
  'sessions.get': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),

  /*
   * A turn. The call returns as soon as the turn is *accepted*; the answer
   * arrives as `AgentUiEvent`s on the event channel, because a turn is a stream
   * and an `invoke` is not.
   */
  'chat.send': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  }),
  'chat.approve': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    confirmed: z.boolean(),
  }),
  'chat.abort': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),

  /* What the agent can reach right now. */
  'mcp.statuses': z.object({}),
  /*
   * Connectors.
   *
   * Separate calls from `settings.set` rather than a settings patch, because
   * adding a server has to *dial* it: the write and the connection are one
   * action from the user's point of view, and a window that saved the file and
   * left the server unconnected would report success for something that did not
   * happen.
   */
  'mcp.set': z.object({server: mcpServerSchema}),
  'mcp.remove': z.object({serverId: z.string().min(1)}),
  /*
   * Dials a server without saving it, so somebody can find out that a command is
   * wrong before they commit to it.
   */
  'mcp.test': z.object({server: mcpServerSchema}),

  /*
   * The floating companion.
   *
   * `pointer` is how the window knows where it is *not*: it is a fixed rectangle
   * over whatever the user is working in, and without this it would swallow every
   * click on the things behind it.
   */
  'companion.status': z.object({}),
  'companion.setVisible': z.object({visible: z.boolean()}),
  'companion.pointer': z.object({over: z.boolean()}),

  /* Whether jobs run while the app is closed. */
  'service.status': z.object({}),
  'service.enable': z.object({}),
  'service.disable': z.object({}),

  /* What this agent is allowed to do, and what it is. */
  'profiles.catalog': z.object({}),
  'profiles.update': z.object({
    profileId: z.string().min(1),
    patch: profilePatchSchema,
  }),
  'profiles.create': z.object({
    name: z.string().trim().min(1).optional(),
  }),
  'profiles.select': z.object({profileId: z.string().min(1)}),

  /* Preferences, including the two that decide whether hidden jobs can run. */
  'settings.get': z.object({}),
  'settings.set': z.object({patch: settingsPatchSchema}),
  /*
   * Stored separately from the rest of settings because it is a secret: written
   * through the same store the agent reads, never returned, and reported back as
   * a boolean.
   */
  'settings.setApiKey': z.object({
    apiKey: z.string(),
    provider: providerIdSchema.optional(),
  }),
} as const;

export type AgentCallMethod = keyof typeof agentCallSchemas;
export type AgentCallParams<M extends AgentCallMethod> = z.infer<
  (typeof agentCallSchemas)[M]
>;

/** What each call answers with. */
export interface AgentCallResults {
  'app.info': AppInfo;
  'profiles.list': {profiles: AgentProfile[]; activeProfileId: string};
  'sessions.list': {sessions: SessionSummary[]};
  'sessions.create': {session: SessionSummary};
  'sessions.get': {
    messages: TranscriptMessage[];
    pending: PendingGate[];
  };
  /** Accepted, not finished: the turn itself arrives on the event channel. */
  'chat.send': {accepted: boolean};
  'chat.approve': {accepted: boolean};
  'chat.abort': {aborted: boolean};
  'mcp.statuses': Record<string, McpStatus>;
  'mcp.set': {servers: McpServer[]; statuses: Record<string, McpStatus>};
  'mcp.remove': {servers: McpServer[]; statuses: Record<string, McpStatus>};
  'mcp.test': {ok: boolean; detail: string};
  'companion.status': {visible: boolean};
  'companion.setVisible': {visible: boolean};
  'companion.pointer': {ok: boolean};
  'service.status': ServiceStatus;
  'service.enable': ServiceChange;
  'service.disable': ServiceChange;
  'profiles.catalog': ProfileCatalog;
  'profiles.update': {profiles: AgentProfile[]; activeProfileId: string};
  'profiles.create': {profiles: AgentProfile[]; activeProfileId: string};
  'profiles.select': {profiles: AgentProfile[]; activeProfileId: string};
  'settings.get': {settings: PublicSettings};
  'settings.set': {settings: PublicSettings};
  'settings.setApiKey': {settings: PublicSettings};
}

/**
 * What this install can offer, so a pick-list can be built from what exists
 * rather than from a list somebody typed out twice.
 */
export interface ProfileCatalog {
  tools: CatalogTool[];
  skills: CatalogEntry[];
}

/** One tool as the settings screen offers it. */
export interface CatalogTool extends CatalogEntry {
  /**
   * What this tool does, said to the person deciding rather than to the model.
   *
   * `description` above is the text the model is given, and it is written for a
   * reader that already knows what a system prompt is. This is the same fact for
   * somebody who has never seen an agent's tool list, and the two are kept apart
   * because rewriting one for the other would make it worse at its own job.
   */
  blurb: string;
  /**
   * Whether a brand-new agent is granted it.
   *
   * The settings screen groups by this and nothing else, because it is the one
   * fact about a tool that cannot be wrong: it is the same value the grant is
   * computed from. An earlier version classified tools as "looking" or "acting"
   * from a hand-written list of names, and the list had already drifted from the
   * tools it described.
   */
  byDefault: boolean;
}

/**
 * The result of asking the OS to start or stop waking the runner.
 *
 * Failures are listed rather than thrown, so a partly-successful install can say
 * which step refused — which is the difference between "it did not work" and
 * "loginctl needs root, everything else is in place".
 */
export interface ServiceChange {
  installed: boolean;
  /** Steps that failed and did not matter. */
  notes: string[];
  /** Steps that failed and did. */
  failures: Array<{what: string; detail: string}>;
}

/**
 * How an MCP server is doing, as the window draws it.
 *
 * Structurally the manager's own status type — declared here because the window
 * reads it and the manager writes it, and two shapes for one badge is two
 * shapes that can disagree.
 */
export interface McpStatus {
  state: 'off' | 'connecting' | 'online' | 'error';
  /** One sentence, shown under the server's name. */
  detail: string;
  toolCount: number;
}

/**
 * The preload bridge, as the renderer sees it.
 *
 * `window.marimo` is the whole of the window's reach: no filesystem, no shell,
 * no unvalidated IPC. A sandboxed preload cannot import this module at runtime
 * (it is ESM and the preload is CommonJS), so it repeats the channel names and
 * `apps/desktop/tests/preload-channels.test.ts` asserts they still match.
 */
export interface AgentBridge {
  call<M extends AgentCallMethod>(
    method: M,
    params: AgentCallParams<M>,
  ): Promise<AgentCallResults[M]>;
  onEvent(listener: (event: AgentUiEvent) => void): () => void;
}
