/**
 * The memory block for one turn.
 *
 * Memory begins as the whole file in the prompt: while the file is small, every
 * bullet in it is a fair candidate whatever was asked. That stops being true
 * once the file is large enough that most of it is irrelevant — a question about
 * a CSS bug does not need the user's dog, or the deploy quirk of a project
 * nobody has open — and retrieval is what narrows it.
 *
 * Two rules shape everything below. Retrieval may only narrow the prompt when it
 * worked: a recall that failed somewhere upstream falls back to the whole file,
 * because a smaller prompt produced by a broken step is a silent loss of facts
 * the user wrote down. And nothing the user typed by hand may disappear: a
 * heading the app never named is theirs, so it is injected whole rather than
 * filtered on the app's opinion of it.
 */
import {splitMemory} from './memory-store.js';
import {isAlwaysInjected} from './sections.js';

/**
 * How much of the recalled half is kept, in characters.
 *
 * A few dozen bullets: more than one question is likely to need, and small
 * enough that a bad rank order costs prompt space rather than the answer. The
 * sections injected whole are deliberately outside this, because a rule the user
 * wrote is not a budget item.
 */
const DEFAULT_MAX_CHARS = 4096;

/**
 * How to reach the bullets a narrowed prompt left out.
 *
 * Without this line the model reads the recalled block as everything memory
 * holds and answers as though a fact that did not rank were not known; with it,
 * the rest is one tool call away.
 */
const REST_HINT =
  'To see the rest: read_memory returns the whole file, and recall with scope ' +
  '"memory" searches it.';

export interface RecalledBullet {
  /** The `##` heading the bullet lives under. */
  section: string;
  /** The bullet's text, exactly as it appears in the file. */
  text: string;
}

export interface MemorySelection {
  /** The block to put in the prompt. */
  text: string;
  /** False means this is the whole file, as before. */
  usedRetrieval: boolean;
  /** Bullets in the file. */
  total: number;
  /** Bullets actually shown in the recalled block. */
  retrieved: number;
}

interface FileBullet {
  /** The bullet's text with its marker removed, spelled as the file spells it. */
  text: string;
  /** Lowercased and whitespace-collapsed, for matching. */
  key: string;
}

interface FileSection {
  /** Absent for the preamble before the first `##`. */
  heading?: string;
  /** Blank-edge-trimmed lines, kept for rendering the section whole. */
  lines: string[];
  bullets: FileBullet[];
}

/**
 * Chooses the block to inject, given the whole file and what was recalled.
 *
 * Pure and total: the caller has already read the file and run recall, so this
 * makes the decision the two of them imply and never throws doing it. A turn is
 * being assembled when this runs, and a memory problem must not be the thing
 * that ends it.
 */
export function selectMemory(options: {
  memory: string;
  recalled?: readonly RecalledBullet[];
  usedRetrieval?: boolean;
  maxChars?: number;
}): MemorySelection {
  const memory = typeof options.memory === 'string' ? options.memory : '';
  const sections = parseSections(memory);
  const total = sections.reduce(
    (sum, section) => sum + section.bullets.length,
    0,
  );

  /*
   * The fallback is the whole file, trimmed, which is exactly what `readForPrompt`
   * fed the prompt before retrieval existed. `usedRetrieval !== true` rather than
   * `=== false` so an absent flag is the safe reading: narrowing on a value
   * nobody set is the failure this branch exists to prevent.
   */
  if (options.usedRetrieval !== true) {
    return {text: memory.trim(), usedRetrieval: false, total, retrieved: 0};
  }

  /*
   * The whole-file half. `isAlwaysInjected` answers true for the always sections
   * and for every heading the app never named, so one call covers both kinds of
   * section that are injected whatever was asked, and a heading the user added by
   * hand is never filtered on the app's opinion of it.
   */
  const injected: FileSection[] = [];
  const shown = new Set<string>();
  for (const section of sections) {
    const heading = section.heading;
    if (heading !== undefined && !isAlwaysInjected(heading)) {
      continue;
    }
    injected.push(section);
    for (const bullet of section.bullets) {
      shown.add(bulletKey(sectionKey(section), bullet.key));
    }
  }
  const parts = injected
    .map(renderSection)
    .filter((part): part is string => part !== undefined);

  const byHeading = new Map<string, FileSection[]>();
  for (const section of sections) {
    const key = sectionKey(section);
    const existing = byHeading.get(key);
    if (existing === undefined) {
      byHeading.set(key, [section]);
    } else {
      // Duplicate headings are legal in a hand-edited file, so a recalled bullet
      // is looked for in all of them rather than the first.
      existing.push(section);
    }
  }

  const budget = options.maxChars ?? DEFAULT_MAX_CHARS;
  const lines: string[] = [];
  let used = 0;
  let droppedForLength = 0;

  /*
   * `Array.isArray` rather than `?? []`, because this function's contract is
   * that it never throws: a caller that reached it through untyped JavaScript
   * gets the fallback of nothing recalled rather than a TypeError out of the
   * loop.
   */
  const recalled = Array.isArray(options.recalled)
    ? options.recalled
    : ([] as readonly RecalledBullet[]);

  for (const entry of recalled) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    if (typeof entry.text !== 'string') {
      continue;
    }
    const wanted = collapse(markerless(entry.text));
    if (wanted.length === 0) {
      continue;
    }
    const section = collapse(
      typeof entry.section === 'string' ? entry.section : '',
    );
    const key = bulletKey(section, wanted);
    // Already visible in full above, or already rendered from an earlier rank.
    if (shown.has(key)) {
      continue;
    }

    /*
     * The rank list can outlive the file it was built from — a bullet the user
     * deleted, or an update that rewrote its section — and a stale hit must not
     * be rendered: the prompt would assert something memory no longer says. The
     * file's own spelling is what gets rendered, so the caller's copy cannot
     * reintroduce a wording the file has moved past.
     */
    const fileText = findBullet(byHeading.get(section), wanted);
    if (fileText === undefined) {
      continue;
    }

    // Recorded before the budget check, so a duplicate later in the list cannot
    // slip in after the first copy was dropped for length.
    shown.add(key);

    const line = `- ${fileText}`;
    const cost = used === 0 ? line.length : line.length + 1;
    if (used + cost > budget) {
      droppedForLength += 1;
      continue;
    }
    used += cost;
    lines.push(line);
  }

  const retrieved = lines.length;
  const hidden = total - retrieved;
  const count =
    droppedForLength === 0
      ? `## Recalled for this question (${retrieved} of ${total} bullets; ` +
        `${hidden} not shown)`
      : `## Recalled for this question (${retrieved} of ${total} bullets; ` +
        `${hidden} not shown, ${droppedForLength} of them for length)`;

  /*
   * The count line is emitted whenever the file has bullets at all, even when
   * nothing was recalled: "0 of 40" is the one thing that tells the model its
   * memory was filtered rather than empty. A file with no bullets gets no block,
   * because there is nothing to say and an empty file already has a block of its
   * own in the prompt.
   */
  if (total > 0) {
    const recalled =
      lines.length > 0
        ? `${count}\n\n${lines.join('\n')}\n\n${REST_HINT}`
        : `${count}\n\n${REST_HINT}`;
    parts.push(recalled);
  }

  return {
    text: parts.join('\n\n').trim(),
    usedRetrieval: true,
    total,
    retrieved,
  };
}

/** Splits the document the same way the store writes it, one block per `##`. */
function parseSections(memory: string): FileSection[] {
  return splitMemory(memory).map((block): FileSection => {
    const lines = trimmedLines(block.lines);
    return {
      ...(block.heading === undefined ? {} : {heading: block.heading}),
      lines,
      bullets: bulletsIn(lines),
    };
  });
}

/** A blank line is not a bullet, and neither is a bare marker. */
function bulletsIn(lines: readonly string[]): FileBullet[] {
  const bullets: FileBullet[] = [];
  for (const line of lines) {
    const match = /^\s*[-*]\s+(.*)$/u.exec(line);
    const text = (match?.[1] ?? '').trim();
    if (text.length > 0) {
      bullets.push({text, key: collapse(text)});
    }
  }
  return bullets;
}

function renderSection(section: FileSection): string | undefined {
  if (section.heading === undefined) {
    // The preamble is whatever the user put above the first heading — usually a
    // `#` title. It is their text, so it is carried rather than dropped.
    return section.lines.length > 0 ? section.lines.join('\n') : undefined;
  }
  return [`## ${section.heading}`, ...section.lines].join('\n');
}

function findBullet(
  sections: readonly FileSection[] | undefined,
  wanted: string,
): string | undefined {
  for (const section of sections ?? []) {
    const bullet = section.bullets.find(
      (candidate) => candidate.key === wanted,
    );
    if (bullet !== undefined) {
      return bullet.text;
    }
  }
  return undefined;
}

function sectionKey(section: FileSection): string {
  return section.heading === undefined ? '' : collapse(section.heading);
}

function bulletKey(section: string, text: string): string {
  return `${section}\u0000${text}`;
}

/** Strips a leading `-`/`*` marker so a caller may quote the file verbatim. */
function markerless(text: string): string {
  return text
    .trim()
    .replace(/^\s*[-*]\s+/u, '')
    .trim();
}

/**
 * Lowercased with every run of whitespace reduced to one space.
 *
 * Collapsed rather than merely trimmed on both sides of a match for the same
 * reason the store collapses when it removes a bullet: a model that re-typed a
 * line it read may have lost the original spacing, and that is not a different
 * fact.
 */
function collapse(text: string): string {
  return text.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
}

/** Trims blank edges so rendering adds no stray blank lines of its own. */
function trimmedLines(lines: readonly string[]): string[] {
  const text = lines.join('\n').trim();
  return text.length === 0 ? [] : text.split('\n');
}
