/**
 * File-backed ADK session store.
 *
 * One JSONL file per conversation (one ADK event per line) plus a single
 * `index.json` carrying the sidebar metadata. Chosen over ADK's
 * `DatabaseSessionService` because it needs no MikroORM driver and no native
 * SQLite module in every build, and because a conversation stays inspectable
 * and back-up-able as plain text.
 *
 * Writes are serialized through one queue and the index is replaced by rename,
 * so an interrupted write cannot leave a half-written index behind.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {BaseSessionService} from '@google/adk';

import type {SessionSource} from '@marimo/protocol';

/**
 * Types are derived from the base class instead of imported by name so this
 * file keeps compiling if ADK renames its exported request types.
 */
type CreateRequest = Parameters<BaseSessionService['createSession']>[0];
type GetRequest = Parameters<BaseSessionService['getSession']>[0];
type ListRequest = Parameters<BaseSessionService['listSessions']>[0];
type ListResponse = Awaited<ReturnType<BaseSessionService['listSessions']>>;
type DeleteRequest = Parameters<BaseSessionService['deleteSession']>[0];
type AppendRequest = Parameters<BaseSessionService['appendEvent']>[0];
type SessionModel = Awaited<ReturnType<BaseSessionService['createSession']>>;
export type AdkEvent = AppendRequest['event'];

/**
 * `createEvent` brands every event with a global symbol; JSON round-tripping
 * drops it. Restoring the brand keeps events loaded from disk indistinguishable
 * from freshly created ones for any ADK code that type-guards with `isEvent`.
 */
const EVENT_BRAND = Symbol.for('google.adk.event');

export interface SessionIndexEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  appName: string;
  userId: string;
  /**
   * Model chosen for this conversation. Absent means the conversation follows
   * the app-wide default, so changing the default also moves every chat that
   * never picked a model of its own.
   */
  model?: string;
  /**
   * Agent profile that owns this conversation. Absent for sessions created
   * before profiles existed, which the app adopts into its first profile.
   */
  profileId?: string;
  /**
   * Workspace the conversation was started in, captured at creation so the
   * sidebar can nest it under that folder.
   *
   * Stored as a plain id rather than a path: renaming or re-adding a folder
   * keeps the same workspace id, and a folder that is later removed simply
   * leaves this pointing at nothing, which the sidebar renders as "Other
   * chats" instead of losing the conversation.
   */
  workspaceId?: string;
  /**
   * Set when the app started the conversation rather than the user — a Discord
   * mention, today. The sidebar renders these under their own section, so this
   * is what keeps an unattended conversation out of a folder it has nothing to
   * do with.
   */
  source?: SessionSource;
}

interface SessionIndexFile {
  version: 1;
  sessions: Record<string, SessionIndexEntry>;
}

export interface FileSessionServiceOptions {
  rootDir: string;
}

const INDEX_FILE = 'index.json';
const UNTITLED = 'New chat';
const MAX_TITLE_LENGTH = 60;

export class FileSessionService extends BaseSessionService {
  private readonly rootDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileSessionServiceOptions) {
    super();
    this.rootDir = options.rootDir;
  }

  /** Reads raw events for a conversation, oldest first. */
  async listEvents(sessionId: string): Promise<AdkEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventPath(sessionId), 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const events: AdkEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        events.push(reviveEvent(JSON.parse(trimmed)));
      } catch {
        // A truncated tail is expected after a hard kill; a corrupt middle
        // line is skipped rather than hiding the rest of the conversation.
      }
    }
    return events;
  }

  async getIndex(): Promise<SessionIndexEntry[]> {
    const index = await this.readIndex();
    return Object.values(index.sessions);
  }

  async getIndexEntry(
    sessionId: string,
  ): Promise<SessionIndexEntry | undefined> {
    const index = await this.readIndex();
    return index.sessions[sessionId];
  }

  /**
   * Records the model this conversation should use. It lives in the sidebar
   * index so a per-chat choice survives a restart.
   */
  async setSessionModel(
    sessionId: string,
    model: string,
  ): Promise<SessionIndexEntry | undefined> {
    return await this.withLock(async () => {
      const index = await this.readIndex();
      const entry = index.sessions[sessionId];
      if (!entry) {
        return undefined;
      }
      entry.model = model;
      entry.updatedAt = new Date().toISOString();
      await this.writeIndex(index);
      return entry;
    });
  }

  /**
   * Re-files a conversation under another folder, or under none at all.
   *
   * `updatedAt` is deliberately left alone: it is what the sidebar sorts on and
   * what "3h ago" reports, and both mean *when the conversation last had
   * something happen in it*. Moving a chat is filing, not activity, and
   * stamping it would both reorder the list and misreport the time.
   */
  async setSessionWorkspace(
    sessionId: string,
    workspaceId: string | undefined,
  ): Promise<SessionIndexEntry | undefined> {
    return await this.withLock(async () => {
      const index = await this.readIndex();
      const entry = index.sessions[sessionId];
      if (!entry) {
        return undefined;
      }
      if (workspaceId === undefined) {
        // Removed rather than set to a sentinel: an absent id is what a
        // conversation that predates folders has, so both render the same way.
        delete entry.workspaceId;
      } else {
        entry.workspaceId = workspaceId;
      }
      await this.writeIndex(index);
      return entry;
    });
  }

  /**
   * Gives a conversation a name of its own.
   *
   * `updatedAt` is left alone, for the reason `setSessionWorkspace` leaves it
   * alone: the sidebar sorts on it and reports it as when the conversation last
   * had something happen *in* it. Naming a chat is not a turn.
   *
   * The derived title is only ever applied while the title is still the
   * untitled placeholder, so renaming a chat before its first message is what
   * stops that message naming it — which is the point of renaming it early.
   */
  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<SessionIndexEntry | undefined> {
    return await this.withLock(async () => {
      const index = await this.readIndex();
      const entry = index.sessions[sessionId];
      if (!entry) {
        return undefined;
      }
      entry.title = title;
      await this.writeIndex(index);
      return entry;
    });
  }

  override async createSession(request: CreateRequest): Promise<SessionModel> {
    const id = request.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    await mkdir(this.rootDir, {recursive: true});
    await writeFile(this.eventPath(id), '', {flag: 'a'});

    await this.withLock(async () => {
      const index = await this.readIndex();
      const model = readString(request.state, 'model');
      const profileId = readString(request.state, 'profileId');
      const workspaceId = readString(request.state, 'workspaceId');
      const source = readSource(request.state);
      index.sessions[id] ??= {
        id,
        title: generateTitle(request.state),
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        appName: request.appName,
        userId: request.userId ?? '',
        ...(model ? {model} : {}),
        ...(profileId ? {profileId} : {}),
        ...(workspaceId ? {workspaceId} : {}),
        ...(source ? {source} : {}),
      };
      await this.writeIndex(index);
    });

    return {
      id,
      appName: request.appName,
      userId: request.userId ?? '',
      state: request.state ?? {},
      events: [],
      lastUpdateTime: Date.now(),
    };
  }

  override async getSession(
    request: GetRequest,
  ): Promise<SessionModel | undefined> {
    const entry = await this.getIndexEntry(request.sessionId);
    const events = await this.listEvents(request.sessionId);
    if (!entry) {
      return undefined;
    }

    const state: Record<string, unknown> = {};
    for (const event of events) {
      const delta = event.actions?.stateDelta;
      if (delta) {
        Object.assign(state, delta);
      }
    }

    return {
      id: request.sessionId,
      appName: request.appName,
      userId: request.userId,
      state,
      events,
      lastUpdateTime: Date.parse(entry.updatedAt) || 0,
    };
  }

  override async listSessions(request: ListRequest): Promise<ListResponse> {
    const index = await this.readIndex();
    let entries = Object.values(index.sessions);
    if (request.userId) {
      entries = entries.filter(
        (entry) => entry.userId === '' || entry.userId === request.userId,
      );
    }

    entries.sort((a, b) => {
      const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return request.order === 'asc' ? -delta : delta;
    });

    const totalItems = entries.length;
    const limit = request.limit ?? totalItems;
    const offset =
      request.page && request.limit
        ? (request.page - 1) * request.limit
        : (request.offset ?? 0);
    const pageItems =
      limit > 0 ? entries.slice(offset, offset + limit) : entries;

    return {
      sessions: pageItems.map((entry) => ({
        id: entry.id,
        appName: entry.appName,
        userId: entry.userId,
        state: {},
        events: [],
        lastUpdateTime: Date.parse(entry.updatedAt) || 0,
      })),
      page:
        request.page ?? (request.limit ? Math.floor(offset / limit) + 1 : 1),
      limit: request.limit ?? totalItems,
      totalItems,
      totalPages: request.limit
        ? Math.ceil(totalItems / request.limit)
        : totalItems > 0
          ? 1
          : 0,
    };
  }

  override async deleteSession(request: DeleteRequest): Promise<void> {
    await rm(this.eventPath(request.sessionId), {force: true});
    await this.withLock(async () => {
      const index = await this.readIndex();
      delete index.sessions[request.sessionId];
      await this.writeIndex(index);
    });
  }

  /**
   * Claims every conversation that has no profile yet, and reports how many.
   *
   * Sessions created before profiles existed belong to nobody; leaving them
   * unowned would hide a user's history from every profile after an upgrade.
   * Runs once at startup, and is a no-op afterwards.
   */
  async adoptUnownedSessions(profileId: string): Promise<number> {
    return await this.withLock(async () => {
      const index = await this.readIndex();
      const orphans = Object.values(index.sessions).filter(
        (entry) => entry.profileId === undefined,
      );
      if (orphans.length === 0) {
        return 0;
      }
      for (const entry of orphans) {
        entry.profileId = profileId;
      }
      await this.writeIndex(index);
      return orphans.length;
    });
  }

  /**
   * Deletes every conversation a profile owns, in one index rewrite.
   *
   * Called when a profile is removed. The agent's memory files live inside the
   * user's own folders and are deliberately left behind — deleting a profile is
   * not a licence to delete the user's files.
   */
  async deleteSessionsForProfile(profileId: string): Promise<string[]> {
    return await this.withLock(async () => {
      const index = await this.readIndex();
      const doomed = Object.values(index.sessions)
        .filter((entry) => entry.profileId === profileId)
        .map((entry) => entry.id);
      for (const sessionId of doomed) {
        await rm(this.eventPath(sessionId), {force: true});
        delete index.sessions[sessionId];
      }
      if (doomed.length > 0) {
        await this.writeIndex(index);
      }
      return doomed;
    });
  }

  override async appendEvent(request: AppendRequest): Promise<AdkEvent> {
    const stored = await super.appendEvent(request);
    if (request.event.partial) {
      return stored;
    }

    await this.withLock(async () => {
      await mkdir(this.rootDir, {recursive: true});
      await writeFile(
        this.eventPath(request.session.id),
        `${JSON.stringify(stored)}\n`,
        {flag: 'a'},
      );

      const index = await this.readIndex();
      const now = new Date().toISOString();
      const entry = index.sessions[request.session.id];
      // Only a session that was registered is tracked. Creating an entry here
      // would resurrect a conversation deleted mid-turn — the run in flight can
      // still emit one last event — and that entry would have no profile, so it
      // would resurface in whichever agent happened to be active next launch.
      if (entry) {
        entry.messageCount += 1;
        entry.updatedAt = now;
        if (entry.title === UNTITLED) {
          const derived = titleFromEvent(stored);
          if (derived) {
            entry.title = derived;
          }
        }
        await this.writeIndex(index);
      }
    });

    return stored;
  }

  private eventPath(sessionId: string): string {
    return join(this.rootDir, `${sanitizeId(sessionId)}.jsonl`);
  }

  private indexFilePath(): string {
    return join(this.rootDir, INDEX_FILE);
  }

  private async readIndex(): Promise<SessionIndexFile> {
    try {
      const raw = await readFile(this.indexFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as SessionIndexFile;
      if (!parsed || typeof parsed !== 'object' || !parsed.sessions) {
        return {version: 1, sessions: {}};
      }
      return parsed;
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) {
        return {version: 1, sessions: {}};
      }
      throw error;
    }
  }

  private async writeIndex(index: SessionIndexFile): Promise<void> {
    await mkdir(this.rootDir, {recursive: true});
    const target = this.indexFilePath();
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(index, null, 2), 'utf8');
    await rename(temporary, target);
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Keep the chain alive even when a caller's write fails.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function reviveEvent(raw: unknown): AdkEvent {
  const event = raw as Record<PropertyKey, unknown>;
  event[EVENT_BRAND] = true;
  return event as unknown as AdkEvent;
}

function titleFromEvent(event: AdkEvent): string | undefined {
  if (event.author !== 'user') {
    return undefined;
  }
  const parts = event.content?.parts ?? [];
  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : text;
}

function generateTitle(state: Record<string, unknown> | undefined): string {
  return readString(state, 'title') ?? UNTITLED;
}

/** Reads a non-empty string out of the create-request state, if present. */
function readString(
  state: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = state?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Reads the conversation's source, keeping only the values this app knows.
 *
 * Validated rather than passed through: the state record is assembled from
 * whatever the caller sent, and an unknown source would reach the sidebar as a
 * section nobody can render a heading for.
 */
function readSource(
  state: Record<string, unknown> | undefined,
): SessionSource | undefined {
  return readString(state, 'source') === 'discord' ? 'discord' : undefined;
}

function sanitizeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'ENOENT'
  );
}
