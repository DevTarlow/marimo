/**
 * The sentence under Electron's wrapper.
 *
 * Two prefixes stand between a rejection reaching the window and what somebody
 * can read: Electron's "Error invoking remote method '…':", and the `Error: `
 * that `new Error(...)` contributes when the handler throws. Both are
 * machinery — the message underneath is written for a person, and it is what
 * every banner, refusal and composer note draws.
 */
import {describe, expect, it} from 'vitest';

import {describe as read} from '../src/renderer/describe.js';

describe('describe', () => {
  it('reaches the sentence through both prefixes', () => {
    expect(
      read(
        new Error(
          "Error invoking remote method 'marimo:call': Error: DeepSeek needs " +
            'an API key. Add one in Settings.',
        ),
      ),
    ).toBe('DeepSeek needs an API key. Add one in Settings.');
  });

  it('strips the bare prefix a locally thrown error carries', () => {
    expect(read(new Error('Error: Not a folder: /tmp/x'))).toBe(
      'Not a folder: /tmp/x',
    );
  });

  it('leaves a message that never had a prefix alone', () => {
    expect(read(new Error('Unknown session: abc'))).toBe('Unknown session: abc');
  });

  it('does not reach into a sentence that merely mentions an error', () => {
    // Only the *start* of the message is machinery. A message that says
    // "Error: " somewhere in the middle is a sentence somebody wrote.
    expect(read(new Error('The file says Error: on line 4'))).toBe(
      'The file says Error: on line 4',
    );
  });

  it('takes whatever was thrown, not only an Error', () => {
    expect(read('plain string')).toBe('plain string');
  });
});
