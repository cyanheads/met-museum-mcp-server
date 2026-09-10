/**
 * @fileoverview Markdown escaping and link-destination validation for the
 * `content[]` render boundary.
 *
 * Dependency-free leaf module by design: the tool test suites replace
 * `@/services/met/met-service.js` wholesale, so a helper co-located there would
 * be `undefined` inside every `format()` under test.
 *
 * @module utils/markdown
 */

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
