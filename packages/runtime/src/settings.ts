/**
 * Settings persistence.
 *
 * Settings are non-secret, so they live in a plain JSON file that a user can
 * read and edit. Reads are forgiving: an unknown or malformed field falls back
 * to its default instead of discarding every other setting.
 *
 * The file holds two kinds of state: what the user chose, and the model list the
 * provider reported. Only the first kind is patchable (`SettingsPatch`), so a
 * stale window cannot overwrite the provider's answer with a guess.
 */
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';

import {
  appearanceSchema,
  companionSettingsSchema,
  defaultAppearance,
  defaultCompanionSettings,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  defaultWindowState,
  defaultDiscordSettings,
  defaultProviders,
  discordSettingsSchema,
  fallbackModelsFor,
  providerIdSchema,
  settingsPatchSchema,
  storedSettingsSchema,
  windowStateSchema,
} from '@marimo/protocol';
import type {
  ProviderConfig,
  ProviderId,
  Providers,
  ProvidersPatch,
  SettingsPatch,
  StoredSettings,
} from '@marimo/protocol';

/**
 * The placeholder model list for each provider, before each has been asked.
 *
 * Derived from the catalogue rather than spelled out, because a provider missing
 * from here is a provider whose picker opens on an empty select — the failure
 * that looks like "the app has no models" rather than like a missing line.
 */
export function defaultAvailableModels(): Record<ProviderId, string[]> {
  return Object.fromEntries(
    providerIdSchema.options.map((id) => [id, fallbackModelsFor(id)]),
  ) as Record<ProviderId, string[]>;
}

export function defaultStoredSettings(): StoredSettings {
  return {
    providers: defaultProviders(),
    appearance: defaultAppearance(),
    temperature: 0.7,
    allowPrivateNetworkFetch: false,
    allowPlaintextApiKey: false,
    mcpServers: [],
    // Discord is off until the user pastes a bot token, so a fresh install makes
    // no network calls it was not asked to make.
    discord: defaultDiscordSettings(),
    // How the moss ball answers and behaves. Defaults here rather than in the
    // window that draws it, because two of the four change what the agent is
    // told and a default the renderer owned would be a default the agent could
    // not see.
    companion: defaultCompanionSettings(),
    // Match the design tokens, so the first launch looks like the stylesheet says
    // it should, and a later drag starts from wherever the user left it.
    sidebarWidth: 272,
    todosWidth: 288,
    jobsWidth: 288,
    notesWidth: 288,
    filesWidth: 320,
    // The file tree opens folded, like the notes: the to-do list is the rail a
    // fresh install starts with, and it should not have to share the column.
    filesOpen: false,
    // Nothing folded: the dialog opens exactly as it did before it could fold.
    collapsedSections: [],
    // The size the window opened at before it remembered one, placed by the OS.
    window: defaultWindowState(),
    // Where the agent starts being told that memory.md is getting full. Well
    // under the hard cap, so the warning arrives while there is room to prune.
    memorySoftLimitBytes: DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    availableModels: defaultAvailableModels(),
  };
}

/**
 * Values a pre-profile settings file may still hold.
 *
 * `workspaceRoot` and `systemPrompt` moved into the agent profile, so they are
 * no longer part of the settings schema — which means the parser strips them on
 * read. This looks at the raw file once, before anything rewrites it, so an
 * upgrade keeps the folder and the prompt the user already had.
 */
export async function readLegacyProfileSeed(file: string): Promise<{
  workspaceRoot?: string;
  systemPrompt?: string;
}> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >;
    const workspaceRoot = raw['workspaceRoot'];
    const systemPrompt = raw['systemPrompt'];
    return {
      // Trimmed only for the emptiness test: a real folder name may contain
      // spaces, but a blank one must not win over the app's default.
      ...(typeof workspaceRoot === 'string' && workspaceRoot.trim().length > 0
        ? {workspaceRoot}
        : {}),
      ...(typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
        ? {systemPrompt}
        : {}),
    };
  } catch {
    return {};
  }
}

export class SettingsStore {
  private cache: StoredSettings | undefined;

  constructor(private readonly file: string) {}

  async load(): Promise<StoredSettings> {
    if (this.cache) {
      return this.cache;
    }

    /*
     * Versioned like every other document, and refused when it is newer.
     *
     * The leniency below is deliberate — a hand-edited block falls back on its
     * own rather than resetting everything — but leniency plus a write is how a
     * user's data disappears, and a settings file from a future build is exactly
     * the case where the read has to guess. Throwing here stops the guess from
     * becoming a write.
     */
    const read = await readVersionedDocument(this.file, {
      label: 'The settings file',
      /*
       * This document has never carried a version — `storedSettingsSchema` has no
       * such field — so every settings file in existence is version-less, and
       * treating that as "not mine" would reset every user's providers,
       * connectors and preferences the first time they upgraded. Naming the
       * version they are is the migration.
       *
       * A *newer* file is still refused, which is the half that matters: a future
       * build that adds a version number will have its settings left alone.
       */
      missingVersion: 1,
    });
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The settings file',
        read.found,
        read.supported,
      );
    }
    const raw: unknown =
      read.state === 'current' || read.state === 'migrated'
        ? read.document
        : undefined;

    if (read.state === 'migrated') {
      // Written back once, so the upgrade is not repeated on every launch.
      const upgraded = storedSettingsSchema.safeParse({
        ...defaultStoredSettings(),
        ...(raw as Record<string, unknown>),
      });
      if (upgraded.success) {
        await this.write(upgraded.data);
      }
    }

    const defaults = defaultStoredSettings();
    /*
     * The nested blocks are filled in before the file is parsed as a whole.
     *
     * Each is a sub-object inside an otherwise flat document, and each is what a
     * hand-edited file or a file written by an older build gets slightly wrong —
     * which, without this, would fail the settings schema and reset *every*
     * setting. Filling them block by block means a bad block falls back on its
     * own and the model, the folder widths and the API-key choice survive.
     */
    const rawObject =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : undefined;
    const filled = rawObject
      ? {
          ...rawObject,
          // A block that does not validate is replaced whole rather than
          // field-by-field: half of a hand-edited block is a second, quieter
          // schema, and the defaults are at least a state the app can describe.
          discord: fillBlock(
            discordSettingsSchema,
            defaults.discord,
            rawObject['discord'],
          ),
          companion: fillBlock(
            companionSettingsSchema,
            defaults.companion,
            rawObject['companion'],
          ),
          providers: fillProviders(rawObject),
          appearance: fillBlock(
            appearanceSchema,
            defaults.appearance,
            rawObject['appearance'],
          ),
          /*
           * The window block, filled the same way, for the same reason: a
           * hand-edited bounds value must cost the user the position, not every
           * other setting they have. It is also what a file written before the
           * app remembered its window gets.
           */
          window: fillBlock(
            windowStateSchema,
            defaults.window,
            rawObject['window'],
          ),
        }
      : raw;

    const partial = settingsPatchSchema.safeParse(filled ?? {});
    const candidate: Record<string, unknown> = partial.success
      ? {...defaults, ...definedOnly(partial.data)}
      : {...defaults};

    // Derived, so an unknown value is discarded rather than trusted.
    candidate['availableModels'] = readAvailableModels(
      (raw as {availableModels?: unknown} | undefined)?.availableModels,
    );

    const result = storedSettingsSchema.safeParse(candidate);
    this.cache = result.success ? result.data : defaults;
    return this.cache;
  }

  async patch(patch: SettingsPatch): Promise<StoredSettings> {
    return await this.enqueue(async () => {
      const current = await this.load();
      const defined = definedOnly(patch);
      /*
       * Both nested blocks are merged rather than replaced.
       *
       * Their patch schemas accept any subset — that is the point, so flipping one
       * switch does not mean sending the channel name and the bot's name back, and
       * setting one provider's base URL does not mean sending the other two — but a
       * shallow spread would then store the partial block and throw away the fields
       * the window did not mention.
       */
      const discord = defined.discord
        ? {...current.discord, ...definedOnly(defined.discord)}
        : current.discord;
      const companion = defined.companion
        ? {...current.companion, ...definedOnly(defined.companion)}
        : current.companion;
      const providers = defined.providers
        ? mergeProviders(current.providers, defined.providers)
        : current.providers;
      const appearance = defined.appearance
        ? {...current.appearance, ...definedOnly(defined.appearance)}
        : current.appearance;
      const merged = storedSettingsSchema.parse({
        ...current,
        ...defined,
        discord,
        companion,
        providers,
        appearance,
      });
      await this.write(merged);
      this.cache = merged;
      return merged;
    });
  }

  /**
   * The tail of the write queue.
   *
   * Every mutation here is a read-modify-write, and two of them can arrive in the
   * same tick: the settings dialog saves a text box when it loses focus and the
   * menu that took the focus in the same gesture, which is two `settings.set`
   * calls from one click. Both would read the state from before either wrote, and
   * the second write would drop the first edit — silently, because both writes
   * succeed and neither caller is told.
   */
  private writes: Promise<unknown> = Promise.resolve();

  /** Runs one mutation after every mutation queued before it, in that order. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.writes.then(work);
    /*
     * The queue keeps moving after a failed write: one refused patch must not
     * wedge every save after it. The caller still sees its own rejection, because
     * this is the chain's tail rather than the promise handed back.
     */
    this.writes = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Records what one provider says it serves.
   *
   * A model the user had selected there may no longer exist, so that provider's
   * default is moved to something the endpoint actually offers rather than left
   * pointing at a retired name. Chats that picked a model explicitly keep their
   * choice, and no other provider is touched — the lists are answers about one
   * endpoint each.
   */
  async setAvailableModels(
    provider: ProviderId,
    models: string[],
  ): Promise<StoredSettings> {
    const unique = [...new Set(models.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return await this.load();
    }

    return await this.enqueue(async () => {
      const current = await this.load();
      const config = current.providers.configs[provider];
      const merged = storedSettingsSchema.parse({
        ...current,
        providers: {
          ...current.providers,
          configs: {
            ...current.providers.configs,
            [provider]: {
              baseUrl: config.baseUrl,
              model: chooseModel(unique, config.model),
            },
          },
        },
        availableModels: {...current.availableModels, [provider]: unique},
      });
      await this.write(merged);
      this.cache = merged;
      return merged;
    });
  }

  private async write(settings: StoredSettings): Promise<void> {
    // Refused before anything is written: a lenient read plus a write is how a
    // user's settings disappear.
    await assertWritable(this.file, {label: 'The settings file'});
    await mkdir(dirname(this.file), {recursive: true});
    const temporary = `${this.file}.tmp`;
    await writeFile(
      temporary,
      // Stamped from here on, so the next build can tell an old file from one
      // written before versioning existed — which is what `missingVersion` was
      // for, and what stops it being needed twice.
      `${JSON.stringify({version: 1, ...settings}, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, this.file);
  }
}

/** Keep the current model when it still exists; otherwise pick a fresh one. */
export function chooseModel(available: string[], current: string): string {
  if (available.includes(current)) {
    return current;
  }
  // Prefer a fast tier when a previous default has been retired: the cheap
  // model is the least surprising thing to land on.
  return (
    available.find((id) => /flash|mini|lite|small|fast/i.test(id)) ??
    available[0]!
  );
}

function definedOnly<T extends object>(value: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key as keyof T] = entry as T[keyof T];
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Fills one nested block over its defaults, or falls back to them whole.
 *
 * The rule the Discord block always used, generalised: a block that does not
 * validate is replaced rather than merged field-by-field, because half of a
 * hand-edited block is a second, quieter schema.
 */
function fillBlock<T extends object>(
  schema: {
    safeParse: (value: unknown) => {success: boolean; data?: T};
  },
  defaults: T,
  raw: unknown,
): T {
  const parsed = schema.safeParse({...defaults, ...asRecord(raw)});
  return parsed.success && parsed.data ? parsed.data : defaults;
}

/**
 * The provider block, filled one provider at a time.
 *
 * Deeper than a single `fillBlock` because the block holds one sub-object per
 * provider: a typo in the Gemini address must not cost the user the provider they
 * were actually using, or the address they typed for their own server.
 *
 * The loop runs over the catalogue, so a provider added to `PROVIDER_IDS` is
 * filled here the moment it exists. The one per-provider difference the loop
 * cannot express is which provider a file written before the picker existed
 * belonged to: that file holds `model` and `baseUrl` at the top level, which the
 * schema now strips. They were DeepSeek's — it was the only provider then — so
 * they become DeepSeek's entry in the new block, and the user's model and
 * (possibly local) base URL survive the upgrade.
 */
function fillProviders(raw: Record<string, unknown>): Providers {
  const defaults = defaultProviders();
  const source = asRecord(raw['providers']);
  const rawConfigs = asRecord(source['configs']);
  const legacy: Partial<ProviderConfig> = {};
  const legacyBaseUrl = raw['baseUrl'];
  const legacyModel = raw['model'];
  if (typeof legacyBaseUrl === 'string' && legacyBaseUrl.length > 0) {
    legacy.baseUrl = legacyBaseUrl;
  }
  if (typeof legacyModel === 'string' && legacyModel.length > 0) {
    legacy.model = legacyModel;
  }

  const active = providerIdSchema.safeParse(source['active']);
  const configs = {} as Record<ProviderId, ProviderConfig>;
  for (const id of providerIdSchema.options) {
    configs[id] = fillProviderConfig(
      defaults.configs[id],
      rawConfigs[id],
      id === 'deepseek' ? legacy : {},
    );
  }
  return {
    active: active.success ? active.data : defaults.active,
    configs,
  };
}

function fillProviderConfig(
  defaults: ProviderConfig,
  raw: unknown,
  legacy: Partial<ProviderConfig> = {},
): ProviderConfig {
  const source = asRecord(raw);
  return {
    // The block's own value wins; a legacy top-level field only fills a gap.
    baseUrl: firstNonEmpty([
      source['baseUrl'],
      legacy.baseUrl,
      defaults.baseUrl,
    ]),
    model: firstNonEmpty([source['model'], legacy.model, defaults.model]),
  };
}

function firstNonEmpty(candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

/**
 * What each provider last reported.
 *
 * A provider with no stored list falls back to the placeholder, because the
 * picker has to show *something* before the first refresh and an empty select is
 * a worse answer than a name that may already be stale. A list stored before the
 * picker existed was a flat array, and it was DeepSeek's.
 *
 * Keyed off the catalogue like the two functions above it, so a new provider
 * cannot be the one whose models are stored and then thrown away on the next
 * read.
 */
function readAvailableModels(raw: unknown): Record<ProviderId, string[]> {
  const byProvider = asRecord(raw);
  const legacyDeepSeek = Array.isArray(raw) ? raw : undefined;
  return Object.fromEntries(
    providerIdSchema.options.map((id) => [
      id,
      storedModelList(
        byProvider[id] ?? (id === 'deepseek' ? legacyDeepSeek : undefined),
        id,
      ),
    ]),
  ) as Record<ProviderId, string[]>;
}

function storedModelList(value: unknown, provider: ProviderId): string[] {
  const list = Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0,
      )
    : [];
  return list.length > 0 ? list : fallbackModelsFor(provider);
}

/**
 * Applies a provider patch over what is stored.
 *
 * Each named provider is merged into its own config, so a patch that changes
 * only the active provider leaves the other two addresses exactly as they were.
 */
export function mergeProviders(
  current: Providers,
  patch: ProvidersPatch,
): Providers {
  const configs = {...current.configs};
  for (const id of providerIdSchema.options) {
    const next = patch.configs?.[id];
    if (next) {
      configs[id] = {...configs[id], ...definedOnly(next)};
    }
  }
  return {active: patch.active ?? current.active, configs};
}
