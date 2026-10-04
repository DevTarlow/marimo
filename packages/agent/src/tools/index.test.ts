/**
 * The catalogue the model is offered.
 *
 * Adding a tool is easy; making sure the model can see it, or that a gate is
 * still in place, is what this test is for.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {AgentConfig} from '../config.js';
import {MemoryStore} from '../memory/index.js';
import {toOpenAiTools} from '../models/openai-mapping.js';
import {createTools, describeTools, SAFE_DEFAULT_TOOLS} from './index.js';
import type {WebSearchProvider} from './web-search-tool.js';

describe('createTools', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-tools-'));
  });

  afterEach(async () => {
    await rm(workDir, {recursive: true, force: true});
  });

  function config(): AgentConfig {
    return {
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      temperature: 0,
      systemPrompt: 'test',
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  function memory(): MemoryStore {
    return new MemoryStore({workspaceRoot: workDir});
  }

  function names(tools: ReturnType<typeof createTools>): string[] {
    return tools.map((tool) => tool.name);
  }

  it('offers the same catalogue in a stable order', () => {
    expect(
      names(createTools(config(), {memory: memory(), model: 'deepseek-chat'})),
    ).toEqual([
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'read_memory',
      'update_memory',
      'prune_memory',
      'http_fetch',
      'run_shell',
    ]);
  });

  it('adds web_search only when the host injected a provider', async () => {
    const provider: WebSearchProvider = {search: async () => []};
    const withProvider = names(
      createTools(config(), {
        memory: memory(),
        model: 'deepseek-chat',
        webSearch: provider,
      }),
    );
    expect(withProvider).toContain('web_search');
    expect(withProvider.indexOf('web_search')).toBe(9);
    expect(withProvider.indexOf('run_shell')).toBe(10);
    expect(
      names(createTools(config(), {memory: memory(), model: 'deepseek-chat'})),
    ).not.toContain('web_search');
  });

  /**
   * Scheduling is part of the app, not of the agent: with no job service to write
   * to, the four tools would be promises the model could not keep. The tools
   * themselves have their own test; this is the placement.
   */
  it('adds the scheduling tools only when a job service is injected', () => {
    const jobs = {
      list: async () => [],
      create: async () => {
        throw new Error('not used');
      },
      update: async () => null,
      remove: async () => false,
    };
    const withJobs = names(
      createTools(config(), {
        memory: memory(),
        model: 'deepseek-chat',
        jobService: jobs,
      }),
    );
    expect(withJobs.slice(10)).toEqual([
      'list_jobs',
      'create_job',
      'update_job',
      'delete_job',
    ]);
  });

  /**
   * The desk is the app's own two documents, so the tools follow the same rule
   * the scheduling ones do: no service, no tools. The placement matters because
   * the catalogue is what a profile's checkboxes are seeded from.
   */
  it('adds the desk tools only when a desk service is injected', () => {
    const desk = {
      todos: async () => ({items: [], activeId: null, open: true}),
      addTodo: async () => ({items: [], activeId: null, open: true}),
      updateTodo: async () => ({
        document: {items: [], activeId: null, open: true},
        found: false,
      }),
      removeTodo: async () => ({
        document: {items: [], activeId: null, open: true},
        found: false,
      }),
      notes: async () => ({items: [], open: false}),
      addNote: async () => ({items: [], open: false}),
      updateNote: async () => ({
        document: {items: [], open: false},
        found: false,
      }),
      removeNote: async () => ({
        document: {items: [], open: false},
        found: false,
      }),
    };
    expect(
      names(createTools(config(), {memory: memory(), model: 'deepseek-chat'})),
    ).not.toContain('list_todos');

    const withDesk = names(
      createTools(config(), {
        memory: memory(),
        model: 'deepseek-chat',
        deskService: desk,
      }),
    );
    expect(withDesk.slice(10, 18)).toEqual([
      'list_todos',
      'add_todo',
      'update_todo',
      'remove_todo',
      'list_notes',
      'add_note',
      'update_note',
      'remove_note',
    ]);
    // And the scheduling tools still come after them.
    expect(withDesk.indexOf('run_shell')).toBeLessThan(
      withDesk.indexOf('list_todos'),
    );
  });

  /**
   * `save_skill` is the mechanism behind `/learn`, not a capability a profile
   * grants, so it is appended *after* the profile's selection. The point of this
   * test is that a profile which has narrowed its tools — including one that
   * allows none at all — can still run the command the user typed.
   */
  it('offers save_skill whatever the profile selected', () => {
    const skills = {
      save: async () => ({name: 'a-skill', updated: false}),
    };
    const narrowed = {
      ...config(),
      enabledTools: ['read_file'],
    };

    expect(
      names(
        createTools(narrowed, {
          memory: memory(),
          model: 'deepseek-chat',
          skillService: skills,
        }),
      ),
    ).toEqual(['read_file', 'save_skill']);

    // Even a profile that deliberately allows nothing gets it.
    expect(
      names(
        createTools(
          {...config(), enabledTools: []},
          {memory: memory(), model: 'deepseek-chat', skillService: skills},
        ),
      ),
    ).toEqual(['save_skill']);

    // And with no skill service there is nothing to write with, so no tool.
    expect(
      names(createTools(config(), {memory: memory(), model: 'deepseek-chat'})),
    ).not.toContain('save_skill');
  });

  it('never attaches the Gemini built-in to a DeepSeek model', () => {
    const tools = createTools(config(), {
      memory: memory(),
      model: 'deepseek-chat',
    });
    expect(names(tools)).not.toContain('google_search');
  });

  it('keeps run_shell behind an approval gate', () => {
    const tools = createTools(config(), {
      memory: memory(),
      model: 'deepseek-chat',
    });
    const shell = tools.find((tool) => tool.name === 'run_shell');
    expect(shell).toBeDefined();
    // A gated tool answers "yes" to the framework's own question.
    return expect(
      shell?.checkRequireConfirmation({command: 'echo hi'}),
    ).resolves.toBe(true);
  });

  describe("a profile's tool selection", () => {
    it('grants only the tools the profile allows', () => {
      const profileConfig = {
        ...config(),
        enabledTools: ['read_file', 'write_file'],
      };
      expect(
        names(
          createTools(profileConfig, {
            memory: memory(),
            model: 'deepseek-chat',
          }),
        ),
      ).toEqual(['read_file', 'write_file']);
    });

    it('treats an empty selection as "no tools", not as "unrestricted"', () => {
      const profileConfig = {...config(), enabledTools: []};
      expect(
        names(
          createTools(profileConfig, {
            memory: memory(),
            model: 'deepseek-chat',
          }),
        ),
      ).toEqual([]);
    });

    it('ignores a name that is not in the catalogue', () => {
      const profileConfig = {
        ...config(),
        enabledTools: ['read_file', 'made_up_tool'],
      };
      expect(
        names(
          createTools(profileConfig, {
            memory: memory(),
            model: 'deepseek-chat',
          }),
        ),
      ).toEqual(['read_file']);
    });
  });

  /**
   * The provider validates every declaration on every request, so one bad
   * keyword fails every turn, not just calls to the offending tool. This is
   * what caught `z.string().min(1)` arriving as `minLength: "1"`.
   */
  it('emits only numbers for numeric schema keywords', () => {
    const tools = createTools(config(), {
      memory: memory(),
      model: 'deepseek-chat',
      webSearch: {search: async () => []},
    });
    const offenders: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (NUMERIC_SCHEMA_KEYS.has(key) && typeof value !== 'number') {
          offenders.push(`${path}.${key} = ${JSON.stringify(value)}`);
        }
        walk(value, `${path}.${key}`);
      }
    };

    for (const tool of tools) {
      const declaration = tool._getDeclaration();
      expect(declaration).toBeDefined();
      // Through the same mapper the provider uses, so this is the wire shape.
      const [wire] = toOpenAiTools(declaration ? [declaration] : []);
      expect(wire?.function.parameters['type']).toBe('object');
      walk(wire?.function.parameters, tool.name);
    }

    expect(offenders).toEqual([]);
  });
});

const NUMERIC_SCHEMA_KEYS = new Set([
  'maximum',
  'minimum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'multipleOf',
]);

/*
 * The list a brand-new profile is granted.
 *
 * Tested against the tools that actually exist, because the failure mode is
 * silent in both directions: a name that no longer matches anything grants
 * nothing and looks like a capability that was never offered, and a name added
 * here by accident is a capability nobody chose.
 */
describe('the safe defaults', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-defaults-'));
  });

  afterEach(async () => {
    await rm(workDir, {recursive: true, force: true});
  });

  /** Every tool the host can build, with nothing optional left out. */
  function everything(): string[] {
    return createTools(
      {
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:1',
        model: 'deepseek-chat',
        temperature: 0,
        systemPrompt: 'test',
        workspaceRoot: workDir,
        allowPrivateNetworkFetch: false,
      },
      {
        memory: new MemoryStore({workspaceRoot: workDir}),
        model: 'deepseek-chat',
        // Present so the web-search name resolves; the defaults name it.
        webSearch: {search: async () => []},
        subagent: {build: () => ({}) as never},
      },
    ).map((tool) => tool.name);
  }

  it('names only tools that exist', () => {
    const built = new Set(everything());
    const missing = SAFE_DEFAULT_TOOLS.filter((name) => !built.has(name));
    expect(missing).toEqual([]);
  });

  /*
   * The line is not "harmless" but *reach*. Everything in the list can look;
   * nothing in it can change the machine or act in the world. A tool that can do
   * either must not be granted to somebody who has not chosen it.
   */
  it('grants nothing that can act', () => {
    for (const reachable of [
      'write_file',
      'run_shell',
      'http_fetch',
      'spawn_agent',
    ]) {
      expect(SAFE_DEFAULT_TOOLS as readonly string[]).not.toContain(reachable);
    }
  });

  it('grants the things a person would expect an assistant to manage', () => {
    expect(SAFE_DEFAULT_TOOLS).toContain('read_file');
    expect(SAFE_DEFAULT_TOOLS).toContain('web_search');
    expect(SAFE_DEFAULT_TOOLS).toContain('update_memory');
  });
});

/*
 * The settings screen's pick-list.
 *
 * Two failures are possible here and both are silent. A tool without a
 * plain-language description is a checkbox with nothing beside it — a decision
 * nobody can make. A tool the host *builds* but the catalogue does not list can
 * never be granted at all: the switch for it does not exist, and the capability
 * is unreachable while looking like it was never built.
 *
 * The second one was real. The scheduling and skill tools were missing from the
 * catalogue, so an agent with a job service could not be given the tools to use
 * it.
 */
describe('the tool catalogue', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-catalog-'));
  });

  afterEach(async () => {
    await rm(workDir, {recursive: true, force: true});
  });

  function config(): AgentConfig {
    return {
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      temperature: 0,
      systemPrompt: 'test',
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  /** Stand-ins. Nothing in a catalogue is executed. */
  function services(): Record<string, unknown> {
    return {
      jobService: {} as never,
      skillService: {} as never,
      discordService: {} as never,
      deskService: {} as never,
    };
  }

  /** Every tool the host can build, when everything is wired. */
  function everything(): string[] {
    return createTools(config(), {
      memory: new MemoryStore({workspaceRoot: workDir}),
      model: 'deepseek-chat',
      webSearch: {search: async () => []},
      subagent: {build: () => ({}) as never},
      ...services(),
    }).map((tool) => tool.name);
  }

  /*
   * The comparison that would have caught it. Building both sides with the same
   * services is what makes this a real check rather than two lists that happen
   * to agree.
   */
  it('lists every tool the host can build', () => {
    const listed = new Set(
      describeTools({
        workspaceRoot: workDir,
        model: 'deepseek-chat',
        webSearch: {search: async () => []},
        subagent: true,
        jobs: true,
        skills: true,
        discord: true,
        desk: true,
      }).map((entry) => entry.name),
    );

    const unreachable = everything().filter((name) => !listed.has(name));
    expect(unreachable).toEqual([]);
  });

  /*
   * Thrown rather than defaulted, so a tool added without a blurb fails here
   * instead of appearing as a blank line on a settings screen. The message names
   * the tool, because whoever hits it needs to know which one.
   */
  it('describes every tool it lists, in words for a person', () => {
    const entries = describeTools({
      workspaceRoot: workDir,
      model: 'deepseek-chat',
      webSearch: {search: async () => []},
      subagent: true,
      jobs: true,
      skills: true,
      discord: true,
      desk: true,
    });

    expect(entries).toHaveLength(everything().length);
    for (const entry of entries) {
      /*
       * Not a length threshold: "Write a note." is a perfectly good sentence and
       * a floor high enough to look meaningful would fail it while passing a
       * long piece of jargon. What is checked is that there *is* one, that it is
       * written as a sentence, and — the guard that matters — that it is not
       * simply the model's copy pasted across.
       */
      expect(entry.blurb.trim()).toBe(entry.blurb);
      expect(entry.blurb.endsWith('.')).toBe(true);
      expect(entry.blurb.charAt(0)).toBe(entry.blurb.charAt(0).toUpperCase());
      expect(entry.blurb).not.toBe(entry.description);
    }
  });

  it('marks exactly the safe defaults as granted out of the box', () => {
    const entries = describeTools({
      workspaceRoot: workDir,
      model: 'deepseek-chat',
      webSearch: {search: async () => []},
      subagent: true,
      jobs: true,
    });

    const byDefault = entries
      .filter((entry) => entry.byDefault)
      .map((entry) => entry.name);
    expect(new Set(byDefault)).toEqual(new Set(SAFE_DEFAULT_TOOLS));
  });
});
