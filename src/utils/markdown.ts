/**
 * @fileoverview Markdown escaping and link-destination validation for the
 * `content[]` render boundary.
 *
 * Leaf module by design, importing nothing of the server's: the tool test
 * suites replace `@/services/met/met-service.js` wholesale, so a helper
 * co-located there would be `undefined` inside every `format()` under test.
 *
 * @module utils/markdown
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * Whitespace a CommonMark paragraph or GFM table cell trims from a line's
 * edges, which `escapeMarkdownInline` writes as numeric references: every
 * whitespace character but U+000B, which it leaves literal.
 */
const isEdgeWhitespace = (ch: string) => ch !== '\v' && /\s/.test(ch);

/**
 * One line (no line break) escaped as `escapeMarkdownInline` escapes it, one
 * whitespace-free run at a time. Each run is escaped beside the whitespace
 * character that touches it on either side, so its neighbour, line-end, and
 * closing-`#` rules see what they see in the whole line: a run past the
 * line's first is framed by a letter and that character, which keeps it off
 * the line start, and a neighbour at the line's edge is the reference the
 * whole line writes. Interior whitespace stays as written, as it does there.
 */
function escapeLine(line: string): string {
  let start = 0;
  while (start < line.length && isEdgeWhitespace(line.charAt(start))) start++;
  if (start === line.length) return escapeMarkdownInline(line);
  let end = line.length;
  while (isEdgeWhitespace(line.charAt(end - 1))) end--;
  const lead = line.slice(0, start);
  const trail = line.slice(end);
  const core = line.slice(start, end);
  let escaped = '';
  let space = ''; // the whitespace before the current run
  let at = 0; // the current run's offset in `core`
  // Even indices: whitespace-free runs (only the first and last can be empty); odd: whitespace.
  for (const [i, run] of core.split(/(\s+)/).entries()) {
    if (i % 2 === 1) space = run;
    if (i % 2 === 1 || run === '') {
      escaped += run;
      at += run.length;
      continue;
    }
    const before = i > 0 ? `x${space.slice(-1)}` : lead.slice(-1);
    const after = core.charAt(at + run.length) || trail.charAt(0);
    const framed = escapeMarkdownInline(before + run + after);
    const head = i > 0 ? before.length : escapeMarkdownInline(before).length;
    escaped += framed.slice(head, framed.length - escapeMarkdownInline(after).length);
    at += run.length;
  }
  return escapeMarkdownInline(lead) + escaped + escapeMarkdownInline(trail);
}

/**
 * `escapeMarkdownInline` in linear time on any input, for caller text that
 * has no length bound: the same escapes, and the same guarantee that a
 * CommonMark parse reads the result back as `text` in the slots that function
 * names. One difference in bytes, none in what reads back: a run that opens a
 * line is tested for a block marker on its own, so `--- x` gains a backslash
 * the whole line would not need. Exists until cyanheads/mcp-ts-core#809 ships.
 */
export function escapeMarkdownInlineLinear(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A line break is a hard break, so the value stays one paragraph; a final one, where none can stand, is `&#10;`.
  return lines
    .map((line, i) =>
      i === 0
        ? escapeLine(line)
        : i === lines.length - 1 && line === ''
          ? '&#10;'
          : `\\\n${escapeLine(line)}`,
    )
    .join('');
}

/**
 * Every character that can open a Markdown construct in the positions this
 * server interpolates upstream text into. `\` leads so a single left-to-right
 * pass escapes it before it can be read as escaping something else.
 *
 * Deliberately excluded: `(` and `)` form a link destination only immediately
 * after an unescaped `]`, which this set already prevents — and parenthesized
 * metric conversions appear in nearly every `dimensions` and `period` value, so
 * escaping them would litter the most-rendered text to defend an unreachable
 * construct. `#`, `>`, `-`, `+`, `.`, `!`, `|`, `~` are block constructs needing
 * the start of a line, an image marker needing an unescaped `[`, or a table
 * delimiter; no value is interpolated line-leading once newlines are collapsed,
 * and no `format()` here renders a table.
 */
const MARKDOWN_METACHARACTERS = /[\\`*_[\]<]/g;

/** Any newline form, collapsed so no part of a value reaches a line start. */
const NEWLINES = /\r\n|[\r\n]/g;

/**
 * Escape upstream catalog text for interpolation into `content[]` Markdown.
 *
 * Call this only inside `format()`. `structuredContent` is a machine-readable
 * contract over the raw value — an escape character written there would corrupt
 * the machine surface to fix the human one. A value bound for a link destination
 * goes through {@link isHttpUrl} instead: a backslash inside a destination
 * breaks the link.
 *
 * @param value - Raw upstream text.
 * @returns The value with newlines collapsed to spaces and Markdown
 *   metacharacters backslash-escaped.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(NEWLINES, ' ').replace(MARKDOWN_METACHARACTERS, '\\$&');
}

/**
 * Whether an upstream value may be rendered as a Markdown link destination.
 *
 * The Met's URL-shaped fields are free catalog text that usually happens to hold
 * a URL, not identifiers: object `288322` carries the literal `(not assigned)`
 * in a constituent's `constituentULAN_URL`, which renders as a dead link when
 * trusted. A value shaped like `a) [go](https://evil.example` is worse — it
 * closes the server's own destination early and opens an attacker-controlled
 * one. Anything this rejects is prose, and belongs in {@link escapeMarkdown}.
 *
 * Only `http`/`https` pass. A value parsing under another scheme is still not a
 * link this server should write, so `javascript:` and friends are prose too.
 *
 * @param value - Raw upstream value from a URL-shaped field.
 * @returns True when the value parses as an absolute `http`/`https` URL.
 */
export function isHttpUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}
