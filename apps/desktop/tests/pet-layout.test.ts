/**
 * The order of the three things in the companion window.
 *
 * Answers, then the moss, then the bar — and this exists because the *brief* is
 * exactly that and the failure is silent: every other test in this app passes
 * with the bar back above the moss, and the only symptom is a bar sitting
 * between the user and the answer they are waiting for.
 *
 * Asserted against the rendered source rather than a rendered DOM, like
 * `preload-channels.test.ts` and for the same reason: this package has no DOM
 * test environment, and the thing being protected is the structure of one
 * function. A jsdom dependency for a single order check would be a second
 * renderer to keep in step with the first.
 */
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pet = join(appRoot, 'src', 'renderer', 'Pet.tsx');

describe('the companion window', () => {
  it('draws the conversation above the moss and the bar below it', async () => {
    const source = await readFile(pet, 'utf8');

    /*
     * Matched on the opening tag of each of the three, in the return value.
     * `indexOf` on the whole file would find the class names in the stylesheet
     * comment at the top if they were ever mentioned there, so the last
     * occurrence of `<div className="pet">` anchors the search to the markup.
     */
    const markup = source.slice(source.lastIndexOf('<div className="pet">'));
    const column = markup.indexOf('<div className="pet-column"');
    const moss = markup.indexOf('<div className="pet-moss"');
    const bar = markup.indexOf('<div className="pet-bar"');

    expect(column).toBeGreaterThanOrEqual(0);
    expect(moss).toBeGreaterThan(column);
    expect(bar).toBeGreaterThan(moss);
  });

  it('asks as the pet rather than as the window', async () => {
    const source = await readFile(pet, 'utf8');

    /*
     * The whole of the answer-length setting rests on this one field: without
     * it the turn looks like any other and the agent answers at the window's
     * length, which is a setting that appears to do nothing.
     */
    expect(source).toContain("origin: 'pet'");
  });

  it('leads the bar with a new-chat button, and refuses it mid-turn', async () => {
    const source = await readFile(pet, 'utf8');
    const bar = source.slice(source.lastIndexOf('<div className="pet-bar">'));

    const button = bar.indexOf('className="pet-new"');
    const input = bar.indexOf('className="pet-input"');
    expect(button).toBeGreaterThanOrEqual(0);
    // Leading edge: the user asked for the left of the input, and a control that
    // ended up on the right is the send button twice.
    expect(input).toBeGreaterThan(button);
    expect(bar.slice(button, input)).toContain('agent.newSession');

    /*
     * Disabled during a turn, which the window's own New button is not. This
     * window shows the newest few bubbles and nothing else, so switching away
     * mid-turn would hide the answer being written with nothing on screen to say
     * where it went — the state this asserts against is a half-written answer
     * vanishing behind a button the user just pressed.
     */
    expect(bar.slice(button, input)).toContain('disabled={busy');
  });
});
