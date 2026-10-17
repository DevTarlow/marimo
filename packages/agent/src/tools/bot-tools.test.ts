/**
 * `draft_bot`, the proposal that becomes a review card.
 *
 * The test is mostly about what it does *not* do: it never creates a profile, it
 * never throws, and it answers an unknown starter role with the list of real
 * ones. The card in the window is the only creation path, so a tool that quietly
 * made a bot would be a second one.
 */
import type {BaseTool, Context} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {createDraftBotTool} from './bot-tools.js';

async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: {sessionId: 'session-1'} as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('draft_bot', () => {
  it('shows a draft and says the person decides', async () => {
    const result = await run(createDraftBotTool(), {
      name: 'Writer',
      templateId: 'writer',
      persona: 'Dry and precise.',
    });
    expect(result).toContain('Writer');
    expect(result).toContain('press Create');
    expect(result).toContain('do not create');
  });

  it('accepts a custom bot with no starter role', async () => {
    const result = await run(createDraftBotTool(), {
      name: 'Tax helper',
      persona: 'You know the deductions.',
    });
    expect(result).toContain('Tax helper');
  });

  /*
   * An unknown id is a sentence rather than an exception: the model can pick one
   * of the real ones and carry on, where a throw would end the user's turn.
   */
  it('answers an unknown starter role with the names that exist', async () => {
    const result = await run(createDraftBotTool(), {
      name: 'Writer',
      templateId: 'novelist',
    });
    expect(result).toContain('writer');
    expect(result).toContain('templateId');
  });

  /*
   * A draft with no name is still a draft: the card shows "Untitled bot" and the
   * person can type one. The schema does not require it, because the model may
   * have started the conversation and not yet asked.
   */
  it('shows a nameless draft without throwing', async () => {
    const result = await run(createDraftBotTool(), {
      templateId: 'writer',
      persona: 'Dry and precise.',
    });
    expect(result).toContain('this bot');
  });
});
