/**
 * A small, dependency-free markdown reader for agent replies on the phone.
 *
 * It covers what agents actually write — headings, paragraphs, fenced code,
 * bullet and numbered lists, block quotes, tables, rules, and inline bold,
 * italic, code, strikethrough and links — and nothing else. Anything it does
 * not recognise stays as text, so a reply is never lost, only shown plainer.
 * The output is data; `app/Markdown.tsx` draws it.
 */

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }
  | { type: 'strike'; children: MarkdownInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MarkdownInline[] };

export interface MarkdownListItem {
  children: MarkdownInline[];
  /** `- [x]` / `- [ ]` task items. */
  checked?: boolean;
  /** Nested lists, one level of indentation each. */
  sublist?: Extract<MarkdownBlock, { type: 'list' }>;
}

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'quote'; blocks: MarkdownBlock[] }
  | { type: 'table'; header: MarkdownInline[][]; align: Array<'left' | 'center' | 'right' | undefined>; rows: MarkdownInline[][][] }
  | { type: 'rule' };

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** Links an agent may emit; anything else (javascript:, file:, data:) is shown as text. */
export function isSafeLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): 'left' | 'center' | 'right' | undefined {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return undefined;
}

/** Inline markdown to spans. Unclosed markers are left as the characters they were. */
export function parseInline(source: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };

  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);

    if (rest[0] === '\\' && rest.length > 1 && /[\\`*_{}[\]()#+\-.!|~>]/.test(rest[1])) {
      text += rest[1];
      index += 2;
      continue;
    }

    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      flush();
      out.push({ type: 'code', text: code[2].replace(/^ (.*) $/, '$1') });
      index += code[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      if (isSafeLink(link[2])) out.push({ type: 'link', href: link[2], children: parseInline(link[1]) });
      else out.push(...parseInline(link[1]));
      index += link[0].length;
      continue;
    }

    const autolink = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
    if (autolink) {
      flush();
      out.push({ type: 'link', href: autolink[1], children: [{ type: 'text', text: autolink[1] }] });
      index += autolink[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ type: 'strong', children: parseInline(strong[2]) });
      index += strong[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      flush();
      out.push({ type: 'strike', children: parseInline(strike[1]) });
      index += strike[0].length;
      continue;
    }

    // `_` emphasis only at a word boundary, so snake_case identifiers stay intact.
    const em = /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/.exec(rest) ?? (/[\w]$/.test(source.slice(0, index)) ? null : /^_(?=\S)([\s\S]*?\S)_(?![\w_])/.exec(rest));
    if (em) {
      flush();
      out.push({ type: 'em', children: parseInline(em[1]) });
      index += em[0].length;
      continue;
    }

    text += rest[0];
    index += 1;
  }
  flush();
  return out;
}

function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line);
  return (match?.[1] ?? '').replace(/\t/g, '    ').length;
}

function parseList(lines: string[], start: number): { block: Extract<MarkdownBlock, { type: 'list' }>; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const baseIndent = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const block: Extract<MarkdownBlock, { type: 'list' }> = { type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
  let index = start;
  let current: { text: string; sub: string[] } | undefined;

  const finish = (): void => {
    if (!current) return;
    const task = TASK.exec(current.text);
    const item: MarkdownListItem = { children: parseInline(task ? task[2] : current.text) };
    if (task) item.checked = task[1].toLowerCase() === 'x';
    if (current.sub.length) {
      const nested = parseBlocks(current.sub.join('\n')).find((candidate): candidate is Extract<MarkdownBlock, { type: 'list' }> => candidate.type === 'list');
      if (nested) item.sublist = nested;
    }
    block.items.push(item);
    current = undefined;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const following = lines[index + 1];
      if (following !== undefined && (LIST_ITEM.test(following) && indentOf(following) >= baseIndent)) {
        index += 1;
        continue;
      }
      break;
    }
    const match = LIST_ITEM.exec(line);
    const indent = indentOf(line);
    if (match && indent <= baseIndent + 1 && /\d/.test(match[2]) === ordered) {
      finish();
      current = { text: match[3], sub: [] };
    } else if (match && indent > baseIndent + 1 && current) {
      current.sub.push(line.slice(Math.min(indent, baseIndent + 2)));
    } else if (match) {
      break; // A different kind of list starts here.
    } else if (current && indent > baseIndent) {
      if (current.sub.length) current.sub.push(line.slice(Math.min(indent, baseIndent + 2)));
      else current.text += ` ${line.trim()}`;
    } else if (current && !HEADING.test(line) && !FENCE_OPEN.test(line) && !QUOTE.test(line)) {
      current.text += ` ${line.trim()}`; // A lazy continuation line.
    } else {
      break;
    }
    index += 1;
  }
  finish();
  return { block, next: index };
}

/** Block-level markdown to blocks. */
export function parseBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[2];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // The closing fence (or the end of an unclosed one, while streaming).
      blocks.push({ type: 'code', ...(fence[3] ? { language: fence[3] } : {}), text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (RULE.test(line) && !(paragraph.length && /^\s*-+\s*$/.test(line))) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && lines[index].trim() && QUOTE.test(lines[index])) {
        quoted.push(QUOTE.exec(lines[index])![1]);
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted.join('\n')) });
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      const header = splitRow(line);
      const divider = splitRow(lines[index + 1]);
      if (divider.length === header.length || divider.length > 0) {
        flushParagraph();
        index += 2;
        const rows: MarkdownInline[][][] = [];
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
          const cells = splitRow(lines[index]);
          rows.push(header.map((_, column) => parseInline(cells[column] ?? '')));
          index += 1;
        }
        blocks.push({ type: 'table', header: header.map(cell => parseInline(cell)), align: header.map((_, column) => alignOf(divider[column] ?? '')), rows });
        continue;
      }
    }

    if (LIST_ITEM.test(line) && (!paragraph.length || indentOf(line) === 0)) {
      flushParagraph();
      const { block, next } = parseList(lines, index);
      blocks.push(block);
      index = next;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/** The plain text of inline spans — for accessibility labels and copy. */
export function inlineText(spans: readonly MarkdownInline[]): string {
  return spans.map(span => (span.type === 'text' || span.type === 'code' ? span.text : inlineText(span.children))).join('');
}
