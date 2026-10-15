/**
 * Agent profiles.
 *
 * A profile is one agent: an identity (its system prompt), the preferences its
 * user wrote about how they want to be talked to, and the tools and skills it may
 * use. Switching profile is the app's "use a different agent" action, so the
 * profile also owns which conversations are visible — sessions are tagged with
 * the profile that created them.
 *
 * The folders are deliberately *not* here. They used to be, one list per agent,
 * and that made two agents unable to share a project; they live in
 * `workspaces.ts` now, once for the install.
 *
 * Stored as one small JSON file next to `settings.json`, written atomically and
 * serialized through a queue. It is deliberately *not* stored inside a
 * workspace: an agent's identity has to survive its folders being added,
 * renamed, or removed.
 *
 * Memory is the exception and stays where the user asked for it:
 * `<workspaceRoot>/.marimo/<profileId>/memory.md`. Deleting a profile therefore
 * never touches a file in the user's own directories.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';

import {
  agentProfileSchema,
  profilePatchSchema,
  workspaceSchema,
} from '@marimo/protocol';
import type {AgentProfile, ProfilePatch, Workspace} from '@marimo/protocol';

/** Legacy values from `settings.json`, from before profiles existed. */
export interface ProfileSeed {
  workspaceRoot?: string;
  systemPrompt?: string;
}

export interface ProfileStoreOptions {
  file: string;
  /** Identity the first profile — the lead — starts with. */
  defaultIdentity: string;
  /**
   * Identity a bot the user makes starts with, from the name it was given.
   *
   * Deliberately not `defaultIdentity`: that text describes the lead, and a bot
   * seeded with it would introduce itself as Marimo and be told to hand work to
   * bots it has no tool to do. Naming itself is the one thing a bot's seed has
   * to do, which is why this takes the name rather than being a constant.
   */
  botIdentity: (name: string) => string;
  /** Tool names a brand-new profile starts with. */
  defaultTools: string[];
  /** Skill names a brand-new profile starts with. */
  defaultSkills: string[];
}

export interface ProfileSnapshot {
  profiles: AgentProfile[];
  activeProfileId: string;
}

/**
 * The folders one profile carried, from before they were an install-wide
 * document.
 *
 * Kept beside the snapshot rather than on `AgentProfile` because it is another
 * document's data: it is handed to the workspaces store, and it stays on disk
 * until that store has written it. A profile edit in between therefore cannot
 * drop it.
 */
export interface LegacyWorkspaces {
  profileId: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

/** The on-disk shape: a snapshot plus a format version. */
export interface ProfileFile extends ProfileSnapshot {
  version: 1;
  /** Absent once there is nothing left to migrate. Never written as such. */
  legacy?: LegacyWorkspaces[];
}

export class LastProfileError extends Error {
  constructor() {
    super(
      'The last bot cannot be deleted. Create another one first.',
    );
    this.name = 'LastProfileError';
  }
}

export class UnknownProfileError extends Error {
  constructor(profileId: string) {
    super(`Unknown bot: ${profileId}`);
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
      label: 'The bots file',
    });
    if (read.state === 'too-new') {
      /*
       * The cached answer is a fresh profile, so the window opens and is usable.
       * What it must not do is *write* — and it cannot, because every mutation
       * goes through `assertWritable` below and refuses.
       */
      throw new DocumentTooNewError(
        'The bots file',
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

  /** Creates a profile and switches to it, so "New agent" is one click. */
  async create(name?: string): Promise<AgentProfile> {
    return await this.withLock(async () => {
      const file = await this.load();
      /*
       * Two agents with the same name are indistinguishable in the picker, so a
       * new one always gets a distinct label. The identity is built from that
       * label rather than from what was typed, so a bot called "Agent 2" says so
       * instead of naming the one that already existed.
       */
      const unique = uniqueName(file.profiles, name?.trim() || 'Agent');
      const profile: AgentProfile = {
        id: randomUUID(),
        name: unique,
        identity: this.options.botIdentity(unique),
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
      /*
       * The fields a patch may *unset*, resolved before the literal below
       * because "unset" is a third case the spread cannot express: `null` means
       * "back to the app's default" for a model, "every connector" for a grant
       * and "wherever the rail is" for an agent's space, and the absence of the
       * field is what says so. They are taken out of what is carried over and
       * put back only when there is something to put back, so a cleared field
       * cannot survive in the copy.
       */
      const {
        mcpServerIds: storedGrant,
        model: storedModel,
        spaceId: storedSpace,
        ...carried
      } = current;
      const grant = patchedValue(clean.mcpServerIds, storedGrant);
      const model = patchedValue(clean.model, storedModel);
      const space = patchedValue(clean.spaceId, storedSpace);
      const updated: AgentProfile = {
        ...carried,
        ...(clean.name !== undefined ? {name: clean.name} : {}),
        ...(clean.identity !== undefined ? {identity: clean.identity} : {}),
        /*
         * An empty string is kept rather than dropped: "clear it" and "leave it
         * alone" are different requests, and only one of them arrives as
         * `undefined`. The composer treats a blank preference as absent.
         */
        ...(clean.preferences !== undefined
          ? {preferences: clean.preferences}
          : {}),
        ...(clean.enabledTools !== undefined
          ? {enabledTools: [...new Set(clean.enabledTools)]}
          : {}),
        ...(clean.enabledSkills !== undefined
          ? {enabledSkills: [...new Set(clean.enabledSkills)]}
          : {}),
        // Deduplicated for the reason the two lists above are: the grant is a
        // set, and naming one connector twice is a second answer to what the
        // agent may use.
        ...(grant === undefined ? {} : {mcpServerIds: [...new Set(grant)]}),
        ...(model === undefined ? {} : {model}),
        ...(space === undefined ? {} : {spaceId: space}),
      };
      await this.writeFile(replaceProfile(updated, file));
      return updated;
    });
  }

  /**
   * Whether this profile may be removed, on its own.
   *
   * The same refusal `remove` makes, available before anything else happens,
   * because removing a bot destroys more than this file holds — its
   * conversations, its jobs, its memory — and the one outcome that must never
   * happen is finding out it was the last bot *after* those are gone. `remove`
   * calls it too, inside its lock, so the rule is written once.
   */
  async assertRemovable(profileId: string): Promise<void> {
    refuseLast(await this.load(), profileId);
  }

  /**
   * Removes a profile.
   *
   * Its conversations, jobs and stored memory are the caller's business — see
   * `AgentRuntime.removeProfile`, which deletes them — and the memory files it
   * kept *inside a Space* stay there, because those are the user's own folder.
   */
  async remove(profileId: string): Promise<ProfileFile> {
    return await this.withLock(async () => {
      const file = await this.load();
      refuseLast(file, profileId);

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
   * The folders a pre-workspaces file held, waiting to be adopted.
   *
   * Answers nothing once there is nothing to migrate, which is the answer on
   * every install that has already been through it.
   */
  async legacyWorkspaces(): Promise<LegacyWorkspaces[] | undefined> {
    const file = await this.load();
    return file.legacy === undefined || file.legacy.length === 0
      ? undefined
      : file.legacy;
  }

  /**
   * Drops the legacy fields from the file.
   *
   * Called only after the workspaces store has written them into its own
   * document. Until then they are preserved on every write, which is what stops
   * a profile edit during the upgrade from destroying the only copy.
   */
  async clearLegacy(): Promise<void> {
    await this.withLock(async () => {
      const file = await this.load();
      if (file.legacy === undefined) {
        return;
      }
      const {legacy: _dropped, ...rest} = file;
      await this.writeFile({...rest, version: 1});
    });
  }

  private freshFile(seed?: ProfileSeed): ProfileFile {
    const profile: AgentProfile = {
      id: randomUUID(),
      name: 'Marimo',
      /*
       * The lead, and the only profile `defaultIdentity` is for: it is first in
       * the document, which is what `AgentRuntime.catalog` reads to decide whose
       * Reset seed is the app's constant. A bot made later is seeded from its own
       * name instead — see `create`.
       */
      identity: seed?.systemPrompt?.trim() || this.options.defaultIdentity,
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
    await assertWritable(this.options.file, {label: 'The bots file'});
    await mkdir(dirname(this.options.file), {recursive: true});
    const target = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(
      target,
      `${JSON.stringify(toDocument(file), null, 2)}\n`,
      'utf8',
    );
    await rename(target, this.options.file);
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

/**
 * The folders one profile used to carry, read off the raw entry.
 *
 * Read by hand rather than by widening the profile schema: this shape is not one
 * this build writes, and a malformed entry has to be *dropped* rather than be
 * allowed to fail the profile it sits on — the folders are recoverable, the
 * agent's identity is not.
 */
function legacyFrom(
  raw: unknown,
  profileId: string,
): LegacyWorkspaces | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const entry = raw as {workspaces?: unknown; activeWorkspaceId?: unknown};
  if (entry.workspaces === undefined && entry.activeWorkspaceId === undefined) {
    return undefined;
  }
  const workspaces: Workspace[] = [];
  if (Array.isArray(entry.workspaces)) {
    for (const candidate of entry.workspaces) {
      const parsed = workspaceSchema.safeParse(candidate);
      if (parsed.success) {
        workspaces.push(parsed.data);
      }
    }
  }
  return {
    profileId,
    workspaces,
    activeWorkspaceId:
      typeof entry.activeWorkspaceId === 'string'
        ? entry.activeWorkspaceId
        : null,
  };
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
  const legacy: LegacyWorkspaces[] = [];
  for (const entry of candidate.profiles) {
    const parsed = agentProfileSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    profiles.push(parsed.data);
    const carried = legacyFrom(entry, parsed.data.id);
    if (carried !== undefined) {
      legacy.push(carried);
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

  return {
    version: 1,
    profiles,
    activeProfileId,
    ...(legacy.length > 0 ? {legacy} : {}),
  };
}

/**
 * The document as it goes to disk.
 *
 * Built explicitly rather than by spreading the snapshot, so `legacy` can never
 * leak into the file as a field of its own — it is the same folders the profiles
 * carry, and this is where they are put back where the next build's parser looks
 * for them.
 */
function toDocument(file: ProfileFile): Record<string, unknown> {
  return {
    version: 1,
    activeProfileId: file.activeProfileId,
    profiles: file.profiles.map((profile) => {
      const legacy = file.legacy?.find(
        (entry) => entry.profileId === profile.id,
      );
      return legacy === undefined
        ? profile
        : {
            ...profile,
            workspaces: legacy.workspaces,
            activeWorkspaceId: legacy.activeWorkspaceId,
          };
    }),
  };
}

function activeProfileOf(file: ProfileSnapshot): AgentProfile {
  return (
    file.profiles.find((entry) => entry.id === file.activeProfileId) ??
    (file.profiles[0] as AgentProfile)
  );
}

/**
 * One value a patch may leave alone, replace, or unset.
 *
 * Three cases, and the third is why this is a function rather than a `??` at the
 * call site: `undefined` keeps what is stored, `null` answers `undefined` so the
 * field is *removed* and its own default applies again, and anything else is the
 * new value. Three fields on a profile have that shape, and a rule with three
 * cases written out three times is one where a case eventually goes missing from
 * one of them.
 */
function patchedValue<T>(
  patched: T | null | undefined,
  stored: T | undefined,
): T | undefined {
  return patched === null ? undefined : (patched ?? stored);
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

/**
 * The one rule about which profiles may go: the app is unusable without one.
 *
 * Named rather than inlined because two callers ask: the removal itself, and
 * `AgentRuntime.removeProfile`, which has to be told no *before* it destroys the
 * conversations and jobs belonging to a bot it is not allowed to remove.
 */
function refuseLast(file: ProfileSnapshot, profileId: string): AgentProfile {
  const profile = requireProfile(file, profileId);
  if (file.profiles.length <= 1) {
    throw new LastProfileError();
  }
  return profile;
}

/** Writes one changed profile back into the file it came from. */
function replaceProfile(profile: AgentProfile, file: ProfileFile): ProfileFile {
  return {
    version: 1,
    activeProfileId: file.activeProfileId,
    profiles: file.profiles.map((entry) =>
      entry.id === profile.id ? profile : entry,
    ),
    // Carried through untouched: it is another document's data until the
    // workspaces store has adopted it, and dropping it here would be the one
    // write that loses a user's folders.
    ...(file.legacy === undefined ? {} : {legacy: file.legacy}),
  };
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
