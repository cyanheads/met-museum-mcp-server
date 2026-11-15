/**
 * @fileoverview The read-back helper tells the line breaks apart as CommonMark
 * renders them: a soft break is a space, a hard break and a block join are a
 * line break. A read-back that maps both breaks to `\n` passes an escaper that
 * writes a bare LF where a hard break belongs.
 * @module tests/helpers/read-markdown-text.test
 */

import { describe, expect, it } from 'vitest';
import { readMarkdownText } from './read-markdown-text.js';

describe('readMarkdownText', () => {
  it.each([
    ['a soft break as a space', 'a\nb', 'a b'],
    ['a backslash hard break as a line break', 'a\\\nb', 'a\nb'],
    ['a two-space hard break as a line break', 'a  \nb', 'a\nb'],
    ['two paragraphs joined by a line break', 'a\n\nb', 'a\nb'],
  ])('reads %s', (_label, markdown, text) => {
    expect(readMarkdownText(markdown)).toBe(text);
  });
});
