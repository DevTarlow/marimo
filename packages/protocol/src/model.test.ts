/**
 * The tier vocabulary, and the two rules that matter about it.
 *
 * `auto` is a real answer rather than a placeholder: it means the app probes the
 * graphics card and picks. That distinction is the whole reason the type has three
 * members instead of two, and it is the thing a later change is most likely to
 * flatten — a `low`/`high` pair with a nullable default would lose the difference
 * between "the user chose the small one" and "the app decided the small one was all
 * this machine could take", which are different sentences to show somebody.
 *
 * The field is tested on its own rather than through a whole settings document.
 * A fixture built by hand would be a second copy of the schema, and it would fail
 * every time a field was added somewhere else — which is a test that reports the
 * wrong thing.
 */
import {describe, expect, it} from 'vitest';

import {
  MODEL_TIERS,
  MODEL_TIER_CHOICES,
  modelTierChoiceSchema,
  modelTierSchema,
  settingsSchema,
} from './index.js';

describe('the tier vocabulary', () => {
  it('names the two quantizations, smallest first', () => {
    expect([...MODEL_TIERS]).toEqual(['low', 'high']);
    expect(modelTierSchema.options).toEqual(['low', 'high']);
  });

  /*
   * `auto` leads, because it is the default and because the picker draws this
   * order — the answer the app can give about hardware it has looked at belongs
   * above the two a person can guess with.
   */
  it('offers the app deciding, above the two a person can pick', () => {
    expect([...MODEL_TIER_CHOICES]).toEqual(['auto', 'low', 'high']);
    expect(modelTierChoiceSchema.options).toEqual(['auto', 'low', 'high']);
  });

  it('refuses a tier nobody offers', () => {
    expect(modelTierChoiceSchema.safeParse('medium').success).toBe(false);
    expect(modelTierChoiceSchema.safeParse('').success).toBe(false);
  });
});

describe('the tier in a settings file', () => {
  const field = settingsSchema.shape.modelTier;

  it('is a field of the settings document, not a separate store', () => {
    // The switch belongs with the preferences rather than in the model
    // directory: it is a choice about behaviour, and the files on disk are what
    // that choice produced.
    expect(field).toBeDefined();
  });

  it('keeps a choice the user made', () => {
    expect(field.parse('high')).toBe('high');
    expect(field.parse('low')).toBe('low');
  });

  /*
   * `.catch` rather than a plain enum, for the reason `experienceMode` has it: one
   * hand-edited word must cost the choice its own value, not fail the whole parse
   * and reset every other preference the user has. What it falls back to is the app
   * deciding, which is the answer that cannot be wrong about somebody's hardware.
   */
  it('falls back to the app deciding when the word is wrong', () => {
    expect(field.parse('medium')).toBe('auto');
    expect(field.parse(7)).toBe('auto');
  });

  /*
   * A file written before the field existed has no such key, and the lenient read
   * has to give it the answer that works rather than refuse the document — which
   * would reset the connectors and every layout width beside it.
   */
  it('gives a file written before the field existed the automatic answer', () => {
    expect(field.parse(undefined)).toBe('auto');
  });
});
