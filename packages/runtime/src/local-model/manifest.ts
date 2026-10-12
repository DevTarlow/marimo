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
 *   A model this size on a CPU is a wait rather than an answer, and shipping the
 *   option would mean shipping a configuration nobody should be in.
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

/**
 * One pinned llama.cpp release, by tag and by the digest of each platform's
 * archive.
 *
 * A named shape rather than an inline one because there are two of these now.
 * The chat model and the recall model are different builds of the same tool —
 * see `EMBEDDING_PINS` for why — and the downloader only ever reads `tag`,
 * `baseUrl`, `assets` and `backends`, so it takes this rather than a whole
 * manifest. That is what lets `installEngine` fetch a build from a manifest that
 * has no `weights` in it at all.
 */
export interface EngineManifest {
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
}

export interface LocalModelManifest {
  engine: EngineManifest;
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

/**
 * The pieces of the recall model, which is one repository and two downloads.
 *
 * `text` is the backbone and is required for the feature to work at all. `media`
 * is the vision and audio projector, which is 555 MB and only means anything when
 * the user has asked for images, audio or video to be searchable. Keeping them
 * apart is what lets the cheap half gate the expensive one — the same shape the
 * engine and the tier have.
 *
 * They are not tiers of one thing: without the projector there is no image
 * encoder in the process at all, so a media request is not a slower answer, it is
 * a request the engine cannot serve.
 */
export const EMBEDDING_PIECES = ['text', 'media'] as const;
export type EmbeddingPieceName = (typeof EMBEDDING_PIECES)[number];

export interface EmbeddingPiece {
  name: EmbeddingPieceName;
  /** What a download card calls it. */
  label: string;
  file: string;
  sha256: string;
  bytes: number;
}

/** How token vectors are combined into the one vector an index stores. */
export const EMBEDDING_POOLINGS = ['mean', 'cls', 'last'] as const;
export type EmbeddingPooling = (typeof EMBEDDING_POOLINGS)[number];

/**
 * The recall model, pinned.
 *
 * Separate from `LocalModelManifest` rather than a third tier of it, because the
 * differences are not sizes: this model has no chat template to apply, it is
 * served by `--embeddings`, and it is a *second process* rather than the one the
 * app answers with. `weights` carries the two facts an index depends on —
 * `dims`, which is written into every vector file, and `contextSize`, which is
 * how long a single input may be — so neither is a number a caller improvises.
 */
export interface EmbeddingManifest {
  engine: EngineManifest;
  weights: {
    repo: string;
    revision: string;
    license: string;
    /**
     * The width of every vector this model returns.
     *
     * Read from the model rather than assumed: it is stored in each index, and a
     * query vector of the wrong width scores against nothing rather than
     * failing. The model supports Matryoshka truncation to 128, 256 and 512, and
     * this app deliberately does not use it — a truncated vector must be
     * re-normalized or ranking degrades silently, which is a failure mode that
     * looks like a bad model.
     */
    dims: number;
    /** The window one input is tokenized into, in tokens. */
    contextSize: number;
    pooling: EmbeddingPooling;
    pieces: Record<EmbeddingPieceName, EmbeddingPiece>;
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
  manifest: {engine: EngineManifest},
  options: {platform?: NodeJS.Platform; arch?: string} = {},
): {key: string; asset: EngineAsset} | undefined {
  const key = platformKey(options.platform, options.arch);
  const asset = manifest.engine.assets[key];
  return asset === undefined ? undefined : {key, asset};
}

/** What this platform's GPU backend is called, when the manifest names it. */
export function backendNameFor(
  manifest: {engine: EngineManifest},
  options: {platform?: NodeJS.Platform; arch?: string} = {},
): string | undefined {
  return manifest.engine.backends[platformKey(options.platform, options.arch)];
}

export function engineUrl(
  manifest: {engine: EngineManifest},
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

/** Where one piece of the recall model is fetched from. */
export function embeddingUrl(
  manifest: EmbeddingManifest,
  piece: EmbeddingPiece,
): string {
  return (
    `https://huggingface.co/${manifest.weights.repo}/resolve/` +
    `${manifest.weights.revision}/${piece.file}`
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
  const engine = parseEngine(root['engine']);

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
    engine,
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

/**
 * Reads the recall model's pins, the same way and for the same reason.
 *
 * The one thing this checks that the chat manifest does not is `dims`: it is
 * written into every vector file, and a vector of the wrong width does not throw
 * anywhere — it quietly scores against nothing, which reads as a search that
 * finds nothing rather than as a mismatched model.
 */
export function parseEmbeddingManifest(raw: unknown): EmbeddingManifest {
  const root = asRecord(raw, 'the document');
  const engine = parseEngine(root['engine']);

  const weights = asRecord(root['weights'], 'weights');
  const pooling = requireString(weights['pooling'], 'weights.pooling');
  if (!EMBEDDING_POOLINGS.includes(pooling as EmbeddingPooling)) {
    throw new ManifestError(
      `weights.pooling is "${pooling}", and this build only knows ` +
        `${EMBEDDING_POOLINGS.join(', ')}.`,
    );
  }

  const rawPieces = asRecord(weights['pieces'], 'weights.pieces');
  const pieces = {} as Record<EmbeddingPieceName, EmbeddingPiece>;
  for (const name of EMBEDDING_PIECES) {
    const piece = asRecord(rawPieces[name], `weights.pieces.${name}`);
    pieces[name] = {
      name,
      label: requireString(piece['label'], `weights.pieces.${name}.label`),
      file: requireString(piece['file'], `weights.pieces.${name}.file`),
      sha256: requireDigest(piece['sha256'], `weights.pieces.${name}.sha256`),
      bytes: requirePositiveInt(piece['bytes'], `weights.pieces.${name}.bytes`),
    };
  }

  return {
    engine,
    weights: {
      repo: requireString(weights['repo'], 'weights.repo'),
      revision: requireString(weights['revision'], 'weights.revision'),
      license: requireString(weights['license'], 'weights.license'),
      dims: requirePositiveInt(weights['dims'], 'weights.dims'),
      contextSize: requirePositiveInt(
        weights['contextSize'],
        'weights.contextSize',
      ),
      pooling: pooling as EmbeddingPooling,
      pieces,
    },
  };
}

/**
 * The engine half of a manifest, parsed once for both.
 *
 * Every path in the messages below has been `engine.` since the file was
 * written, and it still is: the prefix is a path into the document a reader is
 * looking at, not into the object this function was handed.
 */
function parseEngine(raw: unknown): EngineManifest {
  const engine = asRecord(raw, 'engine');
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

  return {tag, baseUrl, assets, backends};
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
