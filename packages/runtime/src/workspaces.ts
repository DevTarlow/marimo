/**
 * The folders every agent can work in.
 *
 * One document for the whole install rather than a list on each profile. A
 * folder is a place on the machine, and two agents asked about the same project
 * work in the same one; a per-profile list also made the rail depend on which
 * agent happened to be active, which is not a question a sidebar should be
 * asking.
 *
 * It is its own file rather than a corner of `settings.json`: it is user data
 * with a write path of its own, guarded by the same version machinery as every
 * other document (older upgraded, newer refused, corrupt moved aside).
 *
 * The conversations that name these folders live in the session index, which is
 * why removing one is a *forget* rather than a cascade: the id is left dangling
 * and the rail renders that as "Other chats", so nothing a user wrote is lost to
 * a tidy-up. The directory itself is never touched — never read, written or
 * deleted.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';

import {
  assertWritable,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from '@marimo/agent';

import {workspacesFileSchema} from '@marimo/protocol';
import type {Workspace, WorkspacesFile} from '@marimo/protocol';

/**
 * What a pre-workspaces `profiles.json` held, flattened.
 *
 * The shape the migration reads, not one this build ever writes: the folders
 * used to be a field on each profile, and the sessions already on disk refer to
 * their ids.
 */
export interface LegacyWorkspaces {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface WorkspaceStoreOptions {
  file: string;
  /** Where a fresh install's single folder points. */
  defaultWorkspaceRoot: string;
  /**
   * The folders a `profiles.json` written before this store existed holds.
   *
   * Called only when there is no workspaces document at all, which is the one
   * moment the old list is the only copy. A callback rather than a store
   * reference so this module stays unaware of profiles.
   */
  adoptLegacy?: () => Promise<LegacyWorkspaces | undefined>;
  /**
   * Told once an adopted document has been written.
   *
   * After, not before: the fields the folders came from can only be dropped
   * safely once the document holding them exists, and a crash between the two
   * steps has to leave the folders somewhere.
   */
  onAdopted?: () => Promise<void>;
}

export class WorkspaceStore {
  private cache: WorkspacesFile | undefined;
  /**
   * The read in flight, memoised as a promise rather than a value.
   *
   * Two callers arriving before the first read finishes would both find no file,
   * both seed, and the loser's folder list — with a different random id for the
   * same path — would be the one left on disk while the winner's window went on
   * using the other. That is the same race the profiles store documents, and it
   * has the same answer.
   */
  private loading: Promise<WorkspacesFile> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkspaceStoreOptions) {}

  async load(): Promise<WorkspacesFile> {
    if (this.cache) {
      return this.cache;
    }
    const inFlight = (this.loading ??= this.readOrCreate());
    try {
      return await inFlight;
    } finally {
      if (this.loading === inFlight) {
        this.loading = undefined;
      }
    }
  }

  async workspaces(): Promise<Workspace[]> {
    return (await this.load()).workspaces;
  }

  async activeWorkspaceId(): Promise<string | null> {
    return (await this.load()).activeWorkspaceId;
  }

  /** The folder a new conversation is filed under, if there is one. */
  async active(): Promise<Workspace | undefined> {
    const file = await this.load();
    return file.workspaces.find((entry) => entry.id === file.activeWorkspaceId);
  }

  async byId(workspaceId: string): Promise<Workspace | undefined> {
    const file = await this.load();
    return file.workspaces.find((entry) => entry.id === workspaceId);
  }

  /**
   * Adds a folder and makes it current. A path that is already listed is
   * selected rather than duplicated, so loading the same folder twice is
   * harmless — and it keeps the id the conversations filed under it refer to.
   */
  async add(path: string, name?: string): Promise<Workspace> {
    return await this.withLock(async () => {
      const file = await this.load();
      const absolute = resolve(path);
      const existing = file.workspaces.find((entry) => entry.path === absolute);
      const workspace: Workspace = existing ?? {
        id: randomUUID(),
        name: name?.trim() || workspaceLabel(absolute),
        path: absolute,
      };
      await this.writeFile({
        ...file,
        workspaces: existing
          ? file.workspaces
          : [...file.workspaces, workspace],
        activeWorkspaceId: workspace.id,
      });
      return workspace;
    });
  }

  async select(workspaceId: string): Promise<Workspace> {
    return await this.withLock(async () => {
      const file = await this.load();
      const workspace = requireWorkspace(file, workspaceId);
      await this.writeFile({...file, activeWorkspaceId: workspace.id});
      return workspace;
    });
  }

  async rename(workspaceId: string, name: string): Promise<Workspace> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // Writing a blank label would persist a file its own schema rejects, and
      // the next read would take the whole document down with it.
      throw new Error('A workspace name cannot be empty.');
    }
    return await this.withLock(async () => {
      const file = await this.load();
      const workspace = requireWorkspace(file, workspaceId);
      const renamed: Workspace = {...workspace, name: trimmed};
      await this.writeFile({
        ...file,
        workspaces: file.workspaces.map((entry) =>
          entry.id === workspaceId ? renamed : entry,
        ),
      });
      return renamed;
    });
  }

  /**
   * Forgets a folder, and nothing else.
   *
   * The conversations filed under it are deliberately left naming an id that is
   * no longer listed: the index is another document, rewriting it would be a
   * second thing that can go wrong in a tidy-up, and "Other chats" is already
   * how a dangling id renders. The directory is not touched at all.
   *
   * The current folder moves to the first one left, or to none — which is the
   * honest state of an install whose last folder was just forgotten.
   */
  async remove(workspaceId: string): Promise<WorkspacesFile> {
    return await this.withLock(async () => {
      const file = await this.load();
      requireWorkspace(file, workspaceId);
      const remaining = file.workspaces.filter(
        (entry) => entry.id !== workspaceId,
      );
      const next: WorkspacesFile = {
        version: 1,
        workspaces: remaining,
        activeWorkspaceId:
          file.activeWorkspaceId === workspaceId
            ? (remaining[0]?.id ?? null)
            : file.activeWorkspaceId,
      };
      await this.writeFile(next);
      return next;
    });
  }

  private async readOrCreate(): Promise<WorkspacesFile> {
    if (this.cache) {
      return this.cache;
    }

    const read = await readVersionedDocument(this.options.file, {
      label: 'The workspaces file',
    });
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The workspaces file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'unreadable') {
      /*
       * Moved aside before a fresh document replaces it. The conversations name
       * folders by id, and the ids are in this file, so a parse bug must not be
       * the end of the rail.
       */
      await quarantineDocument(this.options.file);
      return await this.seed();
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = workspacesFileSchema.safeParse(read.document);
      if (parsed.success) {
        this.cache = parsed.data;
        if (read.state === 'migrated') {
          // Written back now rather than at the next edit, so an upgrade does
          // not run again on every launch.
          await this.writeFile(parsed.data);
        }
        return parsed.data;
      }
      await quarantineDocument(this.options.file);
    }
    return await this.seed();
  }

  /**
   * The first document this install has.
   *
   * Two ways in, and the order matters: a profiles file that still carries
   * folders is the only copy of them, so it is adopted; only an install with no
   * such file gets the default folder.
   */
  private async seed(): Promise<WorkspacesFile> {
    const legacy = await this.options.adoptLegacy?.();
    const document =
      legacy === undefined
        ? freshWorkspaces(this.options.defaultWorkspaceRoot)
        : adoptLegacy(legacy, this.options.defaultWorkspaceRoot);
    await this.writeFile(document);
    if (legacy !== undefined) {
      await this.options.onAdopted?.();
    }
    return document;
  }

  private async writeFile(file: WorkspacesFile): Promise<void> {
    /*
     * Refused before anything is written. Every other store here follows the
     * same rule, and for the same reason: the read above is lenient, and a
     * lenient read plus a write is how a user's data disappears.
     */
    await assertWritable(this.options.file, {label: 'The workspaces file'});
    await mkdir(dirname(this.options.file), {recursive: true});
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temporary, this.options.file);
    this.cache = file;
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even when a caller's write fails.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * The folder one turn runs in.
 *
 * The conversation's own folder wins, because that is what the rail shows and
 * what the user chose when they filed it. The current folder is the fallback for
 * a conversation that has none (one from before folders existed) or whose folder
 * has been forgotten.
 *
 * Pure, and outside the store, because it is a decision about a document rather
 * than an operation on a file — and it is the rule the whole feature rests on.
 */
export function workspaceRootFor(
  file: WorkspacesFile,
  sessionWorkspaceId?: string | null,
): string | undefined {
  if (sessionWorkspaceId !== undefined && sessionWorkspaceId !== null) {
    const filed = file.workspaces.find(
      (entry) => entry.id === sessionWorkspaceId,
    );
    if (filed !== undefined) {
      return filed.path;
    }
  }
  return file.workspaces.find((entry) => entry.id === file.activeWorkspaceId)
    ?.path;
}

/**
 * An install with no folders yet gets the folder the user already recognises.
 *
 * The home directory rather than a subfolder of it: the agent's file tools are
 * confined to whatever is listed, and choosing a folder nobody has seen — then
 * silently confining the agent to it — is worse than starting where they are.
 */
function freshWorkspaces(root: string): WorkspacesFile {
  const path = resolve(root);
  const workspace: Workspace = {
    id: randomUUID(),
    name: workspaceLabel(path),
    path,
  };
  return {version: 1, workspaces: [workspace], activeWorkspaceId: workspace.id};
}

/**
 * The folders a pre-workspaces profiles file held, as this store's document.
 *
 * Unioned **by id**, not by path. Two profiles seeded on the same machine both
 * got their own id for the same home directory, and a conversation refers to its
 * folder by id — so merging those into one entry would quietly unfile every chat
 * that named the loser. Two groups for one path after an upgrade is the visible
 * cost of keeping them, and the rail's own "remove from list" is how a user
 * cleans that up; losing conversations to the "Other chats" bucket is not.
 *
 * A document whose lists were all empty is an install that had no folder: it
 * falls back to the default, which is where a fresh install starts.
 */
function adoptLegacy(
  legacy: LegacyWorkspaces,
  fallbackRoot: string,
): WorkspacesFile {
  const seen = new Set<string>();
  const workspaces: Workspace[] = [];
  for (const workspace of legacy.workspaces) {
    if (seen.has(workspace.id)) {
      continue;
    }
    seen.add(workspace.id);
    workspaces.push({...workspace});
  }
  if (workspaces.length === 0) {
    return freshWorkspaces(fallbackRoot);
  }
  const active = workspaces.some(
    (entry) => entry.id === legacy.activeWorkspaceId,
  )
    ? legacy.activeWorkspaceId
    : workspaces[0]!.id;
  return {version: 1, workspaces, activeWorkspaceId: active};
}

function requireWorkspace(
  file: WorkspacesFile,
  workspaceId: string,
): Workspace {
  const workspace = file.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}

/** `project` for a path, or the path itself when it has no last segment. */
export function workspaceLabel(path: string): string {
  const label = basename(resolve(path));
  return label.length > 0 ? label : resolve(path);
}
