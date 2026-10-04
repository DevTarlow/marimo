/**
 * Turning what somebody pasted into a command and its arguments.
 *
 * The stored shape is a command and an argument list, kept apart on purpose:
 * splitting a single line on whitespace breaks the first time a path contains a
 * space, and there is no way to quote around it after the fact. That is the
 * right shape to *store* and the wrong one to *ask for* — a connector is set up
 * by pasting the line from a server's README, and a form with two boxes for one
 * line is a form people get wrong.
 *
 * So the window takes the line and this turns it into the pair. Quoting is
 * honoured, because that is how somebody escapes a path with a space in it in
 * every shell they have ever used, and finding out here is better than finding
 * out from a server that will not start.
 *
 * Deliberately not a shell parser. There is no expansion, no globbing, no
 * substitution, no operators — a connector's command line is a program and its
 * arguments, and anything more would be a way to run a shell from a settings
 * box.
 */

export interface ParsedCommand {
  command: string;
  args: string[];
}

/**
 * Splits `line` into a command and its arguments.
 *
 * Throws on an unterminated quote rather than guessing where the argument ended.
 * A guess produces a command that is *nearly* right, and "nearly right" for a
 * program path is a server that fails to start with a message about a missing
 * file — which sends the user looking in the wrong place entirely.
 */
export function parseCommandLine(line: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (const character of line) {
    if (quoted) {
      if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
      // An empty pair of quotes is an empty argument, not nothing.
      started = true;
      continue;
    }

    if (character === ' ' || character === '\t' || character === '\n') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (quoted) {
    throw new Error(
      'There is an unclosed quote in the command. Close it, or remove it — ' +
        'quotes are only needed around an argument that contains a space.',
    );
  }
  if (started) {
    tokens.push(current);
  }

  const [command, ...args] = tokens;
  if (command === undefined || command.length === 0) {
    throw new Error('A command is needed to start a server this way.');
  }
  return {command, args};
}

/**
 * The pair, written back as one line for editing.
 *
 * The inverse of the above, and quoted the same way, so opening a connector for
 * editing and saving it again does not quietly change its arguments.
 */
export function formatCommandLine(
  command: string | undefined,
  args: readonly string[] | undefined,
): string {
  if (command === undefined || command.length === 0) {
    return '';
  }
  /*
   * The command is checked for emptiness and the arguments are not. An empty
   * *argument* is a real argument — passing nothing and passing an empty string
   * are different to a program that takes one — so dropping it would quietly
   * change the server's command line. Opening a connector to look at it and
   * saving it again must not do that, because nothing would connect the breakage
   * to the settings panel that caused it.
   */
  return [command, ...(args ?? [])]
    .map((part) =>
      /*
       * An empty part is quoted too. Unquoted it would join into the surrounding
       * spaces and vanish on the way back in, which is the same silent change by
       * a different route.
       */
      part.length === 0 || /[\s"]/u.test(part)
        ? `"${part.replaceAll('"', '')}"`
        : part,
    )
    .join(' ');
}
