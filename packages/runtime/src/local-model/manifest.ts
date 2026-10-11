/**
 * The pinned model manifest, as data.
 *
 * `pins.ts` beside this file holds them, and this is the reader that decides
 * whether they are usable. It exists because the app carries no weights and no
 * engine: the file names, the digests, the sizes and the URLs travel with the
 * build, and they are the thing that decides what to *download* on a first run.
 *
 * That is the inversion worth understanding. The pins used to be read only by
 * `scripts/local-model.mjs` at package time, and a mistake in them was a broken
 * release build — loud, and caught before anybody saw it. Now a mistake is a
 * first-run download that fails on a user's machine, so the parse is strict and
 * names the field that is wrong.
 *
 * Three facts about the shape are deliberate:
 *
 * - **Every engine asset is a GPU build.** There is no CPU asset to choose
 *   between, because this app runs its model on a GPU or reports that it cannot.
 *   A 4.7B model on a CPU is a wait rather than an answer, and shipping the option
 *   would mean shipping a configuration nobody should be in.
 * - **A tier is a quantization of one model, not a different model.** Both tiers
 *   share the repository, the revision and the tool-call template; only the file,
 *   the size and the context target differ. That is what makes auto-selection a
 *   memory decision rather than a capability one.
 * - **`kvBytesPerToken` belongs to the model, not the tier.** The cache costs the
 *   same whatever the weights are quantized to, and it is what decides whether a
 *   context window fits — so it sits beside the repository rather than beside the
 *   file.
 */

/** The two tiers, smallest first, which is also the order a picker draws them. */
export const MODEL_TIERS = ['low', 'high'] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];

export interface EngineAsset {
  /** The release asset's file name, which is also its name in the cache. */
  file: string;
  sha256: string;
}

export interface ModelTier {
  name: ModelTierName;
  /** What the picker shows. */
  label: string;
  file: string;
  sha256: string;
  /** The exact size, which is how "is it installed" is answered without hashing. */
  bytes: number;
  /** The context window this tier is started with. */
  contextSize: number;
}

export interface LocalModelManifest {
  engine: {
    tag: string;
    baseUrl: string;
    assets: Record<string, EngineAsset>;
    /**
     * What the GPU backend is called on each platform, for a sentence rather
     * than for a decision.
     *
     * The decision is the probe's — it asks the engine what it can see. This is
     * so the app can say "Vulkan" or "Metal" to a user instead of "GPU".
     */
    backends: Record<string, string>;
  };
  weights: {
    repo: string;
    revision: string;
    license: string;
    /**
     * The KV cache's cost per token, in bytes, at f16.
     *
     * `full_attention_layers x kv_heads x head_dim x 2 (K and V) x 2 bytes`. For
     * Qwen3.5-4B that is 8 x 4 x 256 x 2 x 2 = 32 KiB, because only 8 of its 32
     * layers are full attention. A dense model of the same size would be four to
     * five times this, which is the whole reason a long context is affordable.
     */
    kvBytesPerToken: number;
    tiers: Record<ModelTierName, ModelTier>;
  };
}

/** Raised when the shipped manifest is not a document this build understands. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(`The model manifest is not usable: ${message}`);
    this.name = 'ManifestError';
  }
}

/**
 * The platform key the manifest uses.
 *
 * Node's own pair with a dash, so `linux-x64` and `win32-x64` — the same keys the
 * fetch script has always used, and the same ones a human reads in the JSON.
 */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/**
 * The engine asset for a platform, or `undefined` when this build has none.
 *
 * `undefined` is a real answer and not an error: a platform the app does not ship
 * an engine for is one where it cannot run its model, and the sentence that says
 * so is written by the caller that knows what the user was trying to do.
 */
export function engineAssetFor(
  manifest: LocalModelManifest,
  options: {platform?: NodeJS.Platform; arch?: string} = {},
): {key: string; asset: EngineAsset} | undefined {
  const key = platformKey(options.platform, options.arch);
  const asset = manifest.engine.assets[key];
  return asset === undefined ? undefined : {key, asset};
}

/** What this platform's GPU backend is called, when the manifest names it. */
export function backendNameFor(
  manifest: LocalModelManifest,
  options: {platform?: NodeJS.Platform; arch?: string} = {},
): string | undefined {
  return manifest.engine.backends[platformKey(options.platform, options.arch)];
}

export function engineUrl(
  manifest: LocalModelManifest,
  asset: EngineAsset,
): string {
  return `${manifest.engine.baseUrl}/${manifest.engine.tag}/${asset.file}`;
}

export function weightsUrl(
  manifest: LocalModelManifest,
  tier: ModelTier,
): string {
  return (
    `https://huggingface.co/${manifest.weights.repo}/resolve/` +
    `${manifest.weights.revision}/${tier.file}`
  );
}

/**
 * Reads the manifest, or refuses with the field that is wrong.
 *
 * Hand-written rather than a schema library, because this is the only document
 * `@marimo/runtime` validates and a validator dependency for one file would be
 * the larger cost. Every message names the path a reader would search for.
 */
export function parseManifest(raw: unknown): LocalModelManifest {
  const root = asRecord(raw, 'the document');

  const engine = asRecord(root['engine'], 'engine');
  const tag = requireString(engine['tag'], 'engine.tag');
  const baseUrl = requireString(engine['baseUrl'], 'engine.baseUrl');

  const rawAssets = asRecord(engine['assets'], 'engine.assets');
  const assets: Record<string, EngineAsset> = {};
  for (const [key, value] of Object.entries(rawAssets)) {
    const asset = asRecord(value, `engine.assets.${key}`);
    assets[key] = {
      file: requireString(asset['file'], `engine.assets.${key}.file`),
      sha256: requireDigest(asset['sha256'], `engine.assets.${key}.sha256`),
    };
  }
  if (Object.keys(assets).length === 0) {
    throw new ManifestError('engine.assets is empty, so nothing can be fetched.');
  }

  const rawBackends = asRecord(engine['backends'], 'engine.backends');
  const backends: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawBackends)) {
    // The `note` beside the map is prose for a reader, not an entry.
    if (key === 'note') {
      continue;
    }
    backends[key] = requireString(value, `engine.backends.${key}`);
  }
  for (const key of Object.keys(assets)) {
    if (!(key in backends)) {
      throw new ManifestError(
        `engine.assets.${key} has no engine.backends entry, so nothing knows ` +
          'what to call its GPU backend.',
      );
    }
  }

  const weights = asRecord(root['weights'], 'weights');
  const tiers = asRecord(weights['tiers'], 'weights.tiers');
  const parsedTiers = {} as Record<ModelTierName, ModelTier>;
  for (const name of MODEL_TIERS) {
    const tier = asRecord(tiers[name], `weights.tiers.${name}`);
    parsedTiers[name] = {
      name,
      label: requireString(tier['label'], `weights.tiers.${name}.label`),
      file: requireString(tier['file'], `weights.tiers.${name}.file`),
      sha256: requireDigest(tier['sha256'], `weights.tiers.${name}.sha256`),
      bytes: requirePositiveInt(tier['bytes'], `weights.tiers.${name}.bytes`),
      contextSize: requirePositiveInt(
        tier['contextSize'],
        `weights.tiers.${name}.contextSize`,
      ),
    };
  }

  return {
    engine: {tag, baseUrl, assets, backends},
    weights: {
      repo: requireString(weights['repo'], 'weights.repo'),
      revision: requireString(weights['revision'], 'weights.revision'),
      license: requireString(weights['license'], 'weights.license'),
      kvBytesPerToken: requirePositiveInt(
        weights['kvBytesPerToken'],
        'weights.kvBytesPerToken',
      ),
      tiers: parsedTiers,
    },
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(`${path} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(`${path} is missing or empty.`);
  }
  return value;
}

function requirePositiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ManifestError(`${path} is not a positive whole number.`);
  }
  return value;
}

/**
 * A sha256, checked for shape rather than for content.
 *
 * Shape only, because the digest is *verified against the download* — this check
 * catches a truncated paste or a placeholder left in the file, which is the
 * mistake that would otherwise reach a user as "the download is corrupt".
 */
function requireDigest(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new ManifestError(`${path} is not a sha256 digest.`);
  }
  return text;
}
