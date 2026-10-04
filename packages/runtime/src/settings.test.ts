/**
 * The default-model rule, which is what stops the app from pointing at a model
 * the provider has retired.
 *
 * `deepseek-chat` and `deepseek-reasoner` were real model ids once; a build that
 * hardcodes them silently breaks the first time the provider renames its line
 * up, which is exactly what happened here.
 */
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {DEFAULT_BACKGROUND_DARKNESS, PROVIDERS} from '@marimo/protocol';

import {
  chooseModel,
  readLegacyProfileSeed,
  SettingsStore,
} from './settings.js';

describe('chooseModel', () => {
  it('keeps the current model while the provider still offers it', () => {
    expect(
      chooseModel(['deepseek-flash', 'deepseek-v4-pro'], 'deepseek-v4-pro'),
    ).toBe('deepseek-v4-pro');
  });

  it('moves off a model that has disappeared', () => {
    expect(
      chooseModel(['deepseek-flash', 'deepseek-v4-pro'], 'deepseek-chat'),
    ).toBe('deepseek-flash');
  });

  it('prefers a fast tier when the whole list is new', () => {
    expect(
      chooseModel(['deepseek-v4-pro', 'deepseek-flash'], 'deepseek-chat'),
    ).toBe('deepseek-flash');
    expect(chooseModel(['some-pro-model', 'some-mini-model'], 'gone')).toBe(
      'some-mini-model',
    );
  });

  it('falls back to the first model when nothing looks cheap', () => {
    expect(chooseModel(['alpha', 'beta'], 'gone')).toBe('alpha');
  });
});

describe('readLegacyProfileSeed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('keeps the workspace and prompt a pre-profile file held', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        model: 'deepseek-flash',
        workspaceRoot: '/home/me/project',
        systemPrompt: 'You are the old prompt.',
      }),
      'utf8',
    );
    expect(await readLegacyProfileSeed(file)).toEqual({
      workspaceRoot: '/home/me/project',
      systemPrompt: 'You are the old prompt.',
    });
  });

  it('ignores a new-format file and a file that is not there', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({model: 'deepseek-flash'}), 'utf8');
    expect(await readLegacyProfileSeed(file)).toEqual({});
    expect(await readLegacyProfileSeed(join(dir, 'missing.json'))).toEqual({});
  });

  it('ignores blank or wrong-typed values', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({workspaceRoot: '   ', systemPrompt: 42}),
      'utf8',
    );
    // A blank prompt must not win over the default identity.
    expect(await readLegacyProfileSeed(file)).toEqual({});
  });
});

/**
 * The settings file, and the one nested object in it.
 *
 * Discord is a block inside a flat document, which is exactly the shape that
 * breaks an upgrade if it is read carelessly: a file written before the block
 * existed, or one a user edited by hand, must not cost them the model they
 * chose and the folders they sized.
 */
describe('SettingsStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-store-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts with Discord off and nothing configured', async () => {
    const settings = await store().load();
    expect(settings.discord).toEqual({
      enabled: false,
      channelId: '',
      channelName: '',
      guildName: '',
      autoReply: true,
      botUserId: '',
      botName: '',
    });
  });

  it('reads a file written before Discord existed', async () => {
    await write({model: 'deepseek-v4-pro', sidebarWidth: 320});
    const settings = await store().load();

    // The old settings survive, and the block arrives at its defaults.
    expect(settings.providers.configs.deepseek.model).toBe('deepseek-v4-pro');
    expect(settings.sidebarWidth).toBe(320);
    expect(settings.discord.enabled).toBe(false);
  });

  it('falls back on a block that does not validate, keeping the rest', async () => {
    await write({
      model: 'deepseek-v4-pro',
      discord: {enabled: true, channelId: 42},
    });
    const settings = await store().load();

    expect(settings.providers.configs.deepseek.model).toBe('deepseek-v4-pro');
    expect(settings.discord.channelId).toBe('');
  });

  it('fills in a short block rather than discarding it', async () => {
    await write({discord: {enabled: true, channelId: '100'}});
    const settings = await store().load();

    expect(settings.discord.enabled).toBe(true);
    expect(settings.discord.channelId).toBe('100');
    // Fields the file never mentioned keep their defaults.
    expect(settings.discord.autoReply).toBe(true);
  });

  it('merges a partial Discord patch over what is stored', async () => {
    const settings = store();
    await settings.patch({
      discord: {
        channelId: '100',
        channelName: 'general',
        guildName: 'Marimo HQ',
      },
    });
    const after = await settings.patch({discord: {enabled: true}});

    // Flipping one switch must not send the channel back, and must not lose it.
    expect(after.discord).toMatchObject({
      enabled: true,
      channelId: '100',
      channelName: 'general',
      guildName: 'Marimo HQ',
    });
  });

  it('leaves Discord alone when a flat setting changes', async () => {
    const settings = store();
    await settings.patch({discord: {channelId: '100', enabled: true}});
    const after = await settings.patch({temperature: 0.2});

    expect(after.temperature).toBe(0.2);
    expect(after.discord.enabled).toBe(true);
    expect(after.discord.channelId).toBe('100');
  });

  it('keeps the provider list it was told, across a Discord write', async () => {
    const settings = store();
    await settings.setAvailableModels('deepseek', [
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
    const after = await settings.patch({discord: {enabled: true}});

    expect(after.availableModels.deepseek).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
  });
});

/**
 * The provider block, which replaced two flat fields.
 *
 * The upgrade path is the part worth testing: a file written when DeepSeek was
 * the only backend holds `model` and `baseUrl` at the top level, and those two
 * values are the user's — a wrong default here silently points the app at
 * somebody else's idea of a model.
 */
describe('SettingsStore providers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-providers-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts on DeepSeek with all four addresses ready', async () => {
    const settings = await store().load();
    expect(settings.providers.active).toBe('deepseek');
    expect(settings.providers.configs.llamacpp.baseUrl).toContain('127.0.0.1');
    expect(settings.providers.configs.gemini.baseUrl).toContain(
      'generativelanguage.googleapis.com',
    );
    expect(settings.providers.configs.openrouter.baseUrl).toBe(
      PROVIDERS.openrouter.defaultBaseUrl,
    );
  });

  /**
   * The file that gets written next is the one every earlier version of the app
   * reads, and OpenRouter is the first provider added after the picker existed.
   * This is the case that says a settings file predating the fourth entry loads
   * with the other three untouched and the new one filled from the catalogue
   * rather than left undefined.
   */
  it('adds OpenRouter to a file written before it existed', async () => {
    await write({
      providers: {
        active: 'gemini',
        configs: {
          deepseek: {
            model: 'deepseek-v4-pro',
            baseUrl: 'https://ds.example/v1',
          },
          gemini: {model: 'g-1'},
        },
      },
    });
    const settings = await store().load();

    expect(settings.providers.active).toBe('gemini');
    expect(settings.providers.configs.deepseek.model).toBe('deepseek-v4-pro');
    expect(settings.providers.configs.deepseek.baseUrl).toBe(
      'https://ds.example/v1',
    );
    expect(settings.providers.configs.gemini.model).toBe('g-1');
    expect(settings.providers.configs.openrouter).toEqual({
      baseUrl: PROVIDERS.openrouter.defaultBaseUrl,
      model: PROVIDERS.openrouter.fallbackModels[0],
    });
    // And it comes back out of a save unmangled, address included.
    expect(settings.availableModels.openrouter).toEqual([
      ...PROVIDERS.openrouter.fallbackModels,
    ]);
  });

  it('moves a pre-picker model and base URL onto DeepSeek', async () => {
    await write({
      model: 'deepseek-v4-pro',
      baseUrl: 'http://box.local:11434/v1',
      temperature: 0.3,
    });
    const settings = await store().load();

    expect(settings.providers.configs.deepseek).toEqual({
      model: 'deepseek-v4-pro',
      baseUrl: 'http://box.local:11434/v1',
    });
    expect(settings.providers.active).toBe('deepseek');
    expect(settings.temperature).toBe(0.3);
  });

  it('prefers the block over the legacy fields when both are present', async () => {
    await write({
      model: 'legacy-model',
      providers: {
        active: 'gemini',
        configs: {deepseek: {model: 'deepseek-flash'}},
      },
    });
    const settings = await store().load();

    expect(settings.providers.active).toBe('gemini');
    expect(settings.providers.configs.deepseek.model).toBe('deepseek-flash');
    // The providers the file never mentioned keep their own defaults.
    expect(settings.providers.configs.gemini.model).toBe(
      PROVIDERS.gemini.fallbackModels[0],
    );
  });

  it('falls back on one provider without losing the others', async () => {
    await write({
      providers: {
        active: 'llamacpp',
        configs: {
          llamacpp: {baseUrl: 'http://192.168.1.20:8080/v1'},
          gemini: {baseUrl: 42},
        },
      },
    });
    const settings = await store().load();

    // The hand-typed network address survives a typo in a block nobody was using.
    expect(settings.providers.active).toBe('llamacpp');
    expect(settings.providers.configs.llamacpp.baseUrl).toBe(
      'http://192.168.1.20:8080/v1',
    );
    expect(settings.providers.configs.llamacpp.model).toBe(
      PROVIDERS.llamacpp.fallbackModels[0],
    );
    expect(settings.providers.configs.gemini.baseUrl).toBe(
      PROVIDERS.gemini.defaultBaseUrl,
    );
  });

  it('merges a provider patch without touching the other two', async () => {
    const settings = store();
    await settings.patch({
      providers: {active: 'gemini', configs: {gemini: {model: 'g-1'}}},
    });
    // A later write that only switches provider must not send the addresses
    // back — a stale window's copy of those is exactly what must not win.
    const after = await settings.patch({providers: {active: 'deepseek'}});

    expect(after.providers.active).toBe('deepseek');
    expect(after.providers.configs.gemini.model).toBe('g-1');
    expect(after.providers.configs.llamacpp.baseUrl).toBe(
      PROVIDERS.llamacpp.defaultBaseUrl,
    );
  });

  it('keeps one model list per provider', async () => {
    const settings = store();
    await settings.setAvailableModels('gemini', ['gemini-a', 'gemini-b']);
    const after = await settings.setAvailableModels('llamacpp', ['local-x']);

    expect(after.availableModels.gemini).toEqual(['gemini-a', 'gemini-b']);
    expect(after.availableModels.llamacpp).toEqual(['local-x']);
    // DeepSeek was never asked, so it keeps the placeholder it shipped with.
    expect(after.availableModels.deepseek).toEqual([
      ...PROVIDERS.deepseek.fallbackModels,
    ]);
  });

  it('moves only the refreshed provider off a retired model', async () => {
    const settings = store();
    await settings.setAvailableModels('gemini', ['gemini-a']);
    await settings.patch({
      providers: {configs: {deepseek: {model: 'deepseek-chat'}}},
    });
    const after = await settings.setAvailableModels('deepseek', [
      'deepseek-flash',
    ]);

    expect(after.providers.configs.deepseek.model).toBe('deepseek-flash');
    // Untouched: a refresh is an answer about one endpoint.
    expect(after.providers.configs.gemini.model).toBe('gemini-a');
  });

  it('ignores a stored list that is not a list, per provider', async () => {
    await write({availableModels: ['deepseek-flash']});
    const settings = await store().load();

    // The old flat array was DeepSeek's list, so it is read as exactly that.
    expect(settings.availableModels.deepseek).toEqual(['deepseek-flash']);
    expect(settings.availableModels.gemini).toEqual([
      ...PROVIDERS.gemini.fallbackModels,
    ]);
  });
});

/**
 * The folded sections of the settings dialog.
 *
 * Layout state, stored beside the rail widths for the same reason: a section the
 * user folded away has to still be folded the next time they open the dialog, or
 * they will fold the same four sections on every launch.
 */
describe('SettingsStore collapsedSections', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-collapsed-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts with nothing folded, so the dialog looks as it always did', async () => {
    const settings = await store().load();
    expect(settings.collapsedSections).toEqual([]);
  });

  it('keeps the folded sections through another settings write', async () => {
    const settings = store();
    await settings.patch({collapsedSections: ['Limits', 'Discord']});
    const after = await settings.patch({temperature: 0.2});

    expect(after.collapsedSections).toEqual(['Limits', 'Discord']);
    expect(after.temperature).toBe(0.2);
  });

  it('gives a file written before the field existed an empty list', async () => {
    await write({sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.collapsedSections).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('folds a value that is not a list instead of losing the rest', async () => {
    /*
     * This is why the field carries a `.catch`. It is a flat setting, and a flat
     * setting that fails the schema takes the *whole file* down with it — the
     * user would lose their model, their folders and their Discord setup over a
     * hand-edited list of section names. Falling back to "nothing folded" is the
     * only sane reading of a value that is not a list of names anyway.
     */
    await write({collapsedSections: 42, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.collapsedSections).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('drops names it does not recognise rather than refusing the file', async () => {
    // A section that was renamed leaves a stale name behind, which has to be
    // harmless: the renderer folds by title and simply never matches it.
    await write({
      collapsedSections: ['Limits', 'A section from an older build'],
    });
    const settings = await store().load();

    expect(settings.collapsedSections).toEqual([
      'Limits',
      'A section from an older build',
    ]);
  });
});

/**
 * The appearance block: a choice with three fields, none of which may take the
 * others down with it.
 */
describe('SettingsStore appearance', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-appearance-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts on the shipped picture and the stylesheet accent', async () => {
    const settings = await store().load();
    expect(settings.appearance).toEqual({
      background: '',
      accent: '',
      uiScale: 'default',
      backgroundDarkness: DEFAULT_BACKGROUND_DARKNESS,
    });
  });

  it('merges one field without clearing the others', async () => {
    const settings = store();
    await settings.patch({
      appearance: {background: 'wall.jpg', accent: '#2fb6a8'},
    });
    const after = await settings.patch({appearance: {uiScale: 'large'}});

    expect(after.appearance).toEqual({
      background: 'wall.jpg',
      accent: '#2fb6a8',
      uiScale: 'large',
      backgroundDarkness: DEFAULT_BACKGROUND_DARKNESS,
    });
  });

  it('refuses an accent that is not a colour, keeping the block', async () => {
    await write({
      appearance: {background: 'wall.jpg', accent: 'red', uiScale: 'compact'},
    });
    const settings = await store().load();

    // The block falls back whole rather than storing a value that cannot be
    // pasted into a CSS variable.
    expect(settings.appearance).toEqual({
      background: '',
      accent: '',
      uiScale: 'default',
      backgroundDarkness: DEFAULT_BACKGROUND_DARKNESS,
    });
  });

  it('accepts a six-digit hex accent', async () => {
    const settings = store();
    const after = await settings.patch({appearance: {accent: '#8B7CF6'}});
    expect(after.appearance.accent).toBe('#8B7CF6');
  });

  it('keeps a darkness the user chose, through another appearance write', async () => {
    const settings = store();
    await settings.patch({appearance: {backgroundDarkness: 88}});
    const after = await settings.patch({appearance: {uiScale: 'compact'}});

    expect(after.appearance.backgroundDarkness).toBe(88);
  });

  it('gives a file written before the slider existed the default darkness', async () => {
    // The upgrade path, and the reason this field is added inside the block
    // rather than as a flat setting: a file from the build before the slider has
    // no `backgroundDarkness`, and must come back at the design's own value with
    // the rest of the block intact.
    await write({
      appearance: {background: 'wall.jpg', accent: '#2fb6a8', uiScale: 'large'},
    });
    const settings = await store().load();

    expect(settings.appearance).toEqual({
      background: 'wall.jpg',
      accent: '#2fb6a8',
      uiScale: 'large',
      backgroundDarkness: DEFAULT_BACKGROUND_DARKNESS,
    });
  });

  it('refuses a darkness outside the range, keeping the block', async () => {
    await write({
      appearance: {background: 'wall.jpg', backgroundDarkness: 140},
    });
    const settings = await store().load();

    // Out of range falls back with the block, rather than being clamped into a
    // value the user never chose.
    expect(settings.appearance.backgroundDarkness).toBe(
      DEFAULT_BACKGROUND_DARKNESS,
    );
    expect(settings.appearance.background).toBe('');
  });

  it('refuses a fractional darkness', async () => {
    // An integer percentage, because it is a slider position shown as a number.
    await write({appearance: {backgroundDarkness: 74.5}});
    const settings = await store().load();
    expect(settings.appearance.backgroundDarkness).toBe(
      DEFAULT_BACKGROUND_DARKNESS,
    );
  });
});

/**
 * The window block: where the app was when it last closed.
 *
 * The failure this guards is not a crash but an app that is running with nothing
 * to click, so the block has to be one a hand-edited file can lose on its own and
 * one an older file simply gets a default for.
 */
describe('SettingsStore window', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-window-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts with a size and no position, so the OS places the first window', async () => {
    const settings = await store().load();
    expect(settings.window).toEqual({
      width: 1180,
      height: 780,
      x: null,
      y: null,
    });
  });

  it('keeps the remembered bounds through another settings write', async () => {
    const settings = store();
    await settings.patch({window: {width: 1024, height: 640, x: 10, y: 20}});
    const after = await settings.patch({temperature: 0.2});

    expect(after.window).toEqual({width: 1024, height: 640, x: 10, y: 20});
    expect(after.temperature).toBe(0.2);
  });

  it('gives a file written before the block existed the default window', async () => {
    await write({sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.window.width).toBe(1180);
    expect(settings.window.x).toBeNull();
    // And the rest of the file still loads, which is the point of filling the
    // block rather than parsing the document whole.
    expect(settings.sidebarWidth).toBe(300);
  });

  it('falls back on the block alone when it is nonsense', async () => {
    await write({window: {width: 'wide'}, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.window.width).toBe(1180);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('keeps a position that is negative, because a second monitor is', async () => {
    // Coordinates left of and above the primary display are ordinary on a
    // multi-monitor desk, and refusing them would silently centre the window
    // every launch for the people most likely to move it.
    await write({window: {width: 1024, height: 640, x: -1600, y: -200}});
    const settings = await store().load();

    expect(settings.window).toEqual({
      width: 1024,
      height: 640,
      x: -1600,
      y: -200,
    });
  });
});
