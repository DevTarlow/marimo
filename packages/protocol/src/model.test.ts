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
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  MODEL_TIERS,
  MODEL_TIER_CHOICES,
  defaultAppearance,
  defaultCompanionSettings,
  defaultDiscordSettings,
  defaultRecallSettings,
  defaultWindowState,
  modelTierChoiceSchema,
  modelTierSchema,
  recallSettingsSchema,
  settingsPatchSchema,
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

/**
 * The recall block, and the default that downloads nothing.
 *
 * Recall is off until somebody asks for it: turning it on fetches 310 MB and
 * starts a second engine process, and a fresh install that did that unasked would
 * be the same failure Discord's default exists to prevent. So the default is
 * asserted rather than left to a `false` in whichever file builds it first.
 */
describe('the recall settings', () => {
  it('is off, with both corpora ready for when it is on', () => {
    expect(defaultRecallSettings()).toEqual({
      enabled: false,
      memory: true,
      workspace: true,
    });
  });

  it('is part of the settings document', () => {
    expect(settingsSchema.shape.recall).toBeDefined();
    expect(settingsSchema.safeParse({...settingsShape(), recall: undefined}).success).toBe(
      false,
    );
  });

  /*
   * A window that moved one switch must not have to send the other two back: a
   * stale copy of them is exactly what must not win, which is why this is a
   * partial block merged over what is stored.
   */
  it('accepts a patch touching one switch of the block', () => {
    const parsed = settingsPatchSchema.safeParse({recall: {enabled: true}});

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.recall).toEqual({enabled: true});
  });

  it('refuses a block whose switches are not switches', () => {
    expect(
      recallSettingsSchema.safeParse({enabled: 'yes', memory: true, workspace: true})
        .success,
    ).toBe(false);
  });
});

/** The smallest object the settings schema accepts, for the one test that needs it. */
function settingsShape(): Record<string, unknown> {
  return {
    experienceMode: 'power',
    appearance: defaultAppearance(),
    temperature: 0.7,
    modelTier: 'auto',
    allowPrivateNetworkFetch: false,
    mcpServers: [],
    discord: defaultDiscordSettings(),
    companion: defaultCompanionSettings(),
    sidebarWidth: 272,
    todosWidth: 288,
    jobsWidth: 288,
    notesWidth: 288,
    filesWidth: 320,
    filesOpen: false,
    expandedSections: [],
    disabledCommands: [],
    window: defaultWindowState(),
    memorySoftLimitBytes: DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    recall: defaultRecallSettings(),
  };
}
