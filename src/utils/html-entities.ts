/**
 * @fileoverview HTML character-reference decoding for upstream text the Met
 * sends entity-encoded (`constituents[].name`: `Tiffany &amp; Co.`,
 * `World&#39;s Views Series`).
 *
 * Dependency-free leaf module, beside `markdown.ts`: decoding runs on the way
 * in, in `normalizeObject`, and `escapeMarkdown` escapes the decoded text again
 * at the `content[]` render boundary.
 *
 * @module utils/html-entities
 */

/**
 * The five names XML predefines — the only named references decoded. A `Map`,
 * not an object literal, so a name like `constructor` or `__proto__` finds
 * nothing rather than an inherited property.
 */
const NAMED_REFERENCES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * One reference: decimal, hex, or named, each closed by `;`. Every quantifier
 * applies to a single character class and none is nested, so a match attempt
 * scans only the run of digits or letters after one `&` and the whole pass is
 * linear in the input.
 */
const REFERENCE = /&(?:#(\d+)|#[xX]([\dA-Fa-f]+)|([A-Za-z]+));/g;

/**
 * Whether a numeric reference names a character this decoder emits. Refused:
 * U+0000, the control characters (C0 `U+0001–U+001F`, DEL, C1 `U+0080–U+009F`),
 * the UTF-16 surrogates, and anything past U+10FFFF — none is text a catalog
 * name means to carry.
 */
function isDecodable(codePoint: number): boolean {
  return (
    codePoint >= 0x20 &&
    !(codePoint >= 0x7f && codePoint <= 0x9f) &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff) &&
    codePoint <= 0x10ffff
  );
}

/**
 * Decode HTML character references in one left-to-right pass.
 *
 * Resolves the five predefined names (`&amp;`, `&lt;`, `&gt;`, `&quot;`,
 * `&apos;`) and decimal (`&#39;`) or hex (`&#x27;`) numeric references.
 * Everything else stays literal: other names (`&eacute;`), a reference with no
 * closing `;`, and a numeric reference {@link isDecodable} refuses. Decoded
 * text is never re-read, so `&amp;lt;` becomes `&lt;`, not `<`.
 *
 * @param value - Upstream text that may carry character references.
 * @returns The text with each recognized reference replaced by its character.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    REFERENCE,
    (reference, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_REFERENCES.get(name) ?? reference;
      const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return isDecodable(codePoint) ? String.fromCodePoint(codePoint) : reference;
    },
  );
}
