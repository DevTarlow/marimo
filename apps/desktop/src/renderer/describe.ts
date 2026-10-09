/**
 * An error, as a sentence the user can read.
 *
 * Electron wraps a rejected `invoke` in its own prefix — "Error invoking remote
 * method 'marimo:call': Error: " — and that is machinery the person reading the
 * message has no use for. The sentence underneath it is written for them: every
 * refusal in the main process says what is wrong and what to do about it, and the
 * prefix only makes it look like a crash.
 *
 * Both halves are stripped, which took a screenshot to notice: the first regex
 * removed the wrapper and left the `Error: ` that `new Error(...)` in the main
 * process had put in front of its own sentence, so a refusal read "Error:
 * DeepSeek needs an API key. Add one in Settings." — the app's voice, with a
 * stack-trace word glued to the front of it.
 *
 * One copy in the window rather than one per caller: it was duplicated in the
 * agent hook and in Settings, which is how two spellings of it start to drift.
 */
export function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(
    /^(Error invoking remote method '[^']*':\s*)?Error:\s*/u,
    '',
  );
}
