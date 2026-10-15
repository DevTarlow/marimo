/**
 * The two identity seeds.
 *
 * They are constants in the protocol because two places have to agree about
 * them: `ProfileStore` seeds a profile with one, and Reset in the window puts
 * the right one back. A renderer holding its own copy would reset an agent to
 * something the app never shipped, which looks like the button working.
 *
 * The rule about what a seed must *not* contain — the app's own method
 * vocabulary, which the operating protocol carries — is pinned in
 * `packages/agent/src/skills/skills.test.ts`, beside the code that appends it.
 * This file is about the two texts being different from each other in the way
 * the bots feature needs them to be.
 */
import {describe, expect, it} from 'vitest';

import {DEFAULT_AGENT_IDENTITY, botIdentityFor} from './index.js';

describe('the identity seeds', () => {
  it('names Marimo as the one the person talks to', () => {
    expect(DEFAULT_AGENT_IDENTITY).toContain('You are Marimo');
  });

  /*
   * The defect this pair exists for: a bot seeded with the lead's text
   * introduces itself as Marimo, which is the confusion the bots feature is
   * built so the person never sees.
   */
  it('has a bot name itself rather than introduce it as Marimo', () => {
    const text = botIdentityFor('Writer');
    expect(text).toContain('Writer');
    expect(text).not.toContain('You are Marimo');
  });

  /*
   * A name is user text, and a blank one is a field somebody cleared rather than
   * a bot with no name: the fallback keeps the first line a sentence instead of
   * "You are .".
   */
  it('falls back rather than opening on a blank name', () => {
    const text = botIdentityFor('   ');
    expect(text).not.toContain('You are .');
    expect(text.startsWith('You are this bot.')).toBe(true);
  });
});
