/**
 * The builder instruction.
 *
 * It is a prompt, so this test asserts the things a small model must not lose:
 * the question it already asked, the one-at-a-time rule, and the tool that ends
 * the interview. The code-level guarantees — the tool check and the review card
 * — are tested where they live.
 */
import {describe, expect, it} from 'vitest';

import {BOT_BUILDER_OPENING, DRAFT_BOT_TOOL} from '@marimo/protocol';

import {BOT_BUILDER_INSTRUCTION} from './bot-builder.js';

describe('the builder instruction', () => {
  it('quotes the opening question the window draws', () => {
    expect(BOT_BUILDER_INSTRUCTION).toContain(BOT_BUILDER_OPENING);
  });

  it('asks one question at a time', () => {
    expect(BOT_BUILDER_INSTRUCTION).toContain('Ask one question at a time');
  });

  it('ends the interview with the draft tool, and never creates directly', () => {
    expect(BOT_BUILDER_INSTRUCTION).toContain(DRAFT_BOT_TOOL);
    expect(BOT_BUILDER_INSTRUCTION).toContain('You do not create the bot');
    expect(BOT_BUILDER_INSTRUCTION).toContain('the card is the permission');
  });

  it('says what to do when the person stops', () => {
    expect(BOT_BUILDER_INSTRUCTION).toContain('make nothing');
  });
});
