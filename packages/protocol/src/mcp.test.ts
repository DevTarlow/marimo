/**
 * What a user may write into an MCP server's configuration.
 *
 * These are the failures the Settings form cannot catch by itself, and every one
 * of them is silent at runtime rather than at save time: a name with a slash in
 * it produces tools the model cannot call, a duplicated name produces two tools
 * with one name, and a command split into arguments wrongly produces a server
 * that will not start with a message about a file that does exist.
 */
import {describe, expect, it} from 'vitest';

import {
  mcpServerSchema,
  mcpServersAreDistinct,
  mcpToolName,
  mcpToolPrefix,
} from './mcp.js';

function stdio(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp:notes',
    name: 'notes',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-notes'],
    enabled: true,
    trusted: false,
    ...overrides,
  };
}

function http(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp:remote',
    name: 'remote',
    transport: 'http',
    url: 'https://example.test/mcp',
    enabled: true,
    trusted: false,
    ...overrides,
  };
}

describe('the server name', () => {
  it('accepts a lower-case slug', () => {
    expect(mcpServerSchema.safeParse(stdio({name: 'notes_v2'})).success).toBe(
      true,
    );
  });

  /*
   * Every one of these would produce a tool name the model's API refuses, and
   * the refusal happens at request time — as a complaint about the tool list,
   * naming a tool the user never typed.
   */
  it.each(['Notes', 'my notes', 'notes/server', 'notes.server', '_notes', ''])(
    'rejects %o',
    (name) => {
      expect(mcpServerSchema.safeParse(stdio({name})).success).toBe(false);
    },
  );

  it('rejects a name long enough to crowd out the tool name it prefixes', () => {
    expect(
      mcpServerSchema.safeParse(stdio({name: 'a'.repeat(33)})).success,
    ).toBe(false);
  });
});

describe('the transport decides which fields are required', () => {
  it('wants a command for a stdio server', () => {
    const result = mcpServerSchema.safeParse(stdio({command: undefined}));
    expect(result.success).toBe(false);
    if (!result.success) {
      // The complaint lands on the field the user has to fill in, not on the
      // object: a message about the whole form is a message about nothing.
      expect(result.error.issues[0]?.path).toEqual(['command']);
    }
  });

  it('does not want a URL for a stdio server', () => {
    expect(mcpServerSchema.safeParse(stdio({url: undefined})).success).toBe(true);
  });

  it('wants a URL for an HTTP server', () => {
    const result = mcpServerSchema.safeParse(http({url: undefined}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['url']);
    }
  });

  it('refuses a URL that is not http or https', () => {
    // A file: or ftp: URL would be a request the transport cannot make, and the
    // failure would arrive as a connection error rather than as a typo.
    expect(mcpServerSchema.safeParse(http({url: 'ftp://example.test'})).success).toBe(
      false,
    );
    expect(mcpServerSchema.safeParse(http({url: 'example.test/mcp'})).success).toBe(
      false,
    );
  });

  /*
   * The bug the Python version shipped: it split the whole command line on
   * whitespace, so a path with a space in it became two arguments and the server
   * failed to start with a complaint about a file that does exist.
   */
  it('keeps an argument containing a space as one argument', () => {
    const parsed = mcpServerSchema.parse(
      stdio({
        command: '/opt/my tools/server',
        args: ['--root', '/home/someone/My Documents'],
      }),
    );

    expect(parsed.command).toBe('/opt/my tools/server');
    expect(parsed.args).toEqual(['--root', '/home/someone/My Documents']);
  });
});

describe('credentials', () => {
  it('accepts non-secret environment values', () => {
    const parsed = mcpServerSchema.parse(
      stdio({env: {NOTES_DIR: '/tmp/notes'}}),
    );
    expect(parsed.env).toEqual({NOTES_DIR: '/tmp/notes'});
  });

  /*
   * The other Python gap: its HTTP transport accepted headers but nothing ever
   * passed any, so a remote server requiring an API key could not be configured
   * at all. The header *value* is not here — it is in the secret store — and
   * this records only that it exists and where it goes.
   */
  it('accepts headers by name, with the value kept elsewhere', () => {
    const parsed = mcpServerSchema.parse(
      http({secrets: [{target: 'header', name: 'Authorization'}]}),
    );
    expect(parsed.secrets).toEqual([
      {target: 'header', name: 'Authorization'},
    ]);
    // Nothing resembling a value is storable here.
    expect(JSON.stringify(parsed)).not.toContain('Bearer');
  });

  it('refuses a secret reference with no name', () => {
    expect(
      mcpServerSchema.safeParse(http({secrets: [{target: 'header', name: ''}]}))
        .success,
    ).toBe(false);
  });
});

describe('trust', () => {
  it('is a required choice, not an omission', () => {
    // Defaulting it would be the wrong kind of convenience: a server that became
    // trusted because a field was missing is exactly the failure the flag exists
    // to prevent.
    const {trusted: _omitted, ...withoutTrust} = stdio();
    expect(mcpServerSchema.safeParse(withoutTrust).success).toBe(false);
  });
});

/*
 * How a connector's secrets are stored.
 *
 * The field is optional in the file and answered by the parse, and both halves
 * matter. Optional, because every connectors list written before this existed has
 * no such field and a required one would fail the *settings* schema for those
 * installs — costing the user every other setting they had. Answered, because the
 * missing case has to mean the safe thing everywhere an entry is read: an entry
 * that says nothing is encrypted, and only a connector the user explicitly let
 * the runner read is written in the clear.
 */
describe('secret storage', () => {
  it('parses an entry that predates the choice', () => {
    // `stdio()` is that entry: it says nothing about storage, which is what every
    // connectors list written before this choice looks like.
    expect(mcpServerSchema.safeParse(stdio()).success).toBe(true);
  });

  it('reads a missing field as the keychain, not as readable', () => {
    expect(mcpServerSchema.parse(stdio()).secretStorage).toBe('keychain');
  });

  it('keeps the plaintext consent the user gave', () => {
    expect(
      mcpServerSchema.parse(stdio({secretStorage: 'plaintext'})).secretStorage,
    ).toBe('plaintext');
  });

  it('refuses a value that is neither', () => {
    expect(
      mcpServerSchema.safeParse(stdio({secretStorage: 'readable'})).success,
    ).toBe(false);
  });
});

describe('mcpServersAreDistinct', () => {
  it('passes a list of distinct servers', () => {
    const [first, second] = [stdio(), http()].map((entry) =>
      mcpServerSchema.parse(entry),
    );
    expect(mcpServersAreDistinct([first!, second!])).toEqual([]);
  });

  it('reports a repeated name, because two servers would offer two tools with one name', () => {
    const servers = [
      mcpServerSchema.parse(stdio({id: 'mcp:a', name: 'notes'})),
      mcpServerSchema.parse(stdio({id: 'mcp:b', name: 'notes'})),
    ];
    const problems = mcpServersAreDistinct(servers);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('name');
    expect(problems[0]?.index).toBe(1);
    expect(problems[0]?.message).toMatch(/shadow/u);
  });

  it('reports a repeated id, because a delete would not know which one', () => {
    const servers = [
      mcpServerSchema.parse(stdio({id: 'mcp:same', name: 'one'})),
      mcpServerSchema.parse(stdio({id: 'mcp:same', name: 'two'})),
    ];
    const problems = mcpServersAreDistinct(servers);
    expect(problems.map((problem) => problem.field)).toEqual(['id']);
    expect(problems[0]?.message).toMatch(/which one was meant/u);
  });

  it('reports both problems at once rather than one per save', () => {
    const servers = [
      mcpServerSchema.parse(stdio({id: 'x', name: 'same'})),
      mcpServerSchema.parse(stdio({id: 'x', name: 'same'})),
    ];
    expect(mcpServersAreDistinct(servers)).toHaveLength(2);
  });
});

describe('tool naming', () => {
  it('namespaces every tool under its server', () => {
    expect(mcpToolName('notes', 'search')).toBe('mcp_notes_search');
    expect(mcpToolPrefix('notes')).toBe('mcp_notes_');
  });

  it('folds the characters a function name cannot contain', () => {
    expect(mcpToolName('fs', 'read/file')).toBe('mcp_fs_read_file');
  });
});
