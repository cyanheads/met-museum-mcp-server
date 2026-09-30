/**
 * @fileoverview Tests for the HTML character-reference decoder applied to
 * `constituents[].name` — the five predefined names, decimal and hex numeric
 * references, the code points it refuses, the single-pass property, and the
 * linear-time bound.
 * @module tests/utils/html-entities.test
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities } from '@/utils/html-entities.js';

describe('decodeHtmlEntities', () => {
  describe('the five predefined names', () => {
    it.each([
      ['&amp;', '&'],
      ['&lt;', '<'],
      ['&gt;', '>'],
      ['&quot;', '"'],
      ['&apos;', "'"],
    ])('decodes %s', (input, expected) => {
      expect(decodeHtmlEntities(input)).toBe(expected);
    });

    it('decodes the constituent names the Met sends', () => {
      expect(decodeHtmlEntities('Tiffany &amp; Co.')).toBe('Tiffany & Co.');
      expect(decodeHtmlEntities('World&#39;s Views Series')).toBe("World's Views Series");
      expect(decodeHtmlEntities('Good, Berners, &amp; Lant')).toBe('Good, Berners, & Lant');
    });

    it('decodes every reference in a value, not just the first', () => {
      expect(decodeHtmlEntities('&lt;b&gt;Studio&lt;/b&gt;')).toBe('<b>Studio</b>');
    });
  });

  describe('numeric references', () => {
    it.each([
      ['decimal', '&#39;', "'"],
      ['decimal with leading zeros', '&#0038;', '&'],
      ['hex, lowercase x', '&#x27;', "'"],
      ['hex, uppercase X', '&#X27;', "'"],
      ['hex, mixed-case digits', '&#x2f;&#x2F;', '//'],
      ['the first code point past the C0 controls', '&#32;', ' '],
      ['the first code point past the C1 controls', '&#xA0;', '\u00A0'],
      ['an astral code point, decimal', '&#128512;', '😀'],
      ['an astral code point, hex', '&#x1F600;', '😀'],
      ['the last valid code point', '&#x10FFFF;', String.fromCodePoint(0x10ffff)],
      ['the code point just past the surrogates', '&#xE000;', '\uE000'],
    ])('decodes %s', (_label, input, expected) => {
      expect(decodeHtmlEntities(input)).toBe(expected);
    });
  });

  describe('everything else stays literal', () => {
    it.each([
      ['a name the Map does not hold', '&eacute;'],
      ['a prototype key', '&constructor;'],
      ['a prototype key with underscores', '&__proto__;'],
      ['another inherited name', '&toString;'],
      ['a predefined name in the wrong case', '&AMP;'],
      ['a name with no semicolon', '&amp'],
      ['a decimal reference with no digits', '&#;'],
      ['a hex reference with no digits', '&#x;'],
      ['a hex reference with non-hex digits', '&#xZZ;'],
      ['a space after the ampersand', '& amp;'],
      ['a bare ampersand', 'A & B'],
      ['U+0000', '&#0;'],
      ['U+0000 in hex', '&#x0;'],
      ['a C0 control', '&#1;'],
      ['a C0 control in hex', '&#x1F;'],
      ['tab, a C0 control', '&#9;'],
      ['DEL', '&#127;'],
      ['a C1 control', '&#150;'],
      ['the last C1 control', '&#x9F;'],
      ['a high surrogate', '&#xD800;'],
      ['a low surrogate', '&#xDFFF;'],
      ['a surrogate in decimal', '&#55296;'],
      ['a code point past U+10FFFF', '&#x110000;'],
      ['a code point past U+10FFFF in decimal', '&#1114112;'],
      ['a decimal too long to be any code point', `&#${'9'.repeat(40)};`],
    ])('leaves %s literal', (_label, input) => {
      expect(decodeHtmlEntities(input)).toBe(input);
    });

    it('returns a value with no reference unchanged', () => {
      const plain = 'Vincent van Gogh (Dutch, 1853–1890) <i>x</i>';
      expect(decodeHtmlEntities(plain)).toBe(plain);
    });

    it('decodes the valid references beside the literal ones', () => {
      expect(decodeHtmlEntities('a &lt;b&gt; &eacute; &#1; &#39;d&#39; &amp')).toBe(
        "a <b> &eacute; &#1; 'd' &amp",
      );
    });
  });

  describe('single left-to-right pass', () => {
    it.each([
      ['&amp;lt;', '&lt;'],
      ['&amp;#39;', '&#39;'],
      ['&amp;amp;', '&amp;'],
      ['&amp;#x3C;', '&#x3C;'],
    ])('decodes %s once, to %s', (input, expected) => {
      expect(decodeHtmlEntities(input)).toBe(expected);
    });

    it('never re-reads a decoded & as the start of a reference', () => {
      expect(decodeHtmlEntities('&#38;lt;')).toBe('&lt;');
    });
  });

  describe('linear time', () => {
    /**
     * A pattern with nested quantifiers backtracks super-linearly on these
     * shapes; at 1 MB that runs for hours, so finishing inside the test timeout
     * is the bound. Each value holds no complete reference and comes back whole.
     */
    const MB = 1024 * 1024;

    it.each([
      ['repeated &', '&'],
      ['repeated &#', '&#'],
      ['repeated &a', '&a'],
      ['repeated &#x', '&#x'],
      ['repeated &#1', '&#1'],
    ])('passes 1 MB of %s through in one pass', (_label, unit) => {
      const value = unit.repeat(MB / unit.length);
      expect(decodeHtmlEntities(value)).toBe(value);
    });

    it.each([
      ['letters', '&', 'a'],
      ['decimal digits', '&#', '1'],
      ['hex digits', '&#x', 'f'],
    ])('passes one reference opener followed by 1 MB of %s through', (_label, opener, unit) => {
      const value = opener + unit.repeat(MB);
      expect(decodeHtmlEntities(value)).toBe(value);
    });

    it('decodes 1 MB of complete references in one pass', () => {
      const count = Math.floor(MB / '&amp;'.length);
      expect(decodeHtmlEntities('&amp;'.repeat(count))).toBe('&'.repeat(count));
    });
  });
});
