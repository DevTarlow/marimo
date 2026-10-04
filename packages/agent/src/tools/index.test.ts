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
import {createTools} from './index.js';
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
