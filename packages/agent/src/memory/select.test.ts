/**
 * Memory selection.
 *
 * The visible contract is the prompt text, so most of these assert on the exact
 * block a turn would carry rather than on counts alone — a count line that is
 * right about a block that is wrong is not much use. The two literals below are
 * the shapes everything else is a variation on.
 */
import {describe, expect, it} from 'vitest';

import {isAlwaysInjected} from './sections.js';
import {selectMemory, type RecalledBullet} from './select.js';

/** A file with an always section, a fact section and a title. */
const WHOLE_FILE = [
  '# Marimo memory',
  '',
  '## Preferences and tone',
  '- Prefers pnpm',
  '- Wants short answers',
  '',
  '## About the user',
  '- Has a dog called Sunshine',
  '- Lives in Berlin',
  '',
  '## Project pointers',
  '- marimo-agent keeps state in AGENTS.md',
  '',
].join('\n');

/** The two-section shape used for the exact-output assertions. */
const TWO_SECTIONS = [
  '## Preferences and tone',
  '- Prefers pnpm',
  '',
  '## About the user',
  '- Has a dog called Sunshine',
  '- Lives in Berlin',
  '',
].join('\n');

describe('selectMemory without retrieval', () => {
  /*
   * The whole point of the fallback: recall is an optimisation, and a turn that
   * could not run it must still carry every fact the user wrote. Anything shown
   * here other than the file itself is a smaller prompt won by a failure.
   */
  it('returns the whole file, trimmed, and says nothing about filtering', () => {
    const selection = selectMemory({
      memory: WHOLE_FILE,
      usedRetrieval: false,
      recalled: [{section: 'About the user', text: '- Lives in Berlin'}],
    });
    expect(selection).toEqual({
      text: WHOLE_FILE.trim(),
      usedRetrieval: false,
      total: 5,
      retrieved: 0,
    });
    expect(selection.text).not.toContain('Recalled');
    expect(selection.text).not.toContain('read_memory');
  });

  it('treats an absent usedRetrieval as the fallback too', () => {
    const selection = selectMemory({
      memory: TWO_SECTIONS,
      recalled: [{section: 'About the user', text: '- Lives in Berlin'}],
    });
    expect(selection.usedRetrieval).toBe(false);
    expect(selection.text).toBe(TWO_SECTIONS.trim());
  });

  it('counts the bullets in the file even though none were retrieved', () => {
    expect(selectMemory({memory: WHOLE_FILE}).total).toBe(5);
  });
});

describe('selectMemory with retrieval', () => {
  it('injects the always sections whole even when nothing was recalled', () => {
    const selection = selectMemory({
      memory: WHOLE_FILE,
      usedRetrieval: true,
      recalled: [],
    });
    expect(selection.text).toContain(
      '## Preferences and tone\n- Prefers pnpm\n- Wants short answers',
    );
    // The fact sections are what retrieval exists to leave out.
    expect(selection.text).not.toContain('Sunshine');
    expect(selection.text).not.toContain('AGENTS.md');
    expect(selection.retrieved).toBe(0);
  });

  it('carries the title the user wrote above the first heading', () => {
    expect(
      selectMemory({memory: WHOLE_FILE, usedRetrieval: true}).text,
    ).toContain('# Marimo memory');
  });

  it('injects a section nobody named whole, because the user wrote it', () => {
    const memory = [
      '## Deployment folklore',
      '- The staging box needs a VPN',
      '- Prod is read-only on Fridays',
      '',
    ].join('\n');
    const selection = selectMemory({memory, usedRetrieval: true, recalled: []});
    expect(selection.text).toContain(
      '## Deployment folklore\n' +
        '- The staging box needs a VPN\n' +
        '- Prod is read-only on Fridays',
    );
    expect(selection.total).toBe(2);
    expect(selection.retrieved).toBe(0);
  });

  it('keeps the injected sections in file order', () => {
    const memory = [
      '## Boundaries',
      '- Never push',
      '',
      '## Preferences and tone',
      '- Prefers pnpm',
      '',
    ].join('\n');
    const text = selectMemory({memory, usedRetrieval: true}).text;
    expect(text.indexOf('## Boundaries')).toBeLessThan(
      text.indexOf('## Preferences and tone'),
    );
  });

  /*
   * The exact literal, so a change to the wording of the block is a test
   * failure rather than something a reviewer has to notice.
   */
  it('renders the two-section example exactly', () => {
    const selection = selectMemory({
      memory: TWO_SECTIONS,
      usedRetrieval: true,
      recalled: [{section: 'About the user', text: '- Lives in Berlin'}],
    });
    expect(selection).toEqual({
      text: [
        '## Preferences and tone',
        '- Prefers pnpm',
        '',
        '## Recalled for this question (1 of 3 bullets; 2 not shown)',
        '',
        '- Lives in Berlin',
        '',
        'To see the rest: read_memory returns the whole file, and recall with ' +
          'scope "memory" searches it.',
      ].join('\n'),
      usedRetrieval: true,
      total: 3,
      retrieved: 1,
    });
  });

  it('shows a recalled bullet once and never repeats an always section', () => {
    const selection = selectMemory({
      memory: TWO_SECTIONS,
      usedRetrieval: true,
      recalled: [
        {section: 'Preferences and tone', text: '- Prefers pnpm'},
        {section: 'About the user', text: '- Has a dog called Sunshine'},
        {section: 'About the user', text: '- Lives in Berlin'},
      ],
    });
    expect(selection.text.match(/- Prefers pnpm/gu)).toHaveLength(1);
    expect(selection.text.match(/Sunshine/gu)).toHaveLength(1);
    expect(selection.text.match(/Lives in Berlin/gu)).toHaveLength(1);
    // Only the two bullets the always section did not already carry are
    // retrieved, and the deduplicated one is not counted twice.
    expect(selection.retrieved).toBe(2);
    expect(selection.total).toBe(3);
  });

  it('does not repeat a bullet from a hand-written section', () => {
    const memory = [
      '## Deployment folklore',
      '- The staging box needs a VPN',
      '',
    ].join('\n');
    const selection = selectMemory({
      memory,
      usedRetrieval: true,
      recalled: [
        {section: 'Deployment folklore', text: '- The staging box needs a VPN'},
      ],
    });
    expect(selection.text.match(/staging box/gu)).toHaveLength(1);
    expect(selection.retrieved).toBe(0);
  });

  it('renders a bullet once even if the rank list repeats it', () => {
    const memory = '## Notes\n- Alpha\n';
    const selection = selectMemory({
      memory,
      usedRetrieval: true,
      recalled: [
        {section: 'Notes', text: '- Alpha'},
        {section: 'Notes', text: '- alpha'},
      ],
    });
    expect(selection.text.match(/- Alpha/gu)).toHaveLength(1);
    expect(selection.retrieved).toBe(1);
  });

  it('states how many bullets were shown and how many were not', () => {
    const selection = selectMemory({
      memory: WHOLE_FILE,
      usedRetrieval: true,
      recalled: [
        {section: 'About the user', text: '- Lives in Berlin'},
        {
          section: 'Project pointers',
          text: '- marimo-agent keeps state in AGENTS.md',
        },
      ],
    });
    expect(selection.total).toBe(5);
    expect(selection.retrieved).toBe(2);
    expect(selection.text).toContain(
      '## Recalled for this question (2 of 5 bullets; 3 not shown)',
    );
  });

  it('says the file was filtered even when nothing was recalled', () => {
    const text = selectMemory({
      memory: WHOLE_FILE,
      usedRetrieval: true,
      recalled: [],
    }).text;
    expect(text).toContain(
      '## Recalled for this question (0 of 5 bullets; 5 not shown)',
    );
    expect(text).toContain('recall with scope "memory"');
  });
});

describe('selectMemory and the length budget', () => {
  const MEMORY = ['## About the user', '- One', '- Two', '- Three', ''].join(
    '\n',
  );
  const RECALLED = [
    {section: 'About the user', text: '- One'},
    {section: 'About the user', text: '- Two'},
    {section: 'About the user', text: '- Three'},
  ];

  it('drops from the bottom and says how many were dropped', () => {
    // `- One` and `- Two` and their newline come to 11 characters; `- Three`
    // does not fit after them.
    const selection = selectMemory({
      memory: MEMORY,
      usedRetrieval: true,
      recalled: RECALLED,
      maxChars: 11,
    });
    expect(selection.text).toContain('- One\n- Two');
    expect(selection.text).not.toContain('- Three');
    expect(selection.retrieved).toBe(2);
    expect(selection.text).toContain(
      '## Recalled for this question (2 of 3 bullets; 1 not shown, 1 of them ' +
        'for length)',
    );
  });

  it('keeps everything when the budget is not reached', () => {
    const selection = selectMemory({
      memory: MEMORY,
      usedRetrieval: true,
      recalled: RECALLED,
      maxChars: 4096,
    });
    expect(selection.retrieved).toBe(3);
    expect(selection.text).toContain('- One\n- Two\n- Three');
    expect(selection.text).not.toContain('for length');
  });

  it('does not spend the budget on the sections injected whole', () => {
    const memory = [
      '## Boundaries',
      '- Never push',
      '',
      '## About the user',
      '- Lives in Berlin',
      '',
    ].join('\n');
    const selection = selectMemory({
      memory,
      usedRetrieval: true,
      recalled: [{section: 'About the user', text: '- Lives in Berlin'}],
      maxChars: 5,
    });
    expect(selection.text).toContain('## Boundaries\n- Never push');
    expect(selection.retrieved).toBe(0);
    expect(selection.text).toContain('for length');
  });

  it('applies a default budget to a recalled half that is too large', () => {
    const bullet = `- ${'x'.repeat(5000)}`;
    const selection = selectMemory({
      memory: `## Notes\n${bullet}\n`,
      usedRetrieval: true,
      recalled: [{section: 'Notes', text: bullet}],
    });
    expect(selection.retrieved).toBe(0);
    expect(selection.text).toContain(
      '## Recalled for this question (0 of 1 bullets; 1 not shown, 1 of them ' +
        'for length)',
    );
  });
});

describe('selectMemory against a stale rank list', () => {
  it('does not render a recalled bullet the file no longer has', () => {
    const selection = selectMemory({
      memory: '## About the user\n- Lives in Berlin\n',
      usedRetrieval: true,
      recalled: [
        {section: 'About the user', text: '- Has a dog called Sunshine'},
        {section: 'About the user', text: '- Lives in Berlin'},
      ],
    });
    expect(selection.text).not.toContain('Sunshine');
    expect(selection.retrieved).toBe(1);
    expect(selection.total).toBe(1);
  });

  it('does not render a bullet whose section the file no longer has', () => {
    const selection = selectMemory({
      memory: '## Notes\n- Alpha\n',
      usedRetrieval: true,
      recalled: [{section: 'About the user', text: '- Alpha'}],
    });
    expect(selection.text).not.toContain('Alpha');
    expect(selection.retrieved).toBe(0);
  });

  it('matches a recalled bullet case-insensitively and renders the file wording', () => {
    const selection = selectMemory({
      memory: '## About the user\n- Lives in Berlin\n',
      usedRetrieval: true,
      recalled: [{section: 'ABOUT   THE  USER', text: 'lives   in berlin'}],
    });
    expect(selection.text).toContain('- Lives in Berlin');
    expect(selection.retrieved).toBe(1);
  });
});

describe('selectMemory edge cases', () => {
  it('returns nothing for an empty file, hits or not', () => {
    expect(
      selectMemory({
        memory: '',
        usedRetrieval: true,
        recalled: [{section: 'Notes', text: '- anything'}],
      }),
    ).toEqual({text: '', usedRetrieval: true, total: 0, retrieved: 0});
    expect(
      selectMemory({memory: '', recalled: [{section: 'Notes', text: '- x'}]}),
    ).toEqual({text: '', usedRetrieval: false, total: 0, retrieved: 0});
  });

  it('returns nothing for a file that is only whitespace', () => {
    expect(selectMemory({memory: '   \n\n', usedRetrieval: true}).text).toBe(
      '',
    );
  });

  it('keeps a title the file has but no bullets under', () => {
    const selection = selectMemory({
      memory: '# Marimo memory\n',
      usedRetrieval: true,
    });
    expect(selection.text).toBe('# Marimo memory');
    expect(selection.total).toBe(0);
  });

  it('never throws on a recalled entry with nothing in it', () => {
    const selection = selectMemory({
      memory: '## Notes\n- Alpha\n',
      usedRetrieval: true,
      recalled: [
        {section: 'Notes', text: '   '},
        {section: 'Notes', text: ''},
      ],
    });
    expect(selection.retrieved).toBe(0);
    expect(selection.total).toBe(1);
  });

  /*
   * The contract says never throw, so the guard is against a caller that reached
   * this through untyped JavaScript, not against a misuse TypeScript allows.
   */
  it('never throws on a rank list that is not a list', () => {
    const selection = selectMemory({
      memory: '## Notes\n- Alpha\n',
      usedRetrieval: true,
      recalled: 'not a list' as unknown as readonly RecalledBullet[],
    });
    expect(selection.retrieved).toBe(0);
    expect(selection.total).toBe(1);
  });
});

describe('isAlwaysInjected', () => {
  it('injects the rule sections and leaves the fact sections to retrieval', () => {
    expect(isAlwaysInjected('Preferences and tone')).toBe(true);
    expect(isAlwaysInjected('Environment and conventions')).toBe(true);
    expect(isAlwaysInjected('Boundaries')).toBe(true);
    expect(isAlwaysInjected('About the user')).toBe(false);
    expect(isAlwaysInjected('Project pointers')).toBe(false);
    expect(isAlwaysInjected('Notes')).toBe(false);
  });

  it('ignores case and stray whitespace in the heading', () => {
    expect(isAlwaysInjected('  boundaries  ')).toBe(true);
    expect(isAlwaysInjected('ABOUT   THE USER')).toBe(false);
  });

  /*
   * The rule that keeps memory.md hand-editable: a heading the app never chose
   * is one the user typed, and retrieval has no mandate to filter it.
   */
  it('injects any heading the app never named', () => {
    expect(isAlwaysInjected('Deployment folklore')).toBe(true);
    expect(isAlwaysInjected('')).toBe(true);
  });
});
