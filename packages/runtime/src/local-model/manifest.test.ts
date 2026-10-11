/**
 * The shipped manifest, as a document this build can trust.
 *
 * The stakes changed when the app stopped carrying weights: a field that is wrong
 * here is no longer a broken build on a maintainer's machine, it is a first-run
 * download that fails on a user's. So the parse is strict, and these tests are
 * about the refusals as much as the happy path — each one names the field a
 * reader would have to go and fix.
 */
import {describe, expect, it} from 'vitest';

import {
  backendNameFor,
  engineAssetFor,
  engineUrl,
  ManifestError,
  parseManifest,
  platformKey,
  weightsUrl,
} from './manifest.js';

/** The smallest document that is a valid manifest. */
function fixture(): Record<string, unknown> {
  return {
    engine: {
      tag: 'b1',
      baseUrl: 'https://example.test/dl',
      assets: {
        'linux-x64': {file: 'engine.tar.gz', sha256: 'a'.repeat(64)},
      },
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
  };
}

/** The fixture with one path replaced, for the refusal cases. */
function without(path: string): Record<string, unknown> {
  const copy = structuredClone(fixture());
  const parts = path.split('.');
  let node = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  delete node[parts[parts.length - 1]!];
  return copy;
}

/** The fixture with one path set to something the parser should refuse. */
function withValue(path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(fixture());
  const parts = path.split('.');
  let node = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
  return copy;
}

describe('parseManifest', () => {
  it('reads the tiers, with their sizes and context targets', () => {
    const manifest = parseManifest(fixture());

    expect(manifest.weights.tiers.low).toMatchObject({
      name: 'low',
      label: 'Low',
      file: 'low.gguf',
      bytes: 2_740_937_888,
      contextSize: 16384,
    });
    expect(manifest.weights.tiers.high.contextSize).toBe(32768);
    expect(manifest.weights.kvBytesPerToken).toBe(32768);
  });

  it('reads the engine tag and base URL that the URLs are built from', () => {
    const manifest = parseManifest(fixture());
    expect(manifest.engine.tag).toBe('b1');
    expect(manifest.engine.baseUrl).toBe('https://example.test/dl');
  });

  it('refuses a document that is not an object at all', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest([])).toThrow(/not an object/u);
    expect(() => parseManifest('nope')).toThrow(/not an object/u);
  });

  it('refuses an empty asset list, which would fetch nothing', () => {
    expect(() => parseManifest(withValue('engine.assets', {}))).toThrow(
      /engine\.assets is empty/u,
    );
  });

  /*
   * A digest that is a placeholder or a truncated paste is the mistake that
   * reaches a user as "the download is corrupt", so it is caught at the door.
   */
  it('refuses a digest that is not a sha256', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), `${'a'.repeat(63)}z`]) {
      expect(() =>
        parseManifest(withValue('engine.assets.linux-x64.sha256', bad)),
      ).toThrow(/sha256/u);
    }
    expect(() =>
      parseManifest(withValue('weights.tiers.low.sha256', 'nope')),
    ).toThrow(/weights\.tiers\.low\.sha256 is not a sha256/u);
  });

  it('refuses a size that is not a positive whole number', () => {
    expect(() =>
      parseManifest(withValue('weights.tiers.high.bytes', 0)),
    ).toThrow(/bytes is not a positive whole number/u);
    expect(() =>
      parseManifest(withValue('weights.tiers.high.bytes', 1.5)),
    ).toThrow(/bytes is not a positive whole number/u);
    expect(() =>
      parseManifest(withValue('weights.tiers.high.contextSize', -1)),
    ).toThrow(/contextSize is not a positive whole number/u);
  });

  it('refuses a tier the build expects but the file does not carry', () => {
    expect(() => parseManifest(without('weights.tiers.high'))).toThrow(
      /weights\.tiers\.high is not an object/u,
    );
  });

  /*
   * An asset with no backend name is a platform whose engine cannot be described
   * to a user, and the sentence the refusal produces is the whole product in that
   * case — so the two have to be declared together.
   */
  it('refuses an asset with no backend name beside it', () => {
    expect(() => parseManifest(withValue('engine.backends', {}))).toThrow(
      /engine\.assets\.linux-x64 has no engine\.backends entry/u,
    );
  });

  it('refuses a missing field rather than defaulting it', () => {
    expect(() => parseManifest(without('engine.tag'))).toThrow(
      /engine\.tag is missing or empty/u,
    );
    expect(() => parseManifest(without('weights.repo'))).toThrow(
      /weights\.repo is missing or empty/u,
    );
    expect(() => parseManifest(without('weights.kvBytesPerToken'))).toThrow(
      /weights\.kvBytesPerToken/u,
    );
  });

  it('ignores the prose beside a map, which is for a reader', () => {
    const withNote = withValue('engine.backends', {
      note: 'why vulkan',
      'linux-x64': 'vulkan',
    });
    expect(parseManifest(withNote).engine.backends).toEqual({
      'linux-x64': 'vulkan',
    });
  });
});

describe('looking an engine up', () => {
  const manifest = parseManifest(fixture());

  it('finds the asset for a platform it was pinned for', () => {
    const found = engineAssetFor(manifest, {platform: 'linux', arch: 'x64'});
    expect(found?.key).toBe('linux-x64');
    expect(found?.asset.file).toBe('engine.tar.gz');
  });

  /*
   * `undefined` is a real answer: a platform with no engine is one where the app
   * cannot run its model, and the caller writes the sentence for that.
   */
  it('answers undefined for a platform this build does not ship', () => {
    expect(
      engineAssetFor(manifest, {platform: 'freebsd', arch: 'x64'}),
    ).toBeUndefined();
  });

  it('keys platforms the way a human reads them in the JSON', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('names the backend so a sentence can say Vulkan rather than GPU', () => {
    expect(backendNameFor(manifest, {platform: 'linux', arch: 'x64'})).toBe(
      'vulkan',
    );
    expect(
      backendNameFor(manifest, {platform: 'darwin', arch: 'arm64'}),
    ).toBeUndefined();
  });
});

describe('the URLs a download uses', () => {
  const manifest = parseManifest(fixture());

  it('puts the tag between the base URL and the file', () => {
    const found = engineAssetFor(manifest, {platform: 'linux', arch: 'x64'})!;
    expect(engineUrl(manifest, found.asset)).toBe(
      'https://example.test/dl/b1/engine.tar.gz',
    );
  });

  /*
   * The revision is in the URL rather than the branch name, which is what stops
   * a re-uploaded file changing what the app ships.
   */
  it('pins the weights to a revision, not a branch', () => {
    expect(weightsUrl(manifest, manifest.weights.tiers.high)).toBe(
      'https://huggingface.co/someone/model-GGUF/resolve/deadbeef/high.gguf',
    );
  });
});
