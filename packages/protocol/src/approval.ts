/**
 * What an approval gate shows, on every surface that shows one.
 *
 * ADK's generic gate hint talks about FunctionResponse payloads, which means
 * nothing to the person deciding, so each surface builds its own summary from
 * the tool name and its arguments. That summary lives here rather than beside one
 * of them because there are now two — the window's approval card and the Discord
 * message — and "Approve" has to mean the same thing in both: the exact command,
 * the exact path, the exact bytes that were pinned for this call.
 *
 * Free of React, the DOM and Node, so it is unit-tested in plain Node and can be
 * imported by either side of the IPC boundary.
 */
export interface ApprovalPreview {
  /** One line naming the action. */
  headline: string;
  /** The exact argument text, shown verbatim in a monospace block. */
  primary: string;
  /** A short line of context, when there is one. */
  note?: string;
  /** Extra content behind the primary text (a file's new contents). */
  detail?: string;
}

const PREVIEW_CHARS = 2_000;
const PREVIEW_LINES = 20;

export function summarizeApproval(
  tool: string,
  args: unknown,
): ApprovalPreview {
  const record = isRecord(args) ? args : {};

  if (tool === 'run_shell') {
    const command = stringValue(record['command']);
    const cwd = stringValue(record['cwd']);
    return {
      headline: 'Run this command in the workspace',
      primary: command ?? pretty(args),
      ...(cwd ? {note: `Working directory: ${cwd}`} : {}),
    };
  }

  if (tool === 'write_file') {
    const path = stringValue(record['path']);
    const content = stringValue(record['content']) ?? '';
    const preview = previewOf(content);
    return {
      headline: 'Overwrite this existing file',
      primary: path ?? pretty(args),
      note: `${byteLength(content)} bytes of new content will replace it`,
      ...(preview.length > 0 ? {detail: preview} : {}),
    };
  }

  if (tool === 'save_skill') {
    /*
     * The instructions are the decision here, not the name: this text becomes
     * part of the agent's system prompt from the next request onwards, so the
     * person approving it is the last chance to read what it says. The name and
     * description are context underneath.
     */
    const name = stringValue(record['name']);
    const description = stringValue(record['description']);
    const instructions = stringValue(record['instructions']) ?? '';
    const label = name ?? 'a new skill';
    const note = [label, description].filter(Boolean).join(' — ');
    const preview = previewOf(instructions);
    return {
      headline: 'Save this skill and switch it on',
      primary: preview.length > 0 ? preview : pretty(args),
      ...(note.length > 0 ? {note} : {}),
    };
  }

  return {headline: `Run ${tool}`, primary: pretty(args)};
}

/**
 * Whether ADK's own hint says anything useful. Its boilerplate is written for a
 * model, not a person, so it is dropped in favour of the summary above.
 */
export function meaningfulHint(hint: string): boolean {
  const text = hint.trim();
  if (text.length === 0) {
    return false;
  }
  return !/FunctionResponse|ToolConfirmation/i.test(text);
}

function previewOf(content: string): string {
  const lines = content.split('\n').slice(0, PREVIEW_LINES).join('\n');
  const clipped =
    lines.length > PREVIEW_CHARS ? lines.slice(0, PREVIEW_CHARS) : lines;
  const truncated = clipped.length < content.length ? `${clipped}\n…` : clipped;
  return truncated.trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** UTF-8 byte length without depending on a DOM or Node global. */
function byteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
