/**
 * Reading an ADK tool result, for the two places that have to.
 *
 * The turn loop translates a `functionResponse` part into the event the window
 * draws, and a delegated helper's calls take the same path through the same
 * window — so the rule for "did this fail" and "what did it say" has to be one
 * rule. It lived inside `agent-host.ts` until delegation arrived; the tool that
 * follows a helper cannot import from the host that builds it (the host imports
 * the tool), so it lives here and both import it.
 *
 * `isConfirmationRefusal` is the third of the set and it belongs with them for
 * the same reason: ADK answers a gated call with an error payload *before* it
 * emits the approval gate, and reporting that as a finished call would put a
 * failed tool beside the dialog the user is being asked to answer.
 */

export function hasError(response: unknown): boolean {
  return (
    !!response &&
    typeof response === 'object' &&
    ('error' in (response as Record<string, unknown>) ||
      'errorMessage' in (response as Record<string, unknown>))
  );
}

/**
 * ADK returns this payload instead of running a gated tool, right before it
 * emits the approval gate for the same call. Reporting it as a finished tool
 * would make the UI show a failed call next to the approval dialog, so it is
 * dropped and the call stays visibly pending until the user decides.
 */
export function isConfirmationRefusal(response: unknown): boolean {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const error = (response as {error?: unknown}).error;
  return (
    typeof error === 'string' &&
    error.startsWith('This tool call requires confirmation')
  );
}

/** What a tool returned, as one string the window can show. */
export function describeToolResult(response: unknown): string {
  if (response === undefined || response === null) {
    return '';
  }
  let value: unknown = response;
  if (typeof response === 'object' && 'result' in (response as object)) {
    value = (response as {result: unknown}).result;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
