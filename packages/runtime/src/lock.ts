/**
 * A lock that works between processes, not just within one.
 *
 * The app and the headless job runner are two processes over one set of files.
 * The in-process queue each store keeps is not enough for that: two processes can
 * read `jobs.json`, both see the same due occurrence, both write, and one write
 * is simply lost. For a job marker that means the occurrence is consumed twice
 * and the run happens twice — the same scheduled message arriving twice, which
 * is the failure this whole arrangement exists to prevent.
 *
 * The mechanism is the filesystem's own `O_EXCL`: `open(path, 'wx')` either
 * creates the file or fails, with no window between checking and creating, and
 * that is atomic on every platform this app runs on. It is the one primitive
 * available without a native module.
 *
 * Two things it is deliberately not:
 *
 * - **Not a long-held lock.** The holders are individual read-modify-write
 *   operations, milliseconds each. A lock held for the life of a process would
 *   need heartbeats and a much more careful staleness story, and this does not.
 * - **Not fair.** A waiting caller retries; there is no queue, so a caller can in
 *   principle be overtaken. Every holder here finishes in milliseconds, so the
 *   wait is short and bounded, and starvation is not a real risk.
 */
import {mkdir, open, readFile, rm, stat, utimes} from 'node:fs/promises';
import {hostname} from 'node:os';
import {dirname} from 'node:path';

/** How long to keep trying before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * How old a lock file has to be before it is treated as abandoned.
 *
 * Generous next to the milliseconds a holder takes, because stealing a lock that
 * is genuinely held is worse than waiting: the whole point is mutual exclusion,
 * and a wrongly-stolen lock is one that does not exclude anything. A process
 * killed mid-write is the case this covers — its lock file stays behind with
 * nothing to remove it.
 */
const DEFAULT_STALE_MS = 15_000;

/** How long to wait between attempts. */
const RETRY_MS = 20;

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  now?: () => number;
  /** Injected so a test does not spend real seconds waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Raised when the lock could not be taken in time.
 *
 * A caller that cannot get the lock has to decide something — retry later, skip
 * this look, tell the user — and it cannot decide well from a silent hang, so
 * this is thrown rather than waited out forever.
 */
export class FileLockTimeoutError extends Error {
  constructor(readonly path: string, readonly waitedMs: number) {
    super(
      `Could not take the lock at ${path} within ${waitedMs}ms. Another ` +
        'copy of Marimo Bot is using it.',
    );
    this.name = 'FileLockTimeoutError';
  }
}

/**
 * Runs `task` while holding `lockPath`, releasing it whatever happens.
 *
 * The lock is released in a `finally`, so a task that throws — which is the
 * normal way a store reports a bad document — cannot leave the file behind and
 * wedge every later caller until the staleness window passes.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  await mkdir(dirname(lockPath), {recursive: true});
  const deadline = now() + timeoutMs;

  for (;;) {
    if (await tryCreate(lockPath)) {
      break;
    }

    /*
     * Somebody has it. If their file is old enough that they cannot still be
     * working on a milliseconds-long write, they are gone — killed, or the
     * machine lost power — and the file is debris rather than a lock.
     */
    if (await isAbandoned(lockPath, staleMs, now)) {
      await rm(lockPath, {force: true});
      continue;
    }

    if (now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, timeoutMs);
    }
    await sleep(RETRY_MS);
  }

  try {
    return await task();
  } finally {
    await rm(lockPath, {force: true}).catch(() => undefined);
  }
}

/** `O_EXCL`: creates the file, or tells us somebody else has it. */
async function tryCreate(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx');
    await handle.close();
    return true;
  } catch (error) {
    if (isAlreadyThere(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether the lock file has outlived any plausible holder.
 *
 * The modification time rather than the file's contents: a holder writes its pid
 * for a human debugging a stuck lock, but the age is what decides this, and a
 * pid would have to be checked for liveness — which is wrong on a pid that has
 * been recycled, and impossible for a lock taken on a different machine over a
 * shared home directory.
 */
async function isAbandoned(
  path: string,
  staleMs: number,
  now: () => number,
): Promise<boolean> {
  try {
    const info = await stat(path);
    const age = now() - info.mtimeMs;
    if (age <= staleMs) {
      return false;
    }
    /*
     * Touched before removal, so two waiters that both decide it is abandoned
     * do not both delete a lock a third has just taken: the one that loses the
     * race finds the file younger than it thought and waits again.
     */
    await utimes(path, new Date(), new Date()).catch(() => undefined);
    return true;
  } catch {
    // It went away between the failed create and here, which means whoever had
    // it is done. The next attempt will take it.
    return false;
  }
}

function isAlreadyThere(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'EEXIST'
  );
}

/**
 * A lock one process holds for as long as it runs.
 *
 * Different from `withFileLock` in exactly one way, and it is the reason this is
 * a second function rather than an option: the staleness rule. A read-modify-
 * write lasts milliseconds, so an old lock file is debris. A lock held for the
 * life of the app lasts *days*, so age says nothing at all — a lock file from
 * this morning is a lock file from a running app.
 *
 * So this one records the process that took it and asks whether that process is
 * still alive. `EPERM` counts as alive: the pid exists and belongs to somebody
 * else, which on a shared machine is a real answer rather than an error.
 */
export interface ProcessLock {
  release(): Promise<void>;
}

export interface ProcessLockOptions {
  /** The pid to record. Injected so a test can pretend to be someone else. */
  pid?: number;
  host?: string;
  /** Whether a pid is alive. Injected for the same reason. */
  isAlive?: (pid: number) => boolean;
}

/** Whether a process is still running. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 checks for existence without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is not ours. ESRCH: it is gone.
    return (error as {code?: string}).code === 'EPERM';
  }
}

/**
 * Takes a lock for as long as this process lives, or answers why it could not.
 *
 * `undefined` means somebody else holds it and is still running — which, for the
 * caller this exists for, is the answer "the app is open, so it is already
 * running the jobs".
 *
 * The returned handle is idempotent to release, because a shutdown path can run
 * more than once.
 */
export async function holdProcessLock(
  path: string,
  options: ProcessLockOptions = {},
): Promise<ProcessLock | undefined> {
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const isAlive = options.isAlive ?? processIsAlive;

  await mkdir(dirname(path), {recursive: true});

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({pid, host, since: Date.now()}));
      await handle.close();
      return {
        release: async () => {
          await rm(path, {force: true}).catch(() => undefined);
        },
      };
    } catch (error) {
      if (!isAlreadyThere(error)) {
        throw error;
      }
    }

    const holder = await readHolder(path);
    // A lock file nobody can parse is one nobody can be holding.
    if (holder !== undefined && holder.pid !== pid && isAlive(holder.pid)) {
      return undefined;
    }

    /*
     * Either the holder is gone or the file is unreadable. Both mean the lock is
     * debris — from a crash, or from a version that wrote it differently — and
     * the second attempt takes it.
     */
    await rm(path, {force: true}).catch(() => undefined);
  }

  return undefined;
}

/** Whether somebody is holding this lock right now. */
export async function isProcessHeld(
  path: string,
  options: ProcessLockOptions = {},
): Promise<boolean> {
  const isAlive = options.isAlive ?? processIsAlive;
  const holder = await readHolder(path);
  return holder !== undefined && isAlive(holder.pid);
}

interface LockHolder {
  pid: number;
  host: string;
  since: number;
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as {pid?: unknown}).pid === 'number'
    ) {
      return parsed as LockHolder;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
