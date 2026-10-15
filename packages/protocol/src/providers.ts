/**
 * The model backends this app can talk to, and how to ask one what it serves.
 *
 * Every provider here speaks the OpenAI chat-completions dialect, so one
 * transport serves them all and switching provider is a base URL, a key and a
 * model id rather than a second client. Gemini, OpenRouter and OpenCode's Go
 * gateway are reached through an OpenAI-compatibility layer rather than a vendor
 * client for exactly that reason: one code path to test, and one place where tool
 * calls are translated.
 *
 * This is the same catalogue the dashboard app carries, deliberately: the two
 * apps offer the same providers under the same names with the same fallbacks, so
 * a user who has learned one has learned the other. The descriptors were ported
 * in both directions — this file's shape is the dashboard's `providers.py` — and
 * the ids are the ones this app's settings files and key files already name.
 *
 * Four flags are facts about an *endpoint* rather than preferences, so they
 * travel with the provider id and the transport stays free of `if (provider ===
 * ...)`:
 *
 * - `reasoningChannel` — whether thinking arrives as a `reasoning_content`
 *   delta. Sending or reading a field the endpoint does not know is not cosmetic:
 *   Gemini's layer answers an unsupported field with an error rather than
 *   ignoring it.
 * - `usageInStream` — whether `stream_options.include_usage` may be sent. Left
 *   off for Gemini, where it fails every turn; the cost there is a quiet token
 *   badge rather than a broken chat.
 * - `sessionHeader` — the header a gateway asks a conversation to identify
 *   itself with, for routing and for a prompt cache it keeps per conversation.
 *   Sent with the session id the caller supplies, and omitted entirely when it
 *   has none.
 * - `requiresApiKey` — false for a server on this machine or the LAN, which
 *   usually takes no key at all.
 *
 * The app runs no backend of its own. It used to: a llama.cpp engine it
 * downloaded, supervised and addressed on loopback, which was what a fresh
 * install answered with. That is gone, and the honest consequence is in the UI
 * rather than hidden here — a fresh install cannot answer until somebody points
 * it at one of these. `llamacpp` is the provider that keeps the promise the
 * built-in one made: with a server on your own machine, nothing you type leaves
 * it.
 */
import {z} from 'zod';

/**
 * The catalogue, in the order the picker draws it.
 *
 * Alphabetical by label, and that ordering is load-bearing rather than cosmetic:
 * this array is what the picker iterates and a test holds it sorted, because a
 * menu whose order changes between builds is a menu somebody has to re-read
 * every time.
 *
 * `deepseek` is first and is also the default for a fresh install — the two
 * facts are independent, and `DEFAULT_PROVIDER_ID` is where the second one
 * lives. A default taken from `PROVIDER_IDS[0]` would move the day somebody
 * sorted the list.
 */
export const PROVIDER_IDS = [
  'deepseek',
  'gemini',
  'llamacpp',
  'opencode_go',
  'openrouter',
] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** The provider a fresh install is pointed at. See `PROVIDER_IDS`. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'deepseek';

/**
 * How a provider's key is stored on disk.
 *
 * `keychain` is the default and the only thing the app writes unless it is asked
 * otherwise: the OS keychain encrypts it at rest, and a machine without one is
 * refused rather than written to in the clear. `plaintext` exists for exactly one
 * case — the headless job runner has no `app` object and therefore no keychain,
 * so a scheduled job on a hosted provider has no way to read a key that is
 * encrypted. It is a per-provider decision rather than one switch for the app,
 * because trusting one vendor's key to disk is not trusting all of them.
 */
export const PROVIDER_KEY_STORAGE = ['keychain', 'plaintext'] as const;
export const providerKeyStorageSchema = z.enum(PROVIDER_KEY_STORAGE);
export type ProviderKeyStorage = z.infer<typeof providerKeyStorageSchema>;

/**
 * Everything about a provider that is not a user choice.
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
   * `GET /models` is authoritative and replaces this list when the user asks the
   * endpoint what it serves, because these names do go stale: DeepSeek has
   * already renamed its line once, and Gemini renames its own far more often than
   * that. Nothing a user depends on should require this list to be right.
   */
  fallbackModels: readonly string[];
  /** False for a server on this machine or the LAN, which usually takes none. */
  requiresApiKey: boolean;
  keyPlaceholder: string;
  keyHelp: string;
  /** Whether thinking arrives as a `reasoning_content` delta. */
  reasoningChannel: boolean;
  /** Whether `stream_options.include_usage` may be sent. */
  usageInStream: boolean;
  /** The header a conversation identifies itself with, or empty for none. */
  sessionHeader: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  /*
   * First because it is the default, and the only one a fresh install is
   * pointed at.
   */
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    blurb: "DeepSeek's own API, over the public internet.",
    defaultBaseUrl: 'https://api.deepseek.com',
    fallbackModels: ['deepseek-flash', 'deepseek-v4-pro'],
    requiresApiKey: true,
    keyPlaceholder: 'sk-...',
    keyHelp: 'From platform.deepseek.com -> API keys.',
    reasoningChannel: true,
    usageInStream: true,
    sessionHeader: '',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    blurb: "Gemini through Google's OpenAI-compatible endpoint.",
    // Trailing slash included, as Google documents it; the transport strips it.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    fallbackModels: ['gemini-3.6-flash', 'gemini-3.1-pro'],
    requiresApiKey: true,
    keyPlaceholder: 'AIza...',
    keyHelp: 'From aistudio.google.com/apikey.',
    reasoningChannel: false,
    /*
     * The compatibility layer documents no `stream_options` support and answers a
     * request that carries it with an error rather than ignoring it. Usage
     * arrives as zeroes and the token badge stays quiet, which is a much smaller
     * loss than every turn failing.
     */
    usageInStream: false,
    sessionHeader: '',
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'Local llama.cpp',
    /*
     * The only provider whose label promises something about where the data
     * goes, and it can: the address is one the user typed and, by default, one
     * that never leaves the machine.
     *
     * The id is `llamacpp` rather than the label because it is what settings
     * files and key files already name. Renaming it would mean a migration to
     * reach an entry the user reads as "Local" either way.
     */
    blurb:
      'A llama-server on this machine or your network. Nothing leaves your LAN.',
    /*
     * Loopback is the one address that is right for anybody running the server
     * beside the app; a server elsewhere is a host the user types, and the field
     * in Settings is where they type it. 8080 is llama.cpp's own default, and
     * therefore the address most likely to need correcting.
     */
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    fallbackModels: ['local-model'],
    requiresApiKey: false,
    keyPlaceholder: 'not needed',
    keyHelp:
      'Only if you started llama-server with --api-key. Leave it empty ' +
      'otherwise.',
    reasoningChannel: true,
    usageInStream: true,
    sessionHeader: '',
  },
  opencode_go: {
    id: 'opencode_go',
    label: 'OpenCode Go',
    blurb:
      "OpenCode's Go subscription: a curated list of open coding models behind " +
      'one key and a monthly plan.',
    // The `/v1` matters and is part of the address: Go's own catalogue is served
    // under `zen/go`, and the OpenAI-shaped half of it - the half this app speaks
    // - lives one segment below.
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    /*
     * Placeholders like every other entry's, and this catalogue churns: Go adds
     * and retires models month to month. GLM 5.3 Flash is a name Go serves, so a
     * round billed through this provider can never be read as a round billed
     * through another.
     */
    fallbackModels: ['glm-5.3-flash'],
    requiresApiKey: true,
    keyPlaceholder: 'sk-...',
    keyHelp:
      'From opencode.ai/auth. Some Go models are served only in the Anthropic ' +
      'or Responses dialect, which this app does not speak, so those refuse a ' +
      'turn - pick another from the list.',
    reasoningChannel: true,
    usageInStream: true,
    /*
     * The one provider that asks a conversation to name itself, so its routing
     * and its prompt cache follow the conversation rather than the connection.
     * Sent as the session id, and only when the caller has one: a request without
     * it still works, it simply cannot be cached per conversation.
     */
    sessionHeader: 'x-opencode-session',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb: "One key for many vendors' models, routed by OpenRouter.",
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    /*
     * `openrouter/auto` is the one name that cannot go stale: it is the
     * service's own router, documented to keep working as the catalogue behind
     * it changes. Anything more specific is a snapshot.
     */
    fallbackModels: ['openrouter/auto'],
    requiresApiKey: true,
    keyPlaceholder: 'sk-or-...',
    keyHelp: 'From openrouter.ai/keys.',
    /*
     * True is the honest answer to what the flag asks - the endpoint does emit
     * reasoning - but OpenRouter sends it under `reasoning` rather than
     * `reasoning_content`, which this transport does not read. Thinking from a
     * reasoning model there therefore stays inside the answer's text.
     */
    reasoningChannel: true,
    usageInStream: true,
    sessionHeader: '',
  },
};

export function providerDescriptor(provider: ProviderId): ProviderDescriptor {
  return PROVIDERS[provider];
}

/** A copy, so a caller cannot reorder the catalogue's own array. */
export function fallbackModelsFor(provider: ProviderId): string[] {
  return [...PROVIDERS[provider].fallbackModels];
}

/** How to reach one provider, which model to use there, and how its key is kept. */
export const providerConfigSchema = z.object({
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  keyStorage: providerKeyStorageSchema,
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * The provider choice: which one is live, and what each one was last set to.
 *
 * Every provider keeps its own base URL and model rather than sharing one pair,
 * so switching to the local server and back does not cost the user the address
 * they typed.
 *
 * `configs` is a record over `providerIdSchema` rather than an object with one
 * hand-typed key per provider, and that is not a shortcut: an exhaustive record
 * *requires* every id the enum names and rejects one it does not, so a provider
 * added to `PROVIDER_IDS` without a config here cannot compile.
 */
export const providersSchema = z.object({
  active: providerIdSchema,
  configs: z.record(providerIdSchema, providerConfigSchema),
});

export type Providers = z.infer<typeof providersSchema>;

/**
 * A patch of the provider block.
 *
 * Nested one level deeper than the other blocks, deliberately: the block holds a
 * sub-object per provider, and `providersSchema.partial()` would make the whole
 * `configs` optional while still requiring every entry inside it - so setting one
 * base URL would mean sending all the others, and a stale window's copy of those
 * is exactly what must not win. The store merges each named provider over what
 * it has.
 *
 * `partialRecord` rather than `record` with an optional value, and the
 * difference is the type rather than the parse: a plain record's inferred input
 * still demands a key for every provider, so a renderer setting one base URL
 * would have to send all five.
 */
export const providersPatchSchema = z.object({
  active: providerIdSchema.optional(),
  configs: z
    .partialRecord(providerIdSchema, providerConfigSchema.partial())
    .optional(),
});

export type ProvidersPatch = z.infer<typeof providersPatchSchema>;

export function defaultProviders(): Providers {
  return {
    active: DEFAULT_PROVIDER_ID,
    configs: Object.fromEntries(
      PROVIDER_IDS.map((id) => [
        id,
        {
          baseUrl: PROVIDERS[id].defaultBaseUrl,
          model: PROVIDERS[id].fallbackModels[0]!,
          // Encrypted unless the user says otherwise, per provider: see
          // `PROVIDER_KEY_STORAGE`.
          keyStorage: 'keychain',
        } satisfies ProviderConfig,
      ]),
    ) as Record<ProviderId, ProviderConfig>,
  };
}

/** What every request is answered by, as one value. */
export function activeProvider(
  providers: Providers,
): ProviderConfig & {id: ProviderId} {
  return {id: providers.active, ...providers.configs[providers.active]};
}
