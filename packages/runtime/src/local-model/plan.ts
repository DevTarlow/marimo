/**
 * Which tier this machine should run, and why.
 *
 * A pure function of the manifest, what the engine reported, how much memory the
 * machine has and what the user asked for. Pure because it is the one piece of
 * this feature with a decision in it, and the decision is worth testing at every
 * boundary — a 4 GB card, a 6 GB card, a machine with no device, a machine whose
 * probe failed — without owning any of that hardware.
 *
 * Two things shape the answer.
 *
 * **There is no CPU path, so "no GPU" is a refusal rather than a downgrade.** The
 * sentence it produces is the one the welcome screen shows, and it has to name
 * what is missing rather than say "not ready": a user on a machine that will
 * never run this deserves to know that, not to wait for a download that would end
 * in the same place.
 *
 * **The app probes and then downloads; it never tries and falls back.** So the
 * estimate here is the only thing between a user and a 4.5 GB download that will
 * not start, and it is deliberately pessimistic — a margin on top of a resident
 * figure that already includes a compute buffer. The manual override exists
 * because an estimate can be wrong, which is also why an explicit choice is never
 * second-guessed: it sets `fits` so the card can warn, and then does what it was
 * told.
 */
import type {LocalModelManifest, ModelTier, ModelTierName} from './manifest.js';
import {MODEL_TIERS} from './manifest.js';

/** What the user asked for: decide for me, or one tier by name. */
export type TierChoice = 'auto' | ModelTierName;

export interface TierPlanInput {
  manifest: LocalModelManifest;
  /**
   * What the engine reported as free on its best device.
   *
   * `undefined` is the answer that matters most: it means the probe ran and found
   * nothing usable, which is a machine this app cannot run on.
   */
  gpuFreeBytes?: number;
  /** The user's choice, `auto` unless they said otherwise. */
  choice: TierChoice;
  /** Tiers whose weights are already on disk, so nothing has to be fetched. */
  installed: readonly ModelTierName[];
  /** What to call the GPU backend in a sentence, e.g. `Vulkan`. */
  backendName?: string;
}

export type TierPlan =
  | {
      runnable: true;
      tier: ModelTierName;
      /** The context window to start with, which may be below the tier's target. */
      contextSize: number;
      /** Whether the chosen tier still has to be downloaded. */
      download: boolean;
      /** Whether the estimate says it fits. False is a warning, not a refusal. */
      fits: boolean;
      /** Why this tier, in a sentence the Settings card can show verbatim. */
      reason: string;
    }
  | {
      runnable: false;
      /** Why it cannot run, in a sentence the welcome screen can show verbatim. */
      problem: string;
    };

/**
 * What llama.cpp needs on top of the weights and the cache.
 *
 * A batch of activations and the compute graph, which grow with the context but
 * not with the weights. A few hundred megabytes is the right order for a 4B model
 * at these context sizes, and this figure is a judgement rather than a
 * measurement — which is exactly why the estimate carries a margin and the
 * override exists.
 */
const COMPUTE_OVERHEAD_BYTES = 384 * 1024 * 1024;

/**
 * What is left over for everything else.
 *
 * A card that reports 4 GB free is not a card that can hold 4 GB: the driver, the
 * display and whatever else is running take their share, and a model that fits to
 * the last megabyte fails on the machine that has one more window open.
 */
export const SAFETY_MARGIN_BYTES = 384 * 1024 * 1024;

/**
 * The smallest window worth starting with.
 *
 * Below this the agent cannot hold a conversation with a few file reads in it,
 * and a tier that only fits at 4K is not worth downloading — the smaller weights
 * at a usable context are the better answer.
 */
export const CONTEXT_FLOOR = 8192;

/** The cache is quantized, which halves it, at a cost measured as near zero. */
const KV_QUANTIZATION_DIVISOR = 2;

/**
 * What one tier is expected to occupy at a given context.
 *
 * Exported because the card shows it: somebody choosing between two downloads
 * deserves the number the decision was made on rather than a shrug.
 */
export function estimatedResidentBytes(
  manifest: LocalModelManifest,
  tier: ModelTier,
  contextSize: number,
): number {
  const cache =
    (manifest.weights.kvBytesPerToken * contextSize) / KV_QUANTIZATION_DIVISOR;
  return tier.bytes + cache + COMPUTE_OVERHEAD_BYTES;
}

/** What the tier needs free, margin included. */
export function requiredFreeBytes(
  manifest: LocalModelManifest,
  tier: ModelTier,
  contextSize: number,
): number {
  return estimatedResidentBytes(manifest, tier, contextSize) + SAFETY_MARGIN_BYTES;
}

/**
 * The largest context this tier fits at, or `undefined` if it fits at none.
 *
 * Halves from the tier's target down to the floor, which lands on the round
 * numbers people expect — 32K, 16K, 8K — rather than on whatever arithmetic
 * happens to produce.
 */
export function contextThatFits(
  manifest: LocalModelManifest,
  tier: ModelTier,
  availableBytes: number,
): number | undefined {
  let context = tier.contextSize;
  while (context >= CONTEXT_FLOOR) {
    if (requiredFreeBytes(manifest, tier, context) <= availableBytes) {
      return context;
    }
    context = Math.floor(context / 2);
  }
  return undefined;
}

/**
 * The decision.
 *
 * The no-GPU refusal comes first and is not negotiable by the override: choosing
 * High on a machine with no device does not make one appear, and the honest
 * answer is the same sentence either way.
 */
export function planTier(input: TierPlanInput): TierPlan {
  const {manifest, gpuFreeBytes, choice, installed, backendName} = input;

  if (gpuFreeBytes === undefined) {
    return {
      runnable: false,
      problem:
        'No usable GPU was found. This app runs its model on a graphics card — ' +
        `${backendName ?? 'a GPU backend'} on this platform — and a 4.7B model on ` +
        'a processor is a wait rather than an answer.',
    };
  }

  if (choice !== 'auto') {
    const tier = manifest.weights.tiers[choice];
    const context = contextThatFits(manifest, tier, gpuFreeBytes);
    return {
      runnable: true,
      tier: choice,
      contextSize: context ?? tier.contextSize,
      download: !installed.includes(choice),
      fits: context !== undefined,
      reason:
        context === undefined
          ? `You chose ${tier.label}, and this machine looks too small for it: ` +
            `it wants about ${formatBytes(requiredFreeBytes(manifest, tier, tier.contextSize))} ` +
            `free and the GPU reports ${formatBytes(gpuFreeBytes)}.`
          : `You chose ${tier.label}.`,
    };
  }

  /*
   * The bigger weights first, because a GPU is the one place the extra precision
   * is free in wall-clock terms — which is the whole reason the tier exists.
   */
  for (const name of MODEL_TIERS.slice().reverse()) {
    const tier = manifest.weights.tiers[name];
    const context = contextThatFits(manifest, tier, gpuFreeBytes);
    if (context !== undefined) {
      return {
        runnable: true,
        tier: name,
        contextSize: context,
        download: !installed.includes(name),
        fits: true,
        reason:
          name === 'high'
            ? `${tier.label} fits on this GPU at ${formatContext(context)}, so ` +
              'that is what it runs.'
            : `${tier.label} fits on this GPU at ${formatContext(context)}. The ` +
              'larger one does not.',
      };
    }
  }

  /*
   * A GPU that is present but too small. Said with both numbers, because "not
   * enough memory" without them is a dead end — the user cannot tell whether
   * closing a game would fix it or whether they need a different machine.
   */
  const low = manifest.weights.tiers.low;
  return {
    runnable: false,
    problem:
      `This GPU has ${formatBytes(gpuFreeBytes)} free, and the smaller model ` +
      `needs about ${formatBytes(requiredFreeBytes(manifest, low, CONTEXT_FLOOR))} ` +
      'to answer at all. Close anything else using the GPU, or run this on a ' +
      'machine with more video memory.',
  };
}

function formatContext(tokens: number): string {
  return `${String(Math.round(tokens / 1024))}K context`;
}

/** Bytes as a person reads them, for the sentences above and the card. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
