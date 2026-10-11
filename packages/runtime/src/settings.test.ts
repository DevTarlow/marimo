/**
 * Settings persistence, and the one thing it has to be lenient about.
 *
 * The file is hand-editable and has changed shape several times — most recently
 * when the app stopped having a provider catalogue. A field this build no longer
 * knows must cost its own value and nothing else, because a settings file that
 * fails to parse is every preference the user has, reset at once.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  MEMORY_SOFT_LIMIT_MAX_BYTES,
} from '@marimo/protocol';

import {MAX_MEMORY_BYTES} from '@marimo/agent';

import {readLegacyProfileSeed, SettingsStore} from './settings.js';

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
    await write({temperature: 0.3, sidebarWidth: 320});
    const settings = await store().load();

    // The old settings survive, and the block arrives at its defaults.
    expect(settings.temperature).toBe(0.3);
    expect(settings.sidebarWidth).toBe(320);
    expect(settings.discord.enabled).toBe(false);
  });

  it('falls back on a block that does not validate, keeping the rest', async () => {
    await write({
      temperature: 0.3,
      discord: {enabled: true, channelId: 42},
    });
    const settings = await store().load();

    expect(settings.temperature).toBe(0.3);
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

});

/**
 * A settings file written by a build that had a provider catalogue.
 *
 * That file holds `providers`, `availableModels` and `localModel`, and it may
 * name a service — DeepSeek, Gemini, somebody's own llama.cpp server — with an
 * address and a model id. None of it has a reader now: the app carries one model
 * and always runs it.
 *
 * So the whole point is what *survives*: the connectors, the layout, the
 * companion and every other preference in the same document must come through
 * untouched. A read that failed on a field it did not recognise would reset all
 * of them at once, and the user would have no idea which line did it.
 */
describe('SettingsStore, on a file from the provider era', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-provider-era-'));
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

  /** What such a file looked like: two providers, a list, and the knobs. */
  function providerEraFile(): Record<string, unknown> {
    return {
      version: 1,
      providers: {
        active: 'deepseek',
        configs: {
          builtin: {baseUrl: 'http://127.0.0.1:8137/v1', model: 'qwen3-1.7b'},
          deepseek: {baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro'},
        },
      },
      availableModels: {
        builtin: ['qwen3-1.7b'],
        deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
      },
      localModel: {
        ggufPath: '/home/sam/other.gguf',
        contextSize: 32768,
        thinking: true,
      },
      allowPlaintextApiKey: true,
      temperature: 0.2,
      sidebarWidth: 320,
      disabledCommands: ['compact'],
    };
  }

  it('drops what it no longer knows and keeps everything else', async () => {
    await write(providerEraFile());
    const settings = await store().load();

    expect(settings).not.toHaveProperty('providers');
    expect(settings).not.toHaveProperty('availableModels');
    expect(settings).not.toHaveProperty('localModel');
    expect(settings).not.toHaveProperty('allowPlaintextApiKey');

    expect(settings.temperature).toBe(0.2);
    expect(settings.sidebarWidth).toBe(320);
    expect(settings.disabledCommands).toEqual(['compact']);
  });

  it('does not write the old fields back on the next save', async () => {
    await write(providerEraFile());
    const settings = store();
    await settings.load();
    await settings.patch({temperature: 0.4});

    const written = JSON.parse(
      await readFile(join(dir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(written['temperature']).toBe(0.4);
    expect(written).not.toHaveProperty('providers');
    expect(written).not.toHaveProperty('localModel');
  });

  /*
   * The two flat fields at the top level predate the picker, and a build that
   * had the catalogue moved them onto DeepSeek. There is nowhere for them to go
   * now, and the one thing they must not do is stop the file from loading.
   */
  it('ignores the flat model and base URL from before the picker', async () => {
    await write({model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com'});
    const settings = await store().load();

    expect(settings).not.toHaveProperty('model');
    expect(settings).not.toHaveProperty('baseUrl');
    // Everything else is at its default, which is a working app.
    expect(settings.temperature).toBe(0.7);
  });
});

/**
 * The memory soft limit, which the Settings dialog draws as a slider.
 *
 * The schema is a client of it too — the renderer's slider can only produce
 * values the schema accepts — so the bounds are what stops a hand-edited file
 * from setting a limit that makes the agent's warning nonsense.
 */
/**
 * The tier override, which is the one switch that changes what gets downloaded.
 *
 * It is a preference like any other — which is exactly why it is worth a test:
 * a value that did not survive a restart would re-download 4.5 GB, or silently
 * run the smaller model on a machine the user had already told the app about.
 */
describe('SettingsStore modelTier', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-tier-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('lets the app decide on a fresh install', async () => {
    expect((await store().load()).modelTier).toBe('auto');
  });

  it('keeps an override through a write and a restart', async () => {
    const settings = store();
    await settings.patch({modelTier: 'high'});
    await settings.patch({temperature: 0.2});

    expect((await store().load()).modelTier).toBe('high');
  });

  it('keeps the rest of the file when the override is set', async () => {
    const settings = store();
    await settings.patch({temperature: 0.2});
    const after = await settings.patch({modelTier: 'low'});

    expect(after.temperature).toBe(0.2);
    expect(after.modelTier).toBe('low');
  });

  /*
   * A hand-edited word must cost the choice its own value rather than the whole
   * document: the alternative is a typo resetting the connectors and every layout
   * width beside it.
   */
  it('falls back to the app deciding when the stored word is wrong', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({version: 1, modelTier: 'medium', sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.modelTier).toBe('auto');
    expect(settings.sidebarWidth).toBe(300);
  });

  it('gives a file written before the field existed the automatic answer', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({version: 1, sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.modelTier).toBe('auto');
    expect(settings.sidebarWidth).toBe(300);
  });
});

describe('SettingsStore memorySoftLimitBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-memlimit-'));
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

  it('defaults to the limit the agent warns at', async () => {
    expect((await store().load()).memorySoftLimitBytes).toBe(
      DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    );
  });

  it('keeps a value the user chose', async () => {
    const settings = store();
    await settings.patch({memorySoftLimitBytes: 16 * 1024});
    await settings.patch({temperature: 0.2});
    expect((await settings.load()).memorySoftLimitBytes).toBe(16 * 1024);
  });

  /*
   * A file holding a limit the agent cannot act on falls back rather than
   * failing the whole document: losing every provider because somebody typed a
   * bad number into one field would be the worse outcome.
   */
  it('falls back when the stored value is out of range', async () => {
    await write({memorySoftLimitBytes: 1});
    expect((await store().load()).memorySoftLimitBytes).toBe(
      DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    );
  });

  it('refuses a value that is not a whole KiB', async () => {
    await write({memorySoftLimitBytes: 8 * 1024 + 1});
    expect((await store().load()).memorySoftLimitBytes).toBe(
      DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    );
  });

  it('keeps the limit strictly under the hard cap it warns about', async () => {
    // The ceiling the schema allows is half the hard cap, so a memory the user
    // has told the agent to let grow still crosses the warning before writes
    // start failing.
    expect(MEMORY_SOFT_LIMIT_MAX_BYTES).toBeLessThan(MAX_MEMORY_BYTES);
  });
});

describe('SettingsStore expandedSections', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-expanded-'));
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

  it('starts with every section folded', async () => {
    const settings = await store().load();
    expect(settings.expandedSections).toEqual([]);
  });

  it('keeps the opened sections through another settings write', async () => {
    const settings = store();
    await settings.patch({expandedSections: ['Limits', 'Discord']});
    const after = await settings.patch({temperature: 0.2});

    expect(after.expandedSections).toEqual(['Limits', 'Discord']);
    expect(after.temperature).toBe(0.2);
  });

  it('gives a file written before the field existed an empty list', async () => {
    /*
     * Empty is "every section folded", which is where the dialog starts anyway:
     * an older file opens on the same page a fresh install does, rather than on
     * the eight cards the field replaced.
     */
    await write({sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.expandedSections).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('discards a value that is not a list instead of losing the rest', async () => {
    /*
     * This is why the field carries a `.catch`. It is a flat setting, and a flat
     * setting that fails the schema takes the *whole file* down with it — the
     * user would lose their model, their folders and their Discord setup over a
     * hand-edited list of section names. Falling back to "nothing opened" is the
     * only sane reading of a value that is not a list of names anyway, and it
     * folds the dialog rather than opening all of it.
     */
    await write({expandedSections: 42, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.expandedSections).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('drops names it does not recognise rather than refusing the file', async () => {
    // A section that was renamed leaves a stale name behind, which has to be
    // harmless: the renderer opens by title and simply never matches it.
    await write({
      expandedSections: ['Limits', 'A section from an older build'],
    });
    const settings = await store().load();

    expect(settings.expandedSections).toEqual([
      'Limits',
      'A section from an older build',
    ]);
  });
});

/**
 * The commands the user has switched off.
 *
 * Stored as the *disabled* half so that a command added in a later build is
 * available without anybody touching this setting — and carrying a `.catch`,
 * because a command renamed or removed later must cost its own row rather than
 * fail the whole settings schema.
 */
describe('SettingsStore disabledCommands', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-commands-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('offers every command on a fresh install', async () => {
    expect((await store().load()).disabledCommands).toEqual([]);
  });

  it('remembers what was switched off, and only that', async () => {
    const settings = store();
    const off = await settings.patch({disabledCommands: ['compact']});
    expect(off.disabledCommands).toEqual(['compact']);

    // A later write of something else must not bring it back.
    const after = await settings.patch({temperature: 0.2});
    expect(after.disabledCommands).toEqual(['compact']);
    expect(after.temperature).toBe(0.2);
  });

  it('gives a file written before the field existed nothing switched off', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.disabledCommands).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('ignores a command this build does not know, rather than the file', async () => {
    /*
     * The failure this prevents is the one `.catch` is for: a name from a newer
     * build — or a typo — inside a flat field would otherwise fail the whole
     * settings schema, and the user would lose their model, their folders and
     * their key setup over one string.
     */
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(
        {
          disabledCommands: ['compact', 'a-command-from-a-newer-build'],
          sidebarWidth: 300,
        },
        null,
        2,
      ),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.disabledCommands).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });
});

/**
 * How much of the app to draw.
 *
 * The one setting whose default depends on *how* the document was read rather
 * than on what it holds: "no file" and "a file with no such field" are the same
 * value to the schema and opposite answers to a person. A fresh install should
 * meet the simple screen; somebody who has been using the app for months should
 * not have the switches they rely on disappear because a build added a field
 * they never set.
 */
describe('SettingsStore experienceMode', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-mode-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('opens a fresh install on the simple screen', async () => {
    expect((await store().load()).experienceMode).toBe('simple');
  });

  it('leaves a file written before the field existed in the app in full', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.experienceMode).toBe('power');
    expect(settings.sidebarWidth).toBe(300);
  });

  /*
   * A corrupt file is not a fresh install. The store reads leniently so the
   * window still opens, and the lenient reading of "unreadable" must not be
   * "show them less" — the user's file is still sitting there, and a later
   * build or a hand-repair may make it readable again.
   */
  it('treats an unreadable file as somebody who was already here', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json', 'utf8');
    expect((await store().load()).experienceMode).toBe('power');
  });

  it('keeps the choice, through a write and through a restart', async () => {
    const settings = store();
    expect(
      (await settings.patch({experienceMode: 'power'})).experienceMode,
    ).toBe('power');
    // An unrelated write must not bring the default back.
    await settings.patch({temperature: 0.2});
    // And a window opened later reads the file, not the default.
    expect((await store().load()).experienceMode).toBe('power');
  });

  /*
   * Why the field carries a `.catch`. It is flat, so a value the schema refuses
   * would fail the whole document — and fall back to every default, costing the
   * user their model, their folders and their Discord setup over one word. The
   * fallback is the app in full, which is the state that hides nothing.
   */
  it('costs the mode its own value rather than every other setting', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({experienceMode: 'wizard', sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.experienceMode).toBe('power');
    expect(settings.sidebarWidth).toBe(300);
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

  it('starts by following the machine', async () => {
    const settings = await store().load();
    expect(settings.appearance).toEqual({theme: 'system'});
  });

  /*
   * The merge behaviour the block was always about: flipping one thing must not
   * clear another, which is why the patch schema accepts a subset.
   */
  it('merges a change without clearing the rest of the block', async () => {
    const settings = store();
    await settings.patch({appearance: {theme: 'dark'}});
    const after = await settings.patch({appearance: {}});

    expect(after.appearance.theme).toBe('dark');
  });

  it('keeps a choice through an unrelated write', async () => {
    const settings = store();
    await settings.patch({appearance: {theme: 'light'}});
    const after = await settings.patch({temperature: 0.2});

    expect(after.appearance.theme).toBe('light');
  });

  it('refuses a theme that is not one of the three', async () => {
    const settings = store();
    await expect(
      settings.patch({appearance: {theme: 'sepia' as never}}),
    ).rejects.toThrow();
    // And the block is untouched rather than half-written.
    expect((await settings.load()).appearance.theme).toBe('system');
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

/*
 * Invariant 12 for the settings document, and the subtlety that makes it
 * different from every other one.
 *
 * The settings file has never carried a version — `storedSettingsSchema` has no
 * such field — so *every* settings file in existence is version-less, and
 * treating that as "not mine" would reset every user's providers, connectors and
 * preferences the first time they upgraded. A version-less file is version 1, and
 * that is the migration.
 *
 * A file from a future build is still refused, which is the half that matters.
 */
describe('settings from another build', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-version-'));
    file = join(dir, 'settings.json');
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SettingsStore {
    return new SettingsStore(file);
  }

  it('opens a version-less file, which is every settings file there is', async () => {
    // The shape a real install has on disk right now.
    await writeFile(
      file,
      JSON.stringify({temperature: 0.9, sidebarWidth: 321}),
      'utf8',
    );

    const settings = await store().load();

    expect(settings.temperature).toBe(0.9);
    expect(settings.sidebarWidth).toBe(321);
  });

  it('stamps a version when it writes, so this is only needed once', async () => {
    await writeFile(file, JSON.stringify({temperature: 0.9}), 'utf8');
    const settings = store();
    await settings.load();
    await settings.patch({temperature: 0.5});

    const written = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
    };
    expect(written.version).toBe(1);
  });

  it('refuses a file from a newer build, and leaves it alone', async () => {
    const future = JSON.stringify({version: 99, temperature: 0.9});
    await writeFile(file, future, 'utf8');

    await expect(store().load()).rejects.toThrow(/newer version/u);
    expect(await readFile(file, 'utf8')).toBe(future);
  });

  it('refuses to write over a file from a newer build', async () => {
    const future = JSON.stringify({version: 99, temperature: 0.9});
    await writeFile(file, future, 'utf8');

    await expect(store().patch({temperature: 0.1})).rejects.toThrow(
      /newer version/u,
    );
    expect(await readFile(file, 'utf8')).toBe(future);
  });
});

/**
 * The companion block: how the moss ball answers and how it behaves.
 *
 * Two of the four are prompt text and two are the window's own behaviour, which
 * is why the block is one thing rather than a setting on the profile: the pet
 * shares the conversation with the window, and none of it belongs to a
 * conversation.
 */
describe('SettingsStore companion', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-companion-'));
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

  it('starts brief, floating, and showing six messages', async () => {
    const settings = await store().load();
    expect(settings.companion).toEqual({
      answerLength: 'brief',
      visibleMessages: 6,
      alwaysOnTop: true,
      clickThrough: true,
    });
  });

  it('gives a file written before the block existed the defaults', async () => {
    await write({temperature: 0.4, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.companion.answerLength).toBe('brief');
    // And the rest of the file is untouched.
    expect(settings.temperature).toBe(0.4);
  });

  it('fills in a short block rather than discarding it', async () => {
    await write({companion: {answerLength: 'detailed'}});
    const settings = await store().load();

    expect(settings.companion.answerLength).toBe('detailed');
    expect(settings.companion.visibleMessages).toBe(6);
  });

  it('merges a change without clearing the rest of the block', async () => {
    const settings = store();
    await settings.patch({companion: {visibleMessages: 12}});
    const after = await settings.patch({companion: {alwaysOnTop: false}});

    expect(after.companion.visibleMessages).toBe(12);
    expect(after.companion.alwaysOnTop).toBe(false);
    expect(after.companion.answerLength).toBe('brief');
  });

  it('keeps a choice through an unrelated write', async () => {
    const settings = store();
    await settings.patch({companion: {answerLength: 'balanced'}});
    const after = await settings.patch({temperature: 0.2});

    expect(after.companion.answerLength).toBe('balanced');
  });

  it('refuses a length that is not one of the three', async () => {
    const settings = store();
    await expect(
      settings.patch({companion: {answerLength: 'terse' as never}}),
    ).rejects.toThrow();
    expect((await settings.load()).companion.answerLength).toBe('brief');
  });

  it('refuses a bubble count that is not a usable number', async () => {
    const settings = store();
    await expect(
      settings.patch({companion: {visibleMessages: 0}}),
    ).rejects.toThrow();
    await expect(
      settings.patch({companion: {visibleMessages: 2.5}}),
    ).rejects.toThrow();
    expect((await settings.load()).companion.visibleMessages).toBe(6);
  });
});

/**
 * The recall block, in the settings store.
 *
 * It is a nested block, which means it is read the way the window block and the
 * Discord block are: validated whole against its defaults, so a hand-edited value
 * inside it costs that block rather than every other preference the user has —
 * and so a settings file written before recall existed loads as "off" rather than
 * failing.
 */
describe('the recall block', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-recall-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('defaults to off, on an install with no settings file at all', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'));

    expect((await store.load()).recall).toEqual({
      enabled: false,
      memory: true,
      workspace: true,
    });
  });

  it('reads a file that predates the feature as off', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({version: 1, temperature: 0.4, memorySoftLimitBytes: 8192}),
      'utf8',
    );

    const settings = await new SettingsStore(file).load();

    expect(settings.recall.enabled).toBe(false);
    // And the setting beside it survives, which is the whole point of filling the
    // block in rather than resetting the document.
    expect(settings.temperature).toBe(0.4);
  });

  /*
   * The leniency, tested at the one place it can go wrong: a block that does not
   * validate is replaced whole, and everything *around* it is kept. A parse that
   * took the document down with the block would lose the user's width and theme
   * because of one typo in a switch.
   */
  it('costs the block, not the document, when a switch is hand-edited wrong', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        temperature: 0.3,
        sidebarWidth: 300,
        recall: {enabled: 'yes', memory: true, workspace: true},
      }),
      'utf8',
    );

    const settings = await new SettingsStore(file).load();

    expect(settings.recall.enabled).toBe(false);
    expect(settings.temperature).toBe(0.3);
    expect(settings.sidebarWidth).toBe(300);
  });

  /* A patch touching one switch leaves the others as they were. */
  it('merges a partial block over what is stored', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'));
    await store.patch({recall: {enabled: true}});
    const merged = await store.patch({recall: {workspace: false}});

    expect(merged.recall).toEqual({enabled: true, memory: true, workspace: false});
  });
});
