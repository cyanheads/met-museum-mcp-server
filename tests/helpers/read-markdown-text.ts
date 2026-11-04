/**
 * @fileoverview Reads `content[]` Markdown back through a CommonMark parser
 * (`markdown-it`), so a test asserts the text a client renders rather than the
 * bytes written: a code span, a backslash escape, and a plain run that read the
 * same pass the same expectation.
 * @module tests/helpers/read-markdown-text
 */

import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('commonmark');

/** One inline token's contribution to the rendered text; markup tokens add none. */
function inlineText(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'text_special':
    case 'code_inline':
      return token.content;
    case 'softbreak':
    case 'hardbreak':
      return '\n';
    default:
      return '';
  }
}

/**
 * The text a CommonMark reader sees in `markdown`: each block's inline text,
 * code-span content verbatim, line breaks as `\n`, blocks joined by `\n`.
 * Emphasis, links, and other inline markup contribute only the text inside
 * them, so a value that rendered as live syntax reads back changed and fails a
 * plain-text expectation.
 */
export function readMarkdownText(markdown: string): string {
  return parser
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) => (token.children ?? []).map(inlineText).join(''))
    .join('\n');
}
