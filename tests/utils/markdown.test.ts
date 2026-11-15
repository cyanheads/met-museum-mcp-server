/**
 * @fileoverview Tests for the `content[]` render-boundary helpers — the
 * read-back of the one-line escaper every field but `dimensions` renders
 * through, its edge whitespace and entity-shaped `&`, the characters it leaves
 * alone, the newline collapse, the link-destination predicate — and for the
 * read-back and CPU bound of the framework's line-keeping escaper, which
 * renders caller text of any length.
 * @module tests/utils/markdown.test
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, isHttpUrl } from '@/utils/markdown.js';
import { readMarkdownText } from '../helpers/read-markdown-text.js';

describe('escapeMarkdown', () => {
  describe('read-back', () => {
    it.each([
      ['every inline metacharacter', '\\ ` * _ [ ] < > & ! | ~ # - + .'],
      ['a complete link label, the pattern real Met titles carry', '[29 Glass Stereographs]'],
      ['a raw HTML tag', '<script>alert(1)</script>'],
      ['an image', '![img](x)'],
      ['an already-backslashed metacharacter', '\\* \\['],
      ['a line-leading block marker', '# 1. > - quoted'],
      ['entity references', 'Gift &amp; bequest &copy; &#38; &#x26;'],
      ['leading and trailing spaces', '  lead and trail  '],
    ])('reads %s back exactly', (_label, input) => {
      expect(readMarkdownText(`**Field:** ${escapeMarkdown(input)}`)).toBe(`Field: ${input}`);
    });

    it.each([
      ['a complete link label', '[29 Glass Stereographs]', '\\[29 Glass Stereographs\\]'],
      ['a raw HTML tag', '<script>alert(1)</script>', '\\<script>alert(1)\\</script>'],
      ['an already-backslashed asterisk, each character once', '\\*', '\\\\\\*'],
      ['an already-backslashed bracket, each character once', '\\[', '\\\\\\['],
    ])('escapes %s', (_label, input, expected) => {
      expect(escapeMarkdown(input)).toBe(expected);
    });
  });

  describe('edge whitespace and entity-shaped ampersands', () => {
    it('writes edge spaces as references, so a trailing run never ends the line in a hard break', () => {
      /**
       * `Oil on canvas\r\n\r\n` collapses to two trailing spaces. Written raw, a
       * CommonMark reader drops them and reads a hard break, which starts the
       * next field on a new line where every other field boundary is a soft break.
       */
      const medium = escapeMarkdown('Oil on canvas\r\n\r\n');
      expect(medium).toBe('Oil on canvas&#32;&#32;');
      expect(readMarkdownText(`**Medium:** ${medium}\n**Dimensions:** D`)).toBe(
        'Medium: Oil on canvas   Dimensions: D',
      );
    });

    it('escapes an entity-shaped ampersand, so the reference reads back as typed', () => {
      expect(escapeMarkdown('Gift &amp; bequest &copy;')).toBe('Gift \\&amp; bequest \\&copy;');
    });
  });

  describe('characters left alone', () => {
    it.each([
      ['parenthesized metric conversion', '38.1 x 24.1 cm)'],
      ['balanced parentheses', 'Bodhisattvas of the Four Directions(?)'],
      ['a bare ampersand', 'S & H'],
      ['an intraword underscore', 'Unknown_Maker'],
      ['a lone less-than', 'a < b'],
      ['a mid-line greater-than', 'a > b'],
      ['bang', '!important'],
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

/**
 * The framework escaper that `met_search_collections`' notice trailer and
 * `met_get_object`'s `dimensions` render through. The notice quotes `q`, which
 * has no length bound, so the read-back and the linear running time are this
 * server's guarantees too.
 */
describe('escapeMarkdownInline', () => {
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
      if (readMarkdownText(escapeMarkdownInline(text)) !== text.replace(/\r\n?/g, '\n')) {
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
          escapeMarkdownInline(text);
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
    /** 64 times SMALLEST: a linear escaper's cost grows 64-fold across it, a quadratic one's 4,096-fold. */
    const LARGEST = 320_000;

    it.each([
      ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
      ['two words', (n: number) => `a${' '.repeat(n)}b`],
    ])(
      'runs in linear time on %s',
      (_label, make) => {
        let ratio = 0;
        for (let chars = SMALLEST; chars <= LARGEST; chars *= 2) {
          // The baseline is timed again beside each size, so a drift in CPU speed moves both.
          const baseline = perCallMs(make(SMALLEST));
          const cost = perCallMs(make(chars));
          // Checked before the next doubling, so a super-linear escaper fails at the first size it outgrows.
          expect(cost, `${chars} characters`).toBeLessThan(MS_PER_THOUSAND_CHARS * (chars / 1_000));
          ratio = cost / baseline;
        }
        expect(ratio).toBeLessThan(4 * (LARGEST / SMALLEST));
      },
      0,
    );
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
