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

/** Any newline form, collapsed so no part of a value reaches a line start. */
const NEWLINES = /\r\n|[\r\n]/g;

/**
 * Escape upstream catalog text for interpolation into `content[]` Markdown:
 * each line break collapses to a space, then the framework's
 * `escapeMarkdownInline` escapes the one remaining line, so a CommonMark parse
 * reads back the collapsed value exactly. That includes edge whitespace, which
 * it writes as `&#32;` (a trailing run of two spaces would otherwise end the
 * line in a hard break), and an entity-shaped `&` (`&amp;` reads back as typed,
 * not as `&`).
 *
 * Call this only inside `format()`. `structuredContent` is a machine-readable
 * contract over the raw value — an escape character written there would corrupt
 * the machine surface to fix the human one. A value bound for a link destination
 * goes through {@link isHttpUrl} instead: a backslash inside a destination
 * breaks the link. A value whose line breaks carry its meaning (`dimensions`)
 * goes through `escapeMarkdownInline` directly, which keeps each one as a hard
 * break; every other field collapses its breaks, since a hard break would end
 * the `##` title heading or split a `|`-joined line.
 *
 * @param value - Raw upstream text.
 * @returns The value on one line, escaped for inline Markdown.
 */
export function escapeMarkdown(value: string): string {
  return escapeMarkdownInline(value.replace(NEWLINES, ' '));
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
