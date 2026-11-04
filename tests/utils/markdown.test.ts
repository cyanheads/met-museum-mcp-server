/**
 * @fileoverview Tests for the `content[]` render-boundary helpers — the escape
 * set, the characters deliberately left alone, the newline collapse, the
 * single-pass property, the linear-time inline escaper's equivalence,
 * read-back, and CPU bound, and the link-destination predicate.
 * @module tests/utils/markdown.test
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, escapeMarkdownInlineLinear, isHttpUrl } from '@/utils/markdown.js';
import { readMarkdownText } from '../helpers/read-markdown-text.js';

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

describe('escapeMarkdownInlineLinear', () => {
  it.each([
    ['an inequality', '<=50'],
    ['an ampersand inside a name', 'AT&T'],
    ['a trailing hash', 'C#'],
    ['a hash before a number', 'C# 12'],
    ['a lone mid-line hash', 'a # b'],
    ['an intraword underscore', 'snake_case'],
    ['a Windows path', 'C:\\Users\\x'],
    ['a hash run closing the line', 'abc #'],
    ['a two-hash run closing the line', 'abc ##'],
    ['a seven-hash run closing the line', 'abc #######'],
    ['a hash after a tab, mid-line and at the end', 'a #\tb #'],
    ['emphasis, raw HTML, and a list across a line break', 'A*p* <b>x</b>\n- y'],
    ['block markers mid-line', '5 > 3, a - b + c, step 1. then 2)'],
    ['edge and doubled whitespace', '  lead and  trail  '],
    ['a leading tab', '\tindented'],
    ['an indented second line', 'a\n  b'],
    ['a final line break', 'a\n'],
    ['CRLF and CR', 'a\r\nb\rc'],
    ['an entity and two autolinks', '&amp; <a@b.c> <https://x.io>'],
    ['backslashes before space, punctuation, and the end', 'x \\ y\\* z\\'],
    ['Unicode whitespace and an astral neighbour', 'a\u00a0b\u3000c 😀_x_😀'],
    ['a vertical tab at the edges', '\v a \v'],
    [
      'a zero-match notice quoting a Markdown-active keyword',
      'The keyword "zz \\"a\\" *b* [c](https://x.io) `d`" matches no object in the collection. Try a different, broader, or differently spelled keyword.',
    ],
    [
      'the department-filter notice',
      "The Met's search returns departments 7 (The Cloisters) and 17 (Medieval Art) as one combined result set: total counts matches in both. For exact department membership, use met_list_objects with departmentId 7.",
    ],
  ])('writes what escapeMarkdownInline writes for %s', (_label, text) => {
    expect(escapeMarkdownInlineLinear(text)).toBe(escapeMarkdownInline(text));
  });

  it.each([
    ['a dash run', '--- x'],
    ['an equals run', '=== x'],
    ['a hash before a no-break space', '#\u00a0x'],
  ])(
    'may escape %s opening a line that is no block marker, which reads back the same',
    (_label, text) => {
      expect(escapeMarkdownInline(text)).toBe(text);
      expect(escapeMarkdownInlineLinear(text)).toBe(`\\${text}`);
      expect(readMarkdownText(escapeMarkdownInlineLinear(text))).toBe(text);
    },
  );

  it('reads back every string of a seeded sweep over the escape triggers as written', () => {
    // Every character an escape rule tests, the whitespace kinds, and entity-shaped fragments.
    const alphabet = [
      ...'a1#-+=:.)>_\\<@&*|`[]~!( \t\n\r\vé😀',
      ...String.fromCharCode(0xa0, 0x3000), // a no-break space and an ideographic space
      '  ',
      '\r\n',
      'x;',
      '#1;',
      'amp;',
    ];
    let seed = 3;
    /** xorshift32: a fixed sequence, so a failure reproduces. */
    const next = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const mismatches: string[] = [];
    for (let k = 0; k < 3_000; k++) {
      let text = '';
      for (let length = 1 + next(16); length > 0; length--) text += alphabet[next(alphabet.length)];
      // A CommonMark parse reads CR and CRLF as LF.
      if (readMarkdownText(escapeMarkdownInlineLinear(text)) !== text.replace(/\r\n?/g, '\n')) {
        mismatches.push(text);
      }
    }
    expect(mismatches).toEqual([]);
  });

  describe('linear time', () => {
    /** The thread's own CPU time in ms, never wall clock, which counts other work. */
    const cpuMs = () => {
      const { user, system } = process.threadCpuUsage();
      return (user + system) / 1000;
    };
    /**
     * CPU per call: the least of three measurements (a GC pause only ever adds
     * time), each repeating the call until 2 ms have run, so a small input is
     * timed over a batch.
     */
    const perCallMs = (text: string) => {
      let least = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 3; round++) {
        const start = cpuMs();
        let calls = 0;
        let elapsed = 0;
        do {
          escapeMarkdownInlineLinear(text);
          calls++;
          elapsed = cpuMs() - start;
        } while (elapsed < 2);
        least = Math.min(least, elapsed / calls);
      }
      return least;
    };
    /** CPU allowed per call for each 1,000 characters, several times what one costs. */
    const MS_PER_THOUSAND_CHARS = 2;
    const SMALLEST = 5_000;

    it.each([
      ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`, 80_000],
      ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4), 320_000],
      ['two words', (n: number) => `a${' '.repeat(n)}b`, 320_000],
    ])('runs in linear time on %s', (_label, make, largest) => {
      let first = 0;
      let last = 0;
      for (let chars = SMALLEST; chars <= largest; chars *= 2) {
        last = perCallMs(make(chars));
        if (chars === SMALLEST) first = last;
        // Checked before the next doubling, so a super-linear escaper fails at the first size it outgrows.
        expect(last, `${chars} characters`).toBeLessThan(MS_PER_THOUSAND_CHARS * (chars / 1_000));
      }
      expect(last / first).toBeLessThan(4 * (largest / SMALLEST));
    });
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
