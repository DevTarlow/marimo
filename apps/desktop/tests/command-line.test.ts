/**
 * Pasting a server's command line into one box.
 *
 * The stored shape is a command and an argument list, kept apart because
 * splitting a line on whitespace breaks on a path with a space in it. That is
 * the right shape to store and the wrong one to ask for: a connector is set up
 * by pasting the line out of a README.
 */
import {describe, expect, it} from 'vitest';

import {formatCommandLine, parseCommandLine} from '../src/renderer/command-line.js';

describe('parsing a pasted command', () => {
  it('splits a program from its arguments', () => {
    expect(parseCommandLine('npx -y @modelcontextprotocol/server-filesystem')).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    });
  });

  it('has no arguments when there are none', () => {
    expect(parseCommandLine('mcp-server')).toEqual({
      command: 'mcp-server',
      args: [],
    });
  });

  it('collapses runs of whitespace', () => {
    expect(parseCommandLine('  a   b\t\tc  ')).toEqual({
      command: 'a',
      args: ['b', 'c'],
    });
  });

  /*
   * The reason the parser exists at all. A path with a space is the case that
   * makes the naive version wrong, and it is common enough — "Application
   * Support" on macOS, "Program Files" on Windows.
   */
  it('keeps a quoted argument whole', () => {
    expect(parseCommandLine('node "/home/sam/My Servers/start.js" --port 3000')).toEqual({
      command: 'node',
      args: ['/home/sam/My Servers/start.js', '--port', '3000'],
    });
  });

  it('keeps a quoted program whole', () => {
    expect(parseCommandLine('"/opt/My Tools/server" --stdio')).toEqual({
      command: '/opt/My Tools/server',
      args: ['--stdio'],
    });
  });

  it('reads empty quotes as an empty argument, not as nothing', () => {
    // Passing an empty string and passing nothing are different arguments, and
    // a server that takes the first would be started wrong by the second.
    expect(parseCommandLine('server "" --flag')).toEqual({
      command: 'server',
      args: ['', '--flag'],
    });
  });

  it('does not treat an equals sign or a dash as special', () => {
    expect(parseCommandLine('server --env=KEY=value')).toEqual({
      command: 'server',
      args: ['--env=KEY=value'],
    });
  });

  /*
   * Not a shell. There is no expansion, no globbing and no operators, so a line
   * containing one is passed through as literal text rather than doing something
   * surprising with it.
   */
  it('does not expand or interpret anything', () => {
    expect(parseCommandLine('server $HOME *.txt | grep x')).toEqual({
      command: 'server',
      args: ['$HOME', '*.txt', '|', 'grep', 'x'],
    });
  });

  /*
   * Refused rather than guessed. A guess produces a command that is *nearly*
   * right, and nearly right for a program path is a server that fails with a
   * message about a missing file — which sends the user looking in the wrong
   * place entirely.
   */
  it('refuses an unclosed quote instead of guessing', () => {
    expect(() => parseCommandLine('server "unclosed')).toThrow(
      /unclosed quote/u,
    );
  });

  it('refuses an empty line with something a person can act on', () => {
    expect(() => parseCommandLine('   ')).toThrow(/command is needed/u);
  });
});

describe('writing it back for editing', () => {
  it('round-trips a plain line', () => {
    const line = 'npx -y @scope/server';
    const parsed = parseCommandLine(line);
    expect(formatCommandLine(parsed.command, parsed.args)).toBe(line);
  });

  /*
   * The property that matters: opening a connector to edit it and saving it
   * again must not change it. Without quoting on the way out, the space would be
   * lost and the server would stop starting — with no sign that opening the
   * settings panel was what broke it.
   */
  it('round-trips an argument containing a space', () => {
    const line = 'node "/home/sam/My Servers/start.js"';
    const parsed = parseCommandLine(line);
    const again = parseCommandLine(formatCommandLine(parsed.command, parsed.args));
    expect(again).toEqual(parsed);
  });

  it('round-trips an empty argument', () => {
    const parsed = parseCommandLine('server "" --flag');
    const again = parseCommandLine(formatCommandLine(parsed.command, parsed.args));
    expect(again).toEqual(parsed);
  });

  it('has nothing to show for a server with no command', () => {
    expect(formatCommandLine(undefined, undefined)).toBe('');
  });
});
