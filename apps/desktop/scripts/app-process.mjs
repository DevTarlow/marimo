/**
 * Starting and stopping the app, for the scripts that drive it.
 *
 * Two checks in this directory boot the real binary — `smoke.mjs` to prove the
 * window works, `jobs-check.mjs` to prove a due job runs — and both have the
 * same two traps in them, so both live here rather than in each script.
 *
 * The first trap is that the pid a launcher hands back is not the app.
 * `.bin/electron` is a shim that execs a node script, which *spawns* the real
 * binary; a kill aimed at that pid stops the wrapper and leaves the app running.
 * This app is tray-resident, so what is left is not a dead process — it is a
 * window and a tray icon that only the person sitting at the machine can clear,
 * holding the single-instance lock and a throwaway user-data directory that the
 * script is about to delete. Hence the process group: the app is started
 * `detached`, so it leads a group of its own, and every signal goes to the group
 * rather than to the pid.
 *
 * The second trap is that stopping it takes time. The app holds its quit while
 * it stops the agent — MCP children, a conversation mid-write — so a script that
 * signals and then carries on is racing the app for its own files. `stopApp`
 * waits for the group to be empty, which is what makes reading `jobs.json`
 * afterwards mean anything.
 */
import {spawn} from 'node:child_process';

/** The app this process started, if any. */
let running;

/**
 * Starts the app in a process group of its own.
 *
 * `detached` is load-bearing rather than tidy: it is what makes the child a
 * group leader, and therefore what makes `process.kill(-pid, …)` below reach the
 * real binary and not just the shim.
 */
export function startApp({command, args, cwd, env}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    ...(cwd === undefined ? {} : {cwd}),
    detached: true,
  });
  running = child;
  return child;
}

/**
 * Whether the app this process started is still there.
 *
 * A script that has to prove the app *stopped on its own* cannot ask by calling
 * `stopApp`: that kills what is still running and then reports success, so a
 * leftover would look exactly like a clean exit — which is the shape of a reset
 * bug that shipped once already. This is the question without the gesture.
 */
export function appIsRunning() {
  return running === undefined ? false : stillRunning(running);
}

/**
 * Stops the app and everything it started, and waits for it to be gone.
 *
 * SIGTERM first, because that is the path a person quitting the app takes and it
 * lets the agent stop cleanly. SIGKILL follows, to the group as well, because a
 * check that has already recorded its result must not leave a window behind.
 *
 * Answers whether the app is gone. False means something is still running under
 * that group id, and the caller is the one that knows how loudly to say so.
 */
export async function stopApp(graceMs = 8_000) {
  const child = running;
  if (child === undefined) {
    return true;
  }
  running = undefined;

  await settle(child, 'SIGTERM', graceMs);
  if (stillRunning(child)) {
    await settle(child, 'SIGKILL', 2_000);
  }
  return !stillRunning(child);
}

/** Whether the child, or anything left in its group, is still there. */
function stillRunning(child) {
  if (child.exitCode === null && child.signalCode === null) {
    return true;
  }
  try {
    // Signal 0 asks the question without sending one: a group outlives its
    // leader, so this is what finds the real binary after the shim has gone.
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signals the group, then waits for it to empty or for the deadline. */
async function settle(child, signal, withinMs) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // No group to signal: this child was never detached, or it is already gone.
    try {
      child.kill(signal);
    } catch {
      // Gone between the two checks. The wait below is what decides either way.
    }
  }

  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!stillRunning(child)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/*
 * A script that is interrupted — Ctrl-C, or a `timeout` around a hung check —
 * runs none of its own cleanup, and the app it started is detached, so it would
 * outlive the script. Registering here rather than in each caller means the
 * answer cannot be forgotten by whichever script is written next.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void stopApp(2_000).then(() => {
      process.exit(130);
    });
  });
}
