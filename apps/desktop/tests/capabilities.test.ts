/**
 * Which card the simple screen lights up.
 *
 * The one thing that must not happen is two cards lit at once, or none with the
 * grant they describe: the screen would be telling the user their agent can do
 * something the profile does not allow, and every later answer would be read
 * against it. So the comparison is tested on its own, including the case that
 * saves it — a grant of the right *size* holding the wrong names.
 */
import {describe, expect, it} from 'vitest';

import type {CapabilityPreset} from '@marimo/protocol';

import {chosenPreset} from '../src/renderer/capabilities.js';

const PRESETS: CapabilityPreset[] = [
  {
    id: 'chat',
    label: 'Just chat',
    blurb: 'It answers questions.',
    tools: ['current_time', 'read_memory'],
    recommended: false,
  },
  {
    id: 'assistant',
    label: 'Help around my computer',
    blurb: 'It can read your files.',
    tools: ['current_time', 'read_memory', 'read_file'],
    recommended: true,
  },
];

describe('chosenPreset', () => {
  it('finds the card a grant came from, whatever order it is in', () => {
    expect(chosenPreset(PRESETS, ['read_memory', 'current_time'])?.id).toBe(
      'chat',
    );
    expect(
      chosenPreset(PRESETS, ['read_file', 'current_time', 'read_memory'])?.id,
    ).toBe('assistant');
  });

  it('reports nothing chosen for a grant somebody assembled', () => {
    expect(chosenPreset(PRESETS, ['read_file'])).toBeUndefined();
    expect(chosenPreset(PRESETS, [])).toBeUndefined();
  });

  /*
   * The case a size comparison alone gets wrong, and the reason this is a
   * function rather than four lines in a component: a profile granted the same
   * *number* of tools as a preset, none of which are that preset's. It must not
   * light the card up — the card is a claim about what the agent can do.
   */
  it('does not match a preset by count alone', () => {
    expect(chosenPreset(PRESETS, ['run_shell', 'write_file'])).toBeUndefined();
    expect(
      chosenPreset(PRESETS, ['current_time', 'write_file']),
    ).toBeUndefined();
  });

  /*
   * A name from a build this one has never heard of counts as part of the grant,
   * so the set is not equal and no card is lit. That is the honest reading: the
   * profile allows something none of the cards describe.
   */
  it('does not match a grant carrying a name it does not know', () => {
    expect(
      chosenPreset(PRESETS, ['current_time', 'read_memory', 'from_the_future']),
    ).toBeUndefined();
  });
});
