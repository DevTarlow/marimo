/**
 * The desk tools: the to-do list and the notes, as the agent sees them.
 *
 * These exist because the rails are where the user keeps things they mean to act
 * on, and a question like "what to-dos do I have?" is answerable only from that
 * document — the file tools read the *workspace*, which is the user's code, not
 * the app's own state. Jobs already had `list_jobs` and files already had
 * `list_dir`; this is the same thing for the two rails that had no agent-facing
 * door.
 *
 * Two rules are deliberate:
 *
 * - **The app owns the document, the tool names an intention.** Nothing here
 *   writes a `Todos` value the model assembled; it asks for "add this text" or
 *   "tick this id" and the app applies the same edit the panel's own buttons
 *   would. A model that could replace the list wholesale could lose a to-do by
 *   paraphrasing it.
 * - **Nothing is gated.** These edits are additive, reversible, and visible in a
 *   rail the user already has open, which is the opposite of `run_shell` — the
 *   gate exists so a human chooses what runs on the machine, and adding "milk" to
 *   a shopping list is not that.
 *
 * The port is implemented by the desktop main process over its two stores and by
 * a test over an array, so this file knows nothing about Electron or disk.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import type {Notes, Todos} from '@marimo/protocol';

/** What an edit answered with: the document as it now stands, and whether it hit. */
export interface DeskEdit<T> {
  document: T;
  /** False when the id named nothing — the model is told, not silently ignored. */
  found: boolean;
}

/**
 * Everything the tools need from the app that owns the two documents.
 *
 * Deliberately intention-shaped rather than `save(todos)`: the rules — trim the
 * text, refuse a blank item, keep the pin pointing at something — live in one
 * place on the app's side, and the model gets the same behaviour as a click.
 */
export interface DeskService {
  todos(): Promise<Todos>;
  addTodo(text: string): Promise<Todos>;
  updateTodo(
    id: string,
    patch: {text?: string; done?: boolean},
  ): Promise<DeskEdit<Todos>>;
  removeTodo(id: string): Promise<DeskEdit<Todos>>;
  notes(): Promise<Notes>;
  addNote(text: string): Promise<Notes>;
  updateNote(id: string, text: string): Promise<DeskEdit<Notes>>;
  removeNote(id: string): Promise<DeskEdit<Notes>>;
}

export interface DeskToolContext {
  desk: DeskService;
}

/**
 * How much of one note is shown.
 *
 * A note is a scrap rather than a document, but nothing stops a user pasting one
 * in, and a `list_notes` that returned everything would spend the context window
 * on text the model was not asked about.
 */
const NOTE_LIMIT = 1_000;
/** The whole answer is capped too, for the same reason across many notes. */
const LIST_LIMIT = 8_000;

export function deskTools(context: DeskToolContext) {
  return [
    createListTodosTool(context),
    createAddTodoTool(context),
    createUpdateTodoTool(context),
    createRemoveTodoTool(context),
    createListNotesTool(context),
    createAddNoteTool(context),
    createUpdateNoteTool(context),
    createRemoveNoteTool(context),
  ];
}

export function createListTodosTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'list_todos',
    description:
      "Read the user's to-do list from the app's To-dos rail, with the id of " +
      'each item. Use this whenever the user asks what they have to do, or ' +
      'before changing an item so you are working from what is actually on the ' +
      'list rather than from what was said earlier.',
    parameters: z.object({}),
    execute: async () => {
      const todos = await context.desk.todos();
      if (todos.items.length === 0) {
        return 'The to-do list is empty.';
      }
      const pinned = todos.activeId;
      const lines = todos.items.map((item) => {
        const mark = item.done ? '[x]' : '[ ]';
        const active = item.id === pinned ? ' (pinned)' : '';
        return `- ${mark} ${item.text} — id ${item.id}${active}`;
      });
      const open = todos.items.filter((item) => !item.done).length;
      return clip(
        `${open} of ${todos.items.length} still to do:\n${lines.join('\n')}`,
      );
    },
  });
}

export function createAddTodoTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'add_todo',
    description:
      "Add one item to the end of the user's to-do list. `text` is the item " +
      'itself, written as the user would write it — "Call the dentist", not ' +
      '"add a to-do about the dentist". Adding one item per call keeps the list ' +
      'readable; the app does the writing.',
    parameters: z.object({
      text: z.string().describe('The to-do, as it should appear in the list.'),
    }),
    execute: async ({text}) => {
      if (text.trim().length === 0) {
        return 'Nothing to add: the item text was empty.';
      }
      const todos = await context.desk.addTodo(text);
      return `Added. The list now holds ${todos.items.length} item${
        todos.items.length === 1 ? '' : 's'
      }.`;
    },
  });
}

export function createUpdateTodoTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'update_todo',
    description:
      'Rename a to-do item or tick it off. Pass the `id` from `list_todos`, and ' +
      'only the fields that change: `text` renames it, `done` ticks or unticks ' +
      'it. The app refuses an empty name and leaves the item alone.',
    parameters: z.object({
      id: z.string().describe('The id of the item, from `list_todos`.'),
      text: z.string().optional().describe('A new wording for the item.'),
      done: z.boolean().optional().describe('Whether the item is done.'),
    }),
    execute: async ({id, text, done}) => {
      if (text === undefined && done === undefined) {
        return 'Nothing to change: pass `text`, `done`, or both.';
      }
      const result = await context.desk.updateTodo(id, {
        ...(text !== undefined ? {text} : {}),
        ...(done !== undefined ? {done} : {}),
      });
      if (!result.found) {
        return `No to-do item has the id ${id}. Call list_todos to see the ids.`;
      }
      return done === true ? 'Ticked off.' : 'Updated.';
    },
  });
}

export function createRemoveTodoTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'remove_todo',
    description:
      'Remove one item from the to-do list, by the `id` from `list_todos`. Use ' +
      'this for something that should not be on the list at all; for something ' +
      'the user has finished, prefer `update_todo` with `done: true`.',
    parameters: z.object({
      id: z.string().describe('The id of the item, from `list_todos`.'),
    }),
    execute: async ({id}) => {
      const result = await context.desk.removeTodo(id);
      return result.found
        ? 'Removed.'
        : `No to-do item has the id ${id}. Call list_todos to see the ids.`;
    },
  });
}

export function createListNotesTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'list_notes',
    description:
      "Read the user's notes from the app's Notes rail, with the id of each " +
      'one. Use this when the user asks what they have noted, or refers to ' +
      'something "in my notes" — the notes are the app\'s own document, not a ' +
      'file in the workspace.',
    parameters: z.object({}),
    execute: async () => {
      const notes = await context.desk.notes();
      if (notes.items.length === 0) {
        return 'There are no notes yet.';
      }
      return clip(
        notes.items
          .map(
            (note, index) =>
              `${index + 1}. id ${note.id} · ${note.createdAt}\n${indent(
                clip(note.text, NOTE_LIMIT),
              )}`,
          )
          .join('\n'),
      );
    },
  });
}

export function createAddNoteTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'add_note',
    description:
      'Write a new note into the Notes rail. A note is one scrap of text, so ' +
      '`text` is the whole note — the user can edit it in the rail afterwards. ' +
      'Write a new note per subject rather than appending everything to one.',
    parameters: z.object({
      text: z.string().describe('The whole note, as it should appear.'),
    }),
    execute: async ({text}) => {
      if (text.trim().length === 0) {
        return 'Nothing to write: the note text was empty.';
      }
      const notes = await context.desk.addNote(text);
      const last = notes.items[notes.items.length - 1];
      return `Noted. There are now ${notes.items.length} note${
        notes.items.length === 1 ? '' : 's'
      }${last ? ` (id ${last.id})` : ''}.`;
    },
  });
}

export function createUpdateNoteTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'update_note',
    description:
      'Replace the text of an existing note, by the `id` from `list_notes`. ' +
      'This overwrites the note rather than adding to it, so read it first with ' +
      '`list_notes` if you mean to keep what is there.',
    parameters: z.object({
      id: z.string().describe('The id of the note, from `list_notes`.'),
      text: z
        .string()
        .describe("The note's new text, replacing what is there."),
    }),
    execute: async ({id, text}) => {
      if (text.trim().length === 0) {
        return 'Nothing to write: the note text was empty.';
      }
      const result = await context.desk.updateNote(id, text);
      return result.found
        ? 'Note updated.'
        : `No note has the id ${id}. Call list_notes to see the ids.`;
    },
  });
}

export function createRemoveNoteTool(context: DeskToolContext) {
  return new FunctionTool({
    name: 'remove_note',
    description:
      'Remove one note by the `id` from `list_notes`. The user cannot undo this ' +
      'from the rail, so only do it when they asked for that note to go.',
    parameters: z.object({
      id: z.string().describe('The id of the note, from `list_notes`.'),
    }),
    execute: async ({id}) => {
      const result = await context.desk.removeNote(id);
      return result.found
        ? 'Note removed.'
        : `No note has the id ${id}. Call list_notes to see the ids.`;
    },
  });
}

/** Indents a note's body under its header, so the list reads as a list. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
}

/**
 * Clips a tool answer, visibly.
 *
 * The same rule the approval preview follows: a truncated answer says so, so the
 * model knows there is more rather than believing it has read everything.
 */
function clip(text: string, limit = LIST_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [truncated — read fewer, or ask about one item]`;
}
