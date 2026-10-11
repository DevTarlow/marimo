/**
 * The decision, at every boundary that matters.
 *
 * This is the one place in the feature with a judgement in it, and the judgement
 * decides whether somebody waits for a 4.5 GB download. So the cases are the
 * hardware nobody here owns: a 4 GB card, a 6 GB card, a card that is present but
 * too small, a machine with no device at all, and a user who overrules the
 * estimate.
 *
 * The no-GPU case is the one to keep honest. There is no CPU path, so it is a
 * refusal rather than a downgrade, and the sentence has to say what is missing
 * instead of leaving somebody to wait for a download that ends in the same place.
 */
import {describe, expect, it} from 'vitest';

import {parseManifest} from './manifest.js';
import type {LocalModelManifest, ModelTierName} from './manifest.js';
import {
  CONTEXT_FLOOR,
  contextThatFits,
  estimatedResidentBytes,
  formatBytes,
  planTier,
  requiredFreeBytes,
  SAFETY_MARGIN_BYTES,
} from './plan.js';

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

/** Sizes taken from the real manifest, so the arithmetic here is the real one. */
function manifest(): LocalModelManifest {
  return parseManifest({
    engine: {
      tag: 'b1',
      baseUrl: 'https://example.test/dl',
      assets: {'linux-x64': {file: 'e.tar.gz', sha256: 'a'.repeat(64)}},
      backends: {'linux-x64': 'vulkan'},
    },
    weights: {
      repo: 'someone/model-GGUF',
      revision: 'deadbeef',
      license: 'Apache-2.0',
      kvBytesPerToken: 32768,
      tiers: {
        low: {
          label: 'Low',
          file: 'low.gguf',
          sha256: 'b'.repeat(64),
          bytes: 2_740_937_888,
          contextSize: 16384,
        },
        high: {
          label: 'High',
          file: 'high.gguf',
          sha256: 'c'.repeat(64),
          bytes: 4_482_403_488,
          contextSize: 32768,
        },
      },
    },
  });
}

function plan(options: {
  free?: number;
  choice?: 'auto' | ModelTierName;
  installed?: readonly ModelTierName[];
}) {
  return planTier({
    manifest: manifest(),
    ...(options.free === undefined ? {} : {gpuFreeBytes: options.free}),
    choice: options.choice ?? 'auto',
    installed: options.installed ?? [],
    backendName: 'vulkan',
  });
}

describe('a machine with no usable GPU', () => {
  it('is refused, and the sentence says what is missing', () => {
    const result = plan({});
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.problem).toMatch(/GPU/u);
      expect(result.problem).toMatch(/vulkan/u);
      // It must not read as "not configured", which sends somebody looking for a
      // setting that does not exist.
      expect(result.problem).not.toMatch(/not ready|configure|settings/iu);
    }
  });

  /*
   * The override cannot conjure a device, so choosing High on a machine with no
   * GPU has to produce the same refusal rather than a download.
   */
  it('is refused even when the user explicitly asked for a tier', () => {
    for (const choice of ['low', 'high'] as const) {
      expect(plan({choice}).runnable).toBe(false);
    }
  });
});

describe('choosing for the user', () => {
  it('picks the big tier when the GPU has room for it', () => {
    const result = plan({free: 6 * GiB});
    expect(result).toMatchObject({
      runnable: true,
      tier: 'high',
      contextSize: 32768,
      fits: true,
      download: true,
    });
    expect(result.runnable && result.reason).toMatch(/fits on this GPU/u);
  });

  it('picks the small tier on a 4 GB card, and says why', () => {
    const result = plan({free: 4 * GiB});
    expect(result).toMatchObject({
      runnable: true,
      tier: 'low',
      contextSize: 16384,
      fits: true,
    });
    expect(result.runnable && result.reason).toMatch(/larger one does not/u);
  });

  /*
   * The graceful case that makes the tiers worth having: a card too small for the
   * target context still runs the small model at a smaller one, rather than
   * dropping to a refusal or overrunning the card.
   */
  it('gives the small tier a smaller window rather than refusing', () => {
    const result = plan({free: 3.5 * GiB});
    expect(result).toMatchObject({
      runnable: true,
      tier: 'low',
      contextSize: 8192,
      fits: true,
    });
  });

  it('refuses when even the small tier will not fit, with both numbers', () => {
    const result = plan({free: 2 * GiB});
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.problem).toMatch(/2\.0 GB free/u);
      expect(result.problem).toMatch(/needs about/u);
    }
  });

  it('does not offer to download a tier that is already installed', () => {
    expect(plan({free: 6 * GiB, installed: ['high']})).toMatchObject({
      download: false,
    });
    expect(plan({free: 4 * GiB, installed: ['high']})).toMatchObject({
      download: true,
    });
  });
});

describe('the manual override', () => {
  it('does what it is told and does not second-guess it', () => {
    const result = plan({free: 4 * GiB, choice: 'high'});
    expect(result).toMatchObject({
      runnable: true,
      tier: 'high',
      fits: false,
      download: true,
    });
  });

  /*
   * The warning carries both numbers, because "this may not fit" without them
   * leaves somebody unable to tell whether closing a game would help.
   */
  it('warns with the numbers when the choice looks too big', () => {
    const result = plan({free: 4 * GiB, choice: 'high'});
    expect(result.runnable && result.reason).toMatch(/5\.[0-9] GB/u);
    expect(result.runnable && result.reason).toMatch(/4\.0 GB/u);
  });

  it('says plainly when the choice is a comfortable one', () => {
    const result = plan({free: 8 * GiB, choice: 'low'});
    expect(result.runnable && result.reason).toBe('You chose Low.');
    expect(result.runnable && result.contextSize).toBe(16384);
  });

  it('still gives an overruled choice the largest window that fits', () => {
    /*
     * High wants 5.43 GiB at 32K and 5.17 GiB at 16K, so a card reporting 5.3
     * lands between the two: the choice is honoured, the window is not.
     */
    const result = plan({free: 5.3 * GiB, choice: 'high'});
    expect(result).toMatchObject({contextSize: 16384, fits: true});
  });
});

describe('the memory estimate', () => {
  it('grows with the context and not with anything else', () => {
    const parsed = manifest();
    const low = parsed.weights.tiers.low;
    expect(estimatedResidentBytes(parsed, low, 32768)).toBeGreaterThan(
      estimatedResidentBytes(parsed, low, 16384),
    );
    expect(requiredFreeBytes(parsed, low, 8192)).toBe(
      estimatedResidentBytes(parsed, low, 8192) + SAFETY_MARGIN_BYTES,
    );
  });

  /*
   * The cache is half the size because it is quantized, and that is not a detail:
   * at 32K it is the difference between 0.5 GB and 1 GB on a 4 GB card.
   */
  it('counts a quantized cache, which is what makes the context affordable', () => {
    const parsed = manifest();
    const low = parsed.weights.tiers.low;
    const cache =
      estimatedResidentBytes(parsed, low, 32768) - low.bytes - 384 * MiB;
    expect(cache).toBe((32768 * 32768) / 2);
  });

  it('stops halving at the floor rather than going to nothing', () => {
    const parsed = manifest();
    expect(contextThatFits(parsed, parsed.weights.tiers.low, 100)).toBeUndefined();
    expect(CONTEXT_FLOOR).toBe(8192);
  });
});

describe('formatBytes', () => {
  it('reads the way a person says a size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * MiB)).toBe('2.0 MB');
    expect(formatBytes(4_482_403_488)).toBe('4.2 GB');
    expect(formatBytes(12 * GiB)).toBe('12 GB');
  });
});
