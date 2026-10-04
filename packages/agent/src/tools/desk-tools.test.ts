/**
 * The desk tools, against a stand-in document.
 *
 * The rules worth pinning are the ones the model is held to: a question about
 * to-dos is answered from the list rather than guessed at, an id that names
 * nothing comes back as a sentence rather than as silence, and no tool replaces
 * the document wholesale — every edit is one the app applies to what is stored.
 */
import type {BaseTool, Context} from '@google/adk';
import type {Notes, TodoItem, Todos} from '@marimo/protocol';
import {describe, expect, it} from 'vitest';

import {
  createAddNoteTool,
  createAddTodoTool,
  createListNotesTool,
  createListTodosTool,
  createRemoveNoteTool,
  createRemoveTodoTool,
  createUpdateNoteTool,
  createUpdateTodoTool,
  deskTools,
} from './desk-tools.js';
import type {DeskEdit, DeskService} from './desk-tools.js';

/** A stand-in desk that behaves like the app's: ids matter, blanks are ignored. */
function harness(seed: {todos?: Todos; notes?: Notes} = {}): {
  service: DeskService;
  /**
   * The live documents. Held as one object rather than spread into the result,
   * because a destructured `todos` would be the value at construction time and
   * every assertion after a write would be reading a snapshot.
   */
  state: {todos: Todos; notes: Notes};
} {
  const state = {
    todos: seed.todos ?? {items: [], activeId: null, open: true},
    notes: seed.notes ?? {items: [], open: false},
  };
  const missing = <T>(document: T): DeskEdit<T> => ({
    document,
    found: false,
  });

  const service: DeskService = {
    todos: async () => state.todos,
    addTodo: async (text) => {
      state.todos = {
        ...state.todos,
        items: [
          ...state.todos.items,
          {
            id: `t${state.todos.items.length + 1}`,
            text,
            done: false,
            createdAt: 'now',
          },
        ],
      };
      return state.todos;
    },
    updateTodo: async (id, patch) => {
      if (!state.todos.items.some((item) => item.id === id)) {
        return missing(state.todos);
      }
      state.todos = {
        ...state.todos,
        items: state.todos.items.map((item) =>
          item.id === id
            ? {
                ...item,
                ...(patch.text !== undefined ? {text: patch.text} : {}),
                ...(patch.done !== undefined ? {done: patch.done} : {}),
              }
            : item,
        ),
      };
      return {document: state.todos, found: true};
    },
    removeTodo: async (id) => {
      if (!state.todos.items.some((item) => item.id === id)) {
        return missing(state.todos);
      }
      state.todos = {
        ...state.todos,
        items: state.todos.items.filter((item) => item.id !== id),
        activeId: state.todos.activeId === id ? null : state.todos.activeId,
      };
      return {document: state.todos, found: true};
    },
    notes: async () => state.notes,
    addNote: async (text) => {
      state.notes = {
        ...state.notes,
        items: [
          ...state.notes.items,
          {id: `n${state.notes.items.length + 1}`, text, createdAt: 'now'},
        ],
      };
      return state.notes;
    },
    updateNote: async (id, text) => {
      if (!state.notes.items.some((note) => note.id === id)) {
        return missing(state.notes);
      }
      state.notes = {
        ...state.notes,
        items: state.notes.items.map((note) =>
          note.id === id ? {...note, text} : note,
        ),
      };
      return {document: state.notes, found: true};
    },
    removeNote: async (id) => {
      if (!state.notes.items.some((note) => note.id === id)) {
        return missing(state.notes);
      }
      state.notes = {
        ...state.notes,
        items: state.notes.items.filter((note) => note.id !== id),
      };
      return {document: state.notes, found: true};
    },
  };
  return {service, state};
}

/** Runs a tool through ADK's own validation, as the runner does. */
async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: {sessionId: 'session-1'} as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function todo(id: string, text: string, done = false): TodoItem {
  return {id, text, done, createdAt: '2026-01-01T00:00:00.000Z'};
}

describe('desk tools', () => {
  describe('list_todos', () => {
    it('answers with the list, its ids and how much is left', async () => {
      const {service} = harness({
        todos: {
          items: [todo('a', 'Call the dentist'), todo('b', 'Pay rent', true)],
          activeId: 'a',
          open: true,
        },
      });
      const result = await run(createListTodosTool({desk: service}), {});

      expect(result).toContain('1 of 2 still to do');
      expect(result).toContain('[ ] Call the dentist — id a (pinned)');
      expect(result).toContain('[x] Pay rent — id b');
    });

    it('says the list is empty rather than answering with nothing', async () => {
      const result = await run(
        createListTodosTool({desk: harness().service}),
        {},
      );
      expect(result).toBe('The to-do list is empty.');
    });
  });

  describe('add_todo', () => {
    it('adds one item and says how long the list now is', async () => {
      const {service, state} = harness();
      const result = await run(createAddTodoTool({desk: service}), {
        text: 'Buy milk',
      });

      expect(state.todos.items.map((item) => item.text)).toEqual(['Buy milk']);
      expect(result).toContain('Added');
      expect(result).toContain('1 item');
    });

    it('refuses a blank item instead of writing one', async () => {
      const {service, state} = harness();
      const result = await run(createAddTodoTool({desk: service}), {
        text: '   ',
      });

      expect(state.todos.items).toEqual([]);
      expect(result).toContain('empty');
    });
  });

  describe('update_todo', () => {
    it('ticks an item off by id', async () => {
      const {service, state} = harness({
        todos: {items: [todo('a', 'Pay rent')], activeId: null, open: true},
      });
      const result = await run(createUpdateTodoTool({desk: service}), {
        id: 'a',
        done: true,
      });

      expect(state.todos.items[0]?.done).toBe(true);
      expect(result).toBe('Ticked off.');
    });

    it('tells the model when the id names nothing', async () => {
      const {service} = harness();
      const result = await run(createUpdateTodoTool({desk: service}), {
        id: 'nope',
        done: true,
      });

      expect(result).toContain('No to-do item has the id nope');
      expect(result).toContain('list_todos');
    });

    it('refuses a call that changes nothing', async () => {
      const {service} = harness();
      const result = await run(createUpdateTodoTool({desk: service}), {
        id: 'a',
      });
      expect(result).toContain('Nothing to change');
    });
  });

  describe('remove_todo', () => {
    it('removes an item and unpins it', async () => {
      const {service, state} = harness({
        todos: {
          items: [todo('a', 'Pay rent'), todo('b', 'Buy milk')],
          activeId: 'a',
          open: true,
        },
      });
      const result = await run(createRemoveTodoTool({desk: service}), {
        id: 'a',
      });

      expect(state.todos.items.map((item) => item.id)).toEqual(['b']);
      expect(state.todos.activeId).toBeNull();
      expect(result).toBe('Removed.');
    });

    it('says so when there was nothing to remove', async () => {
      const {service} = harness();
      expect(
        await run(createRemoveTodoTool({desk: service}), {id: 'gone'}),
      ).toContain('No to-do item has the id gone');
    });
  });

  describe('the notes', () => {
    it('reads the notes with their ids', async () => {
      const {service} = harness({
        notes: {
          items: [{id: 'n1', text: 'wifi password: hunter2', createdAt: 'now'}],
          open: false,
        },
      });
      const result = await run(createListNotesTool({desk: service}), {});

      expect(result).toContain('id n1');
      expect(result).toContain('wifi password: hunter2');
    });

    it('says there are none rather than answering with nothing', async () => {
      expect(
        await run(createListNotesTool({desk: harness().service}), {}),
      ).toBe('There are no notes yet.');
    });

    it('writes a new note and names its id', async () => {
      const {service, state} = harness();
      const result = await run(createAddNoteTool({desk: service}), {
        text: 'Renew the domain',
      });

      expect(state.notes.items.map((note) => note.text)).toEqual([
        'Renew the domain',
      ]);
      expect(result).toContain('id n1');
    });

    it('replaces one note by id', async () => {
      const {service, state} = harness({
        notes: {items: [{id: 'n1', text: 'old', createdAt: 'now'}], open: true},
      });
      const result = await run(createUpdateNoteTool({desk: service}), {
        id: 'n1',
        text: 'new',
      });

      expect(state.notes.items[0]?.text).toBe('new');
      expect(result).toBe('Note updated.');
    });

    it('will not blank a note, and will not invent one', async () => {
      const {service, state} = harness({
        notes: {
          items: [{id: 'n1', text: 'keep me', createdAt: 'now'}],
          open: true,
        },
      });

      expect(
        await run(createUpdateNoteTool({desk: service}), {id: 'n1', text: ' '}),
      ).toContain('empty');
      expect(state.notes.items[0]?.text).toBe('keep me');

      expect(
        await run(createUpdateNoteTool({desk: service}), {id: 'x', text: 'y'}),
      ).toContain('No note has the id x');
      expect(state.notes.items).toHaveLength(1);
    });

    it('removes a note by id', async () => {
      const {service, state} = harness({
        notes: {items: [{id: 'n1', text: 'x', createdAt: 'now'}], open: true},
      });
      const result = await run(createRemoveNoteTool({desk: service}), {
        id: 'n1',
      });

      expect(state.notes.items).toEqual([]);
      expect(result).toBe('Note removed.');
    });
  });

  it('offers the eight tools in a stable order, and gates none of them', () => {
    const tools = deskTools({desk: harness().service});
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_todos',
      'add_todo',
      'update_todo',
      'remove_todo',
      'list_notes',
      'add_note',
      'update_note',
      'remove_note',
    ]);
  });

  /**
   * These edits are additive, reversible and visible in a rail the user already
   * has open — the opposite of `run_shell`. A gate here would be an approval card
   * for "add milk", and the point of this test is that adding one has to be a
   * deliberate act rather than something that arrives with a new tool.
   */
  it('leaves every write ungated', async () => {
    const {service} = harness();
    for (const tool of deskTools({desk: service})) {
      await expect(
        tool.checkRequireConfirmation({text: 'x', id: 'a', done: true}),
      ).resolves.toBe(false);
    }
  });
});
