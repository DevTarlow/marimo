/**
 * Agent profiles.
 *
 * A profile is one agent: an identity (its system prompt), the folders it knows
 * about, and the tools and skills it may use. Switching profile is the app's
 * "use a different agent" action, so the profile also owns which conversations
 * are visible — sessions are tagged with the profile that created them.
 *
 * Stored as one small JSON file next to `settings.json`, written atomically and
 * serialized through a queue. It is deliberately *not* stored inside a
 * workspace: a profile owns many folders, and its identity has to survive those
 * folders being added, renamed, or removed.
 *
 * Memory is the exception and stays where the user asked for it:
 * `<workspaceRoot>/.marimo/<profileId>/memory.md`. Deleting a profile therefore
 * never touches a file in the user's own directories.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';

import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from './migrations.js';

import {agentProfileSchema, profilePatchSchema} from '@marimo/protocol';
import type {AgentProfile, ProfilePatch, Workspace} from '@marimo/protocol';

/** Legacy values from `settings.json`, from before profiles existed. */
export interface ProfileSeed {
  workspaceRoot?: string;
  systemPrompt?: string;
}

export interface ProfileStoreOptions {
  file: string;
  /** Used when the app has no workspace to point at yet. */
  defaultWorkspaceRoot: string;
  /** Identity a brand-new profile starts with. */
  defaultIdentity: string;
  /** Tool names a brand-new profile starts with. */
  defaultTools: string[];
  /** Skill names a brand-new profile starts with. */
  defaultSkills: string[];
}

export interface ProfileSnapshot {
  profiles: AgentProfile[];
  activeProfileId: string;
}

/** The on-disk shape: a snapshot plus a format version. */
export interface ProfileFile extends ProfileSnapshot {
  version: 1;
}

export class LastProfileError extends Error {
  constructor() {
    super(
      'The last agent profile cannot be deleted. Create another one first.',
    );
    this.name = 'LastProfileError';
  }
}

export class UnknownProfileError extends Error {
  constructor(profileId: string) {
    super(`Unknown agent profile: ${profileId}`);
    this.name = 'UnknownProfileError';
  }
}

export class ProfileStore {
  private cache: ProfileFile | undefined;
  /**
   * The read in flight, memoised as a *promise* rather than as a value.
   *
   * Two callers that arrive before the first read has finished would otherwise
   * both find no file — which is what a fresh install looks like — both create a
   * profile, and both write. Each gets a profile with its own random id, only one
   * of them ends up on disk, and the other caller is left holding an agent that
   * does not exist. It surfaces as "there is no agent called <id>" from a window
   * that was handed that id a moment earlier: at random, on first run, and never
   * again.
   */
  private loading: Promise<ProfileFile> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProfileStoreOptions) {}

  /**
   * Reads the profile file, seeding one on first run or when the file cannot be
   * understood. `seed` carries the legacy settings values so an upgrade keeps
   * the workspace and the prompt the user already had.
   */
  async load(seed?: ProfileSeed): Promise<ProfileFile> {
    /*
     * The cache first, every time. A mutation replaces it — that is how a caller
     * sees the edit it just made — so a memoised *result* would go on answering
     * with the file as it was before the first write.
     */
    if (this.cache) {
      return this.cache;
    }

    /*
     * Only the read in flight is shared. Two callers that arrive before the
     * first has finished would otherwise both find no file — which is what a
     * fresh install looks like — both create a profile, and both write. Each
     * gets a profile with its own random id, only one is on disk, and the other
     * caller is left holding an agent that does not exist.
     */
    const inFlight = (this.loading ??= this.readOrCreate(seed));
    try {
      return await inFlight;
    } finally {
      if (this.loading === inFlight) {
        this.loading = undefined;
      }
    }
  }

  private async readOrCreate(seed?: ProfileSeed): Promise<ProfileFile> {
    if (this.cache) {
      return this.cache;
    }

    /*
     * Read through the version machinery, and *refuse* a file from a newer build
     * rather than treating it as a stranger.
     *
     * This is the difference between two failures that look alike and are not.
     * Without the version check, a profiles file a future build wrote either
     * parses and is then overwritten as version 1 — silently dropping whatever
     * that build added — or fails to parse at all and is quarantined, which
     * renames the user's agents out of the way and starts fresh. The second is
     * the worse one: it looks exactly like having lost them.
     */
    const read = await readVersionedDocument(this.options.file, {
      label: 'The agents file',
    });
    if (read.state === 'too-new') {
      /*
       * The cached answer is a fresh profile, so the window opens and is usable.
       * What it must not do is *write* — and it cannot, because every mutation
       * goes through `assertWritable` below and refuses.
       */
      throw new DocumentTooNewError(
        'The agents file',
        read.found,
        read.supported,
      );
    }

    const raw =
      read.state === 'current' || read.state === 'migrated'
        ? read.document
        : undefined;
    const parsed = parseFile(raw);
    if (parsed) {
      this.cache = parsed;
      /*
       * A file that was upgraded is written back now rather than at the next
       * edit. Leaving it means the upgrade runs again on every launch, and a
       * user who never edits anything never gets the newer format — which is
       * invisible until a later version's migration assumes it.
       */
      if (read.state === 'migrated') {
        await this.writeFile(parsed);
      }
      return parsed;
    }
    /*
     * A file we cannot read is preserved before anything replaces it: the
     * profiles it held are the user's agents, and a parse bug must not be the
     * end of them. That covers both kinds of unusable — something that parsed
     * but is not a profile document, and something the version machinery could
     * not make sense of at all.
     */
    if (raw !== undefined || read.state === 'unreadable') {
      await rename(
        this.options.file,
        `${this.options.file}.unreadable-${Date.now()}`,
      ).catch(() => undefined);
    }
    // First run, or a file that cannot be made sense of: start from one profile,
    // keeping the old settings-file values so an upgrade loses nothing.
    const created = this.freshFile(seed);
    await this.writeFile(created);
    // Cached here as well as on the read path. The next caller must see this
    // file, not read the directory again and decide there is nothing there.
    this.cache = created;
    return created;
  }

  async profiles(): Promise<AgentProfile[]> {
    return (await this.load()).profiles;
  }

  async activeProfileId(): Promise<string> {
    return (await this.load()).activeProfileId;
  }

  async activeProfile(): Promise<AgentProfile> {
    return activeProfileOf(await this.load());
  }

  /** The folder the active profile is working in, if it has one. */
  async activeWorkspace(): Promise<Workspace | undefined> {
    const profile = await this.activeProfile();
    return profile.workspaces.find(
      (entry) => entry.id === profile.activeWorkspaceId,
    );
  }

  /** Creates a profile and switches to it, so "New agent" is one click. */
  async create(name?: string): Promise<AgentProfile> {
    return await this.withLock(async () => {
      const file = await this.load();
      const profile: AgentProfile = {
        id: randomUUID(),
        // Two agents with the same name are indistinguishable in the picker, so
        // a new one always gets a distinct label.
        name: uniqueName(file.profiles, name?.trim() || 'Agent'),
        identity: this.options.defaultIdentity,
        workspaces: [],
        activeWorkspaceId: null,
        enabledTools: [...this.options.defaultTools],
        enabledSkills: [...this.options.defaultSkills],
      };
      await this.writeFile({
        ...file,
        profiles: [...file.profiles, profile],
        activeProfileId: profile.id,
      });
      return profile;
    });
  }

  async update(profileId: string, patch: ProfilePatch): Promise<AgentProfile> {
    return await this.withLock(async () => {
      const file = await this.load();
      const current = requireProfile(file, profileId);
      const parsed = profilePatchSchema.safeParse(patch);
      const clean = parsed.success ? parsed.data : {};
      const updated: AgentProfile = {
        ...current,
        ...(clean.name !== undefined ? {name: clean.name} : {}),
        ...(clean.identity !== undefined ? {identity: clean.identity} : {}),
        ...(clean.enabledTools !== undefined
          ? {enabledTools: [...new Set(clean.enabledTools)]}
          : {}),
        ...(clean.enabledSkills !== undefined
          ? {enabledSkills: [...new Set(clean.enabledSkills)]}
          : {}),
      };
      await this.writeFile(replaceProfile(updated, file));
      return updated;
    });
  }

  /**
   * Removes a profile. Its conversations are the caller's business (the bridge
   * deletes them); its memory files stay in whatever folders it used.
   */
  async remove(profileId: string): Promise<ProfileFile> {
    return await this.withLock(async () => {
      const file = await this.load();
      requireProfile(file, profileId);
      if (file.profiles.length <= 1) {
        throw new LastProfileError();
      }

      const profiles = file.profiles.filter((entry) => entry.id !== profileId);
      const next: ProfileFile = {
        version: 1,
        profiles,
        activeProfileId:
          file.activeProfileId === profileId
            ? (profiles[0] as AgentProfile).id
            : file.activeProfileId,
      };
      await this.writeFile(next);
      return next;
    });
  }

  async select(profileId: string): Promise<AgentProfile> {
    return await this.withLock(async () => {
      const file = await this.load();
      const profile = requireProfile(file, profileId);
      await this.writeFile({...file, activeProfileId: profileId});
      return profile;
    });
  }

  /**
   * Adds a folder to the active profile and makes it active. A path that is
   * already listed is selected rather than duplicated, so adding the same folder
   * twice is harmless.
   */
  async addWorkspace(path: string, name?: string): Promise<Workspace> {
    return await this.withLock(async () => {
      const file = await this.load();
      const profile = activeProfileOf(file);
      const absolute = resolve(path);
      const existing = profile.workspaces.find(
        (entry) => entry.path === absolute,
      );
      const workspace: Workspace = existing ?? {
        id: randomUUID(),
        name: name?.trim() || workspaceLabel(absolute),
        path: absolute,
      };
      await this.activateWorkspace(file, profile, workspace);
      return workspace;
    });
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // Writing a blank label would persist a file its own schema rejects, and
      // the next read would drop the whole profile with it.
      throw new Error('A workspace name cannot be empty.');
    }
    return await this.withLock(async () => {
      const file = await this.load();
      const profile = activeProfileOf(file);
      const workspace = requireWorkspace(profile, workspaceId);
      const renamed: Workspace = {...workspace, name: trimmed};
      await this.writeFile(
        replaceProfile(
          {
            ...profile,
            workspaces: profile.workspaces.map((entry) =>
              entry.id === workspaceId ? renamed : entry,
            ),
          },
          file,
        ),
      );
      return renamed;
    });
  }

  /** Forgets a folder. Nothing on disk is touched. */
  async removeWorkspace(workspaceId: string): Promise<void> {
    return await this.withLock(async () => {
      const file = await this.load();
      const profile = activeProfileOf(file);
      requireWorkspace(profile, workspaceId);
      const remaining = profile.workspaces.filter(
        (entry) => entry.id !== workspaceId,
      );
      await this.writeFile(
        replaceProfile(
          {
            ...profile,
            workspaces: remaining,
            activeWorkspaceId:
              profile.activeWorkspaceId === workspaceId
                ? (remaining[0]?.id ?? null)
                : profile.activeWorkspaceId,
          },
          file,
        ),
      );
    });
  }

  async selectWorkspace(workspaceId: string): Promise<Workspace> {
    return await this.withLock(async () => {
      const file = await this.load();
      const profile = activeProfileOf(file);
      const workspace = requireWorkspace(profile, workspaceId);
      await this.activateWorkspace(file, profile, workspace);
      return workspace;
    });
  }

  private async activateWorkspace(
    file: ProfileFile,
    profile: AgentProfile,
    workspace: Workspace,
  ): Promise<void> {
    const known = profile.workspaces.some((entry) => entry.id === workspace.id);
    await this.writeFile(
      replaceProfile(
        {
          ...profile,
          workspaces: known
            ? profile.workspaces
            : [...profile.workspaces, workspace],
          activeWorkspaceId: workspace.id,
        },
        file,
      ),
    );
  }

  private freshFile(seed?: ProfileSeed): ProfileFile {
    const path = resolve(
      seed?.workspaceRoot ?? this.options.defaultWorkspaceRoot,
    );
    const workspace: Workspace = {
      id: randomUUID(),
      name: workspaceLabel(path),
      path,
    };
    const profile: AgentProfile = {
      id: randomUUID(),
      name: 'Marimo',
      identity: seed?.systemPrompt?.trim() || this.options.defaultIdentity,
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      enabledTools: [...this.options.defaultTools],
      enabledSkills: [...this.options.defaultSkills],
    };
    return {version: 1, profiles: [profile], activeProfileId: profile.id};
  }

  private async writeFile(file: ProfileFile): Promise<void> {
    /*
     * Refused before anything is written. The rule the whole document apparatus
     * exists for: a lenient read plus a write is how a user's data disappears,
     * and "the read was lenient" is precisely what a newer file causes.
     */
    await assertWritable(this.options.file, {label: 'The agents file'});
    await mkdir(dirname(this.options.file), {recursive: true});
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temporary, this.options.file);
    this.cache = file;
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

function parseFile(raw: unknown): ProfileFile | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const candidate = raw as {profiles?: unknown; activeProfileId?: unknown};
  if (!Array.isArray(candidate.profiles)) {
    return undefined;
  }

  const profiles: AgentProfile[] = [];
  for (const entry of candidate.profiles) {
    const parsed = agentProfileSchema.safeParse(entry);
    if (parsed.success) {
      profiles.push(parsed.data);
    }
  }
  if (profiles.length === 0) {
    return undefined;
  }

  const activeProfileId =
    typeof candidate.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === candidate.activeProfileId)
      ? candidate.activeProfileId
      : (profiles[0] as AgentProfile).id;

  return {version: 1, profiles, activeProfileId};
}

function activeProfileOf(file: ProfileSnapshot): AgentProfile {
  return (
    file.profiles.find((entry) => entry.id === file.activeProfileId) ??
    (file.profiles[0] as AgentProfile)
  );
}

function requireProfile(
  file: ProfileSnapshot,
  profileId: string,
): AgentProfile {
  const profile = file.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new UnknownProfileError(profileId);
  }
  return profile;
}

function requireWorkspace(
  profile: AgentProfile,
  workspaceId: string,
): Workspace {
  const workspace = profile.workspaces.find(
    (entry) => entry.id === workspaceId,
  );
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}

/** Writes one changed profile back into the file it came from. */
function replaceProfile(profile: AgentProfile, file: ProfileFile): ProfileFile {
  return {
    version: 1,
    activeProfileId: file.activeProfileId,
    profiles: file.profiles.map((entry) =>
      entry.id === profile.id ? profile : entry,
    ),
  };
}

/** `project` for a path, or the path itself when it has no last segment. */
export function workspaceLabel(path: string): string {
  const label = basename(resolve(path));
  return label.length > 0 ? label : resolve(path);
}

function uniqueName(profiles: AgentProfile[], base: string): string {
  const taken = new Set(profiles.map((profile) => profile.name));
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
