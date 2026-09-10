/**
 * @fileoverview Tests for the `content[]` render-boundary helpers — the escape
 * set, the characters deliberately left alone, the newline collapse, the
 * single-pass property, and the link-destination predicate.
 * @module tests/utils/markdown.test
 */

import { describe, expect, it } from 'vitest';
import { escapeMarkdown, isHttpUrl } from '@/utils/markdown.js';

describe('escapeMarkdown', () => {
  describe('escape set', () => {
    it.each([
      ['backslash', '\\', '\\\\'],
      ['backtick', '`', '\\`'],
      ['asterisk', '*', '\\*'],
      ['underscore', '_', '\\_'],
      ['open bracket', '[', '\\['],
      ['close bracket', ']', '\\]'],
      ['less-than', '<', '\\<'],
    ])('escapes %s', (_label, input, expected) => {
      expect(escapeMarkdown(input)).toBe(expected);
    });

    it('escapes every occurrence, not just the first', () => {
      expect(escapeMarkdown('a*b*c')).toBe('a\\*b\\*c');
    });

    it('neutralizes a complete link label — the pattern real Met titles carry', () => {
      expect(escapeMarkdown('[29 Glass Stereographs]')).toBe('\\[29 Glass Stereographs\\]');
    });

    it('neutralizes a raw HTML tag', () => {
      expect(escapeMarkdown('<script>alert(1)</script>')).toBe('\\<script>alert(1)\\</script>');
    });
  });

  describe('single left-to-right pass', () => {
    it('escapes an already-backslashed metacharacter exactly once each', () => {
      // A chained per-character replace would re-match the backslash it just
      // inserted and emit `\\\\*` — one pass over a character class cannot.
      expect(escapeMarkdown('\\*')).toBe('\\\\\\*');
    });

    it('does not re-escape the backslash it inserts before a bracket', () => {
      expect(escapeMarkdown('[')).toBe('\\[');
      expect(escapeMarkdown('\\[')).toBe('\\\\\\[');
    });
  });

  describe('characters deliberately left alone', () => {
    it.each([
      ['parenthesized metric conversion', '38.1 x 24.1 cm)'],
      ['balanced parentheses', 'Bodhisattvas of the Four Directions(?)'],
      ['ampersand', 'S & H'],
      ['hash', '# not a heading here'],
      ['blockquote marker', '> quoted'],
      ['list markers', '- item + item'],
      ['bang', '!important'],
      ['pipe', 'a | b'],
      ['tilde', '~approx'],
      ['greater-than', 'a > b'],
      ['em dash and slashes', '28 7/8 × 36 3/4 in. — framed'],
    ])('leaves %s verbatim', (_label, input) => {
      expect(escapeMarkdown(input)).toBe(input);
    });
  });

  describe('newline collapse', () => {
    it.each([
      ['LF', 'H. 51 in.\nDiam. 13 in.'],
      ['CRLF', 'H. 51 in.\r\nDiam. 13 in.'],
      ['CR', 'H. 51 in.\rDiam. 13 in.'],
    ])('collapses %s to a single space', (_label, input) => {
      expect(escapeMarkdown(input)).toBe('H. 51 in. Diam. 13 in.');
    });

    it('leaves no character at a line-leading position, so block constructs cannot form', () => {
      const escaped = escapeMarkdown('Overall\r\n# Detail\r\n- Mount');
      expect(escaped).not.toContain('\n');
      expect(escaped).not.toContain('\r');
      expect(escaped).toBe('Overall # Detail - Mount');
    });

    it('collapses a newline that sits between metacharacters without disturbing the escape', () => {
      expect(escapeMarkdown('a*\nb_')).toBe('a\\* b\\_');
    });
  });

  it('returns an empty string unchanged, so falsy placeholders still apply', () => {
    expect(escapeMarkdown('')).toBe('');
  });

  it('leaves the linter format-parity sentinel shape inert', () => {
    // The sentinel is alphanumeric by construction (core >= 0.11.4); escaping
    // must not alter it or every format-parity check would read as unrendered.
    expect(escapeMarkdown('MCPPARITYobjectsQQtitle')).toBe('MCPPARITYobjectsQQtitle');
  });
});

describe('isHttpUrl', () => {
  it.each([
    ['https', 'https://www.wikidata.org/wiki/Q5582'],
    ['http', 'http://vocab.getty.edu/page/ulan/500115588'],
    ['a query string and fragment', 'https://example.com/a?b=c#d'],
    ['an uppercase scheme', 'HTTPS://example.com/'],
  ])('accepts %s destination', (_label, input) => {
    expect(isHttpUrl(input)).toBe(true);
  });

  it.each([
    ['the empty string', ''],
    ['free catalog text — object 288322 sends this in a ULAN field', '(not assigned)'],
    ['a bare word', 'unknown'],
    ['whitespace', '   '],
    ['a scheme-relative reference', '//example.com/a'],
    ['a site-relative path', '/art/collection/search/288322'],
  ])('rejects %s', (_label, input) => {
    expect(isHttpUrl(input)).toBe(false);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html;base64,PHNjcmlwdD4='],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.invalid/q'],
  ])('rejects the %s scheme — it parses, but is not a link to write', (_label, input) => {
    expect(isHttpUrl(input)).toBe(false);
  });

  it('rejects a value that would close the link destination early', () => {
    // Trusted as a destination, this ends the server's own `[label](` and opens
    // an attacker-controlled link plus trailing emphasis.
    expect(isHttpUrl('a) [go](https://evil.example')).toBe(false);
  });

  it('rejects a complete link value, so a bare position cannot render a link', () => {
    expect(isHttpUrl('[Met](https://evil.example)')).toBe(false);
  });

  it('sends everything it rejects through the prose escaper intact', () => {
    // The two halves compose: whatever is not a destination is escaped text.
    const value = 'a) [go](https://evil.example';
    expect(isHttpUrl(value)).toBe(false);
    expect(escapeMarkdown(value)).toBe('a) \\[go\\](https://evil.example');
  });
});
