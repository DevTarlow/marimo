/**
 * A small Markdown parser, in two passes.
 *
 * **It produces data, not HTML.** An assistant's answer is untrusted input — it
 * can contain anything a web page can, because it may be quoting one — so the
 * renderer must escape it by construction rather than by a sanitiser somebody
 * has to configure correctly. Producing an AST and turning it into React
 * elements means the only thing that can become markup is a construct this file
 * names, and every piece of text goes through React's own escaping.
 *
 * A full CommonMark implementation this is not. It handles what an assistant
 * actually writes — prose, headings, lists, fenced code, inline code, emphasis,
 * links — and **degrades to literal text** for everything else. That direction
 * matters: an unhandled construct shows up as the characters the model typed,
 * which is legible, rather than as mangled formatting or as nothing.
 */
import type {JSX} from 'react';
import {createElement, Fragment} from 'react';

/** One block of a document. */
export type Block =
  | {kind: 'paragraph'; text: string}
  | {kind: 'heading'; level: number; text: string}
  | {kind: 'code'; language: string; text: string}
  | {kind: 'list'; ordered: boolean; start: number; items: string[]}
  | {kind: 'quote'; text: string}
  | {kind: 'rule'};

/** One piece of a line. */
export type Inline =
  | {kind: 'text'; text: string}
  | {kind: 'code'; text: string}
  | {kind: 'strong'; text: string}
  | {kind: 'em'; text: string}
  | {kind: 'link'; href: string; text: string};

const FENCE = /^\s{0,3}(?:```|~~~)\s*([\w+#-]*)\s*$/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u;
const BULLET = /^(\s*)[-*+]\s+(.*)$/u;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      /*
       * Everything to the closing fence is code, including lines that look like
       * markdown. An unterminated fence takes the rest of the answer, which is
       * what a streaming reply looks like — the closing fence has not arrived
       * yet — and treating that as prose would reformat the code as it streams.
       */
      const body: string[] = [];
      index += 1;
      while (index < lines.length && FENCE.exec(lines[index] ?? '') === null) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      // Past the closing fence, when there was one.
      index += 1;
      blocks.push({
        kind: 'code',
        language: fence[1] ?? '',
        text: body.join('\n'),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        text: heading[2] ?? '',
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({kind: 'rule'});
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const body: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (match === null) {
          break;
        }
        body.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({kind: 'quote', text: body.join('\n')});
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet !== null || numbered !== null) {
      const ordered = bullet === null;
      const start = ordered ? Number.parseInt(numbered?.[2] ?? '1', 10) : 1;
      const items: string[] = [];

      while (index < lines.length) {
        const current = lines[index] ?? '';
        const asBullet = BULLET.exec(current);
        const asNumber = NUMBERED.exec(current);

        // The same list, or a continuation of the item above it. A line that is
        // neither ends the list.
        if (asBullet !== null && !ordered) {
          items.push(asBullet[2] ?? '');
          index += 1;
          continue;
        }
        if (asNumber !== null && ordered) {
          items.push(asNumber[3] ?? '');
          index += 1;
          continue;
        }
        if (
          current.trim().length > 0 &&
          !HEADING.test(current) &&
          !RULE.test(current) &&
          items.length > 0
        ) {
          // A wrapped line: appended to the item it belongs to, because a list
          // item long enough to wrap is the common case in an answer.
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }

      blocks.push({kind: 'list', ordered, start, items});
      continue;
    }

    // A paragraph: consecutive lines until a blank one or something block-level.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim().length === 0 ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({kind: 'paragraph', text: paragraph.join('\n')});
  }

  return blocks;
}

/**
 * Splits a line into text and the constructs inside it.
 *
 * One pass rather than regex replacement, so a construct cannot be re-read as
 * another: code spans are taken first and their contents are never examined
 * again, which is why `` `**not bold**` `` stays as it was typed.
 */
export function parseInline(source: string): Inline[] {
  const parts: Inline[] = [];
  let text = '';
  let index = 0;

  const flush = (): void => {
    if (text.length > 0) {
      parts.push({kind: 'text', text});
      text = '';
    }
  };

  while (index < source.length) {
    const rest = source.slice(index);

    const code = /^`([^`]+)`/u.exec(rest);
    if (code !== null) {
      flush();
      parts.push({kind: 'code', text: code[1] ?? ''});
      index += code[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/u.exec(rest);
    if (strong !== null) {
      flush();
      parts.push({kind: 'strong', text: strong[2] ?? ''});
      index += strong[0].length;
      continue;
    }

    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1/u.exec(rest);
    if (em !== null) {
      flush();
      parts.push({kind: 'em', text: em[2] ?? ''});
      index += em[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/u.exec(rest);
    if (link !== null) {
      flush();
      parts.push({kind: 'link', href: link[2] ?? '', text: link[1] ?? ''});
      index += link[0].length;
      continue;
    }

    text += source[index];
    index += 1;
  }

  flush();
  return parts;
}

/**
 * Whether a link is safe to make clickable.
 *
 * The one place in this file where a construct could be dangerous rather than
 * merely ugly. `javascript:` and `data:` in an anchor are the classic way an
 * untrusted string becomes code, and an answer can contain either because it may
 * be quoting a page that does.
 *
 * Anything not on this list is still shown — as the text the model wrote, not as
 * a link. Refusing to *render* it and refusing to *show* it are different, and
 * the second would leave the user unable to see what they were being sent.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) {
    return true;
  }
  // A relative link is resolved against the app's own origin, which is a
  // privileged one; only the schemes below are allowed through.
  return /^(https?:|mailto:)/iu.test(trimmed);
}

/** Renders parsed inline content. Text becomes a React text node, so it escapes. */
export function renderInline(parts: readonly Inline[]): JSX.Element[] {
  return parts.map((part, position) => {
    switch (part.kind) {
      case 'code':
        return createElement('code', {key: position, className: 'md-code'}, part.text);
      case 'strong':
        return createElement('strong', {key: position}, part.text);
      case 'em':
        return createElement('em', {key: position}, part.text);
      case 'link':
        return isSafeHref(part.href)
          ? createElement(
              'a',
              {
                key: position,
                href: part.href,
                // Opened by the main process in the real browser, so a link in
                // an answer cannot navigate the app's own window.
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              part.text,
            )
          : // Shown, not hidden: the user should see what they were sent.
            createElement('span', {key: position}, `${part.text} (${part.href})`);
      default:
        return createElement(Fragment, {key: position}, part.text);
    }
  });
}
