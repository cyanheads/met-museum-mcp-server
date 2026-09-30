/**
 * @fileoverview Tests for met_search_collections tool.
 * @module tests/tools/met-search-collections.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';

const mockSearch = vi.fn();
const mockGetValidDepartmentIds = vi.fn();
const mockCountKeywordMatches = vi.fn();

/**
 * The service is stubbed at its accessor; the module's constants (the search
 * window `format()` reads) stay real. The URL building, window arithmetic, and
 * no_results hint over a real service are covered in the service suite.
 */
vi.mock('@/services/met/met-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/met/met-service.js')>()),
  getMetService: () => ({
    search: mockSearch,
    getValidDepartmentIds: mockGetValidDepartmentIds,
    countKeywordMatches: mockCountKeywordMatches,
  }),
}));

/** The per-call deadline every service call receives as its third argument. */
const aDeadline = () =>
  expect.objectContaining({ deadlineAt: expect.any(Number), signal: expect.any(AbortSignal) });

/** The live-verified Met department ID set (gaps at 2 and 20, nothing ≥ 22). */
const VALID_DEPARTMENT_IDS = new Set([
  1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21,
]);

describe('metSearchCollections', () => {
  beforeEach(() => {
    /**
     * resetAllMocks, not clearAllMocks: clearing wipes call records but leaves
     * implementations in place, so a `mockResolvedValue` set by one test leaks into
     * the next and can make an unconfigured test pass on a neighbour's fixture.
     * Resetting drops the implementations too, so any test that forgets to stage
     * `mockSearch` fails loudly instead of quietly asserting the wrong data.
     */
    vi.resetAllMocks();
    // Default: a fully-populated department set. Individual tests exercising an
    // invalid ID simply pass one not in this set (2, 999).
    mockGetValidDepartmentIds.mockResolvedValue(VALID_DEPARTMENT_IDS);
  });

  it('returns search results', async () => {
    mockSearch.mockResolvedValue({
      total: 100,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: true,
      remaining: 97,
      nextOffset: 3,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'Van Gogh', limit: 3 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(result.total).toBe(100);
    expect(result.objectIDs).toEqual([1, 2, 3]);
    expect(result.returned).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(97);
    expect(result.nextOffset).toBe(3);
  });

  it('throws no_results when total is 0', async () => {
    mockSearch.mockResolvedValue({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'zzznomatch', limit: 20 });
    await expect(metSearchCollections.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  /**
   * The error envelope a failing call returns. The declared recovery hint is
   * filled by the tool pipeline from the `errors[]` contract, not by the
   * handler's throw, so hint assertions run through `runToolContract` — the
   * seam that applies the fill, as production does.
   */
  const contractError = async (args: z.input<typeof metSearchCollections.input>) => {
    const result = await runToolContract(metSearchCollections, args);
    expect(result.isError).toBe(true);
    return (
      result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      }
    ).error;
  };

  // --- #6: invalid_date_range carries the declared recovery hint ---
  // The framework mirrors data.recovery.hint into the content[] "Recovery:" line,
  // so asserting the hint reaches data.recovery.hint covers both client surfaces.

  it('invalid_date_range (missing pair) carries the recovery hint on data.recovery.hint', async () => {
    const error = await contractError({ q: 'test', limit: 20, dateBegin: 1800 });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_date_range',
        recovery: {
          hint: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
        },
      },
    });
  });

  it('invalid_date_range (dateBegin > dateEnd) carries the recovery hint on data.recovery.hint', async () => {
    const error = await contractError({ q: 'test', limit: 20, dateBegin: 1900, dateEnd: 1800 });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_date_range',
        recovery: {
          hint: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
        },
      },
    });
  });

  // --- #7: departmentId validated before searching ---

  it('searches normally for a valid departmentId', async () => {
    mockSearch.mockResolvedValue({
      total: 42,
      objectIDs: [1, 2],
      returned: 2,
      truncated: true,
      remaining: 40,
      nextOffset: 2,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'painting', departmentId: 11, limit: 2 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockGetValidDepartmentIds).toHaveBeenCalledOnce();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: 11 }),
      ctx,
      aDeadline(),
    );
    // One budget: the lookup and the search share the deadline the handler started.
    expect(mockGetValidDepartmentIds.mock.calls[0]?.[1]).toBe(mockSearch.mock.calls[0]?.[2]);
    expect(result.total).toBe(42);
  });

  it('rejects a gap departmentId (2) with invalid_department and never searches', async () => {
    const error = await contractError({ q: 'painting', departmentId: 2, limit: 3 });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_department',
        recovery: { hint: expect.stringContaining('met_list_departments') },
      },
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects a high invalid departmentId (999) with invalid_department', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'painting', departmentId: 999, limit: 3 });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_department' },
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('a valid department with zero matches still returns no_results, not invalid_department', async () => {
    mockSearch.mockResolvedValue({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    mockCountKeywordMatches.mockResolvedValue(0);
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'zzznomatch',
      departmentId: 11,
      limit: 20,
    });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  // --- #9: offset paging plumbed through the handler ---

  it('passes offset through to the service and returns pagination fields', async () => {
    mockSearch.mockResolvedValue({
      total: 100,
      objectIDs: [51, 52],
      returned: 2,
      truncated: true,
      remaining: 48,
      nextOffset: 52,
      offset: 50,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'cat', limit: 2, offset: 50 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 50, limit: 2 }),
      ctx,
      aDeadline(),
    );
    expect(result.nextOffset).toBe(52);
    expect(result.remaining).toBe(48);
  });

  it('defaults offset to 0 when omitted', async () => {
    mockSearch.mockResolvedValue({
      total: 5,
      objectIDs: [1, 2, 3, 4, 5],
      returned: 5,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'rare', limit: 20 });
    await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 }),
      ctx,
      aDeadline(),
    );
  });

  it('passes a one-location geoLocation array to the service', async () => {
    mockSearch.mockResolvedValue({
      total: 12,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'painting',
      geoLocation: ['France'],
      limit: 5,
    });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ geoLocation: ['France'] }),
      ctx,
      aDeadline(),
    );
    expect(result.total).toBe(12);
  });

  it('rejects a second geoLocation value at the input schema, naming the remedy', () => {
    // The Met search applies only the first repeated value, so a second one would
    // be silently ignored — the schema refuses it instead.
    expect(() =>
      metSearchCollections.input.parse({ q: 'painting', geoLocation: ['France', 'Spain'] }),
    ).toThrow(/geoLocation takes one location/);
  });

  it('passes isOnView to service', async () => {
    mockSearch.mockResolvedValue({
      total: 117,
      objectIDs: [437392, 437389, 436929],
      returned: 3,
      truncated: true,
      remaining: 114,
      nextOffset: 3,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'Rembrandt', isOnView: true, limit: 3 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ isOnView: true }),
      ctx,
      aDeadline(),
    );
    expect(result.objectIDs).toEqual([437392, 437389, 436929]);
  });

  it('format renders total, pagination fields, and object IDs', () => {
    const blocks = metSearchCollections.format!({
      total: 500,
      objectIDs: [1001, 1002],
      returned: 2,
      truncated: true,
      remaining: 498,
      nextOffset: 2,
      offset: 0,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('500');
    expect(text).toContain('1001');
    expect(text).toContain('1002');
    expect(text).toContain('truncated');
    expect(text).toContain('Remaining:** 498');
    expect(text).toContain('Next offset:** 2');
  });

  it('format shows completion markers on the final page (not truncated, nextOffset none)', () => {
    const blocks = metSearchCollections.format!({
      total: 2,
      objectIDs: [1001, 1002],
      returned: 2,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const text = (blocks[0] as { text: string }).text;
    // truncated: false must render an explicit marker rather than silently vanishing.
    expect(text).toContain('(complete)');
    expect(text).toContain('Next offset:** none');
    expect(text).toContain('Remaining:** 0');
  });

  // --- #12: isHighlight is a true-only opt-in ---
  // The search ignores `isHighlight=false`. Narrowing at the schema is what puts
  // the constraint in `tools/list`, so a model never builds the dead call.

  it('rejects isHighlight: false at the input schema, naming the remedy', () => {
    // The schema rejection surfaces as a bare -32602 with no recovery hint, so the
    // Zod message is the only guidance the caller gets — it has to say what to do.
    expect(() => metSearchCollections.input.parse({ q: 'sunflower', isHighlight: false })).toThrow(
      /isHighlight accepts true only — omit the filter/,
    );
  });

  it('still accepts isHighlight: true and forwards it to the service', async () => {
    mockSearch.mockResolvedValue({
      total: 3,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'vase', isHighlight: true, limit: 20 });
    await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ isHighlight: true }),
      ctx,
      aDeadline(),
    );
  });

  it('leaves hasImages and isOnView as plain two-valued booleans', () => {
    // The search honors both arms of each.
    expect(() =>
      metSearchCollections.input.parse({ q: 'vase', hasImages: false, isOnView: false }),
    ).not.toThrow();
  });

  // --- #13: blank filter values are rejected in the handler ---
  // The Met search ignores a blank parameter, silently widening the search, so
  // there is no safe blank to forward.

  const expectInvalidFilter = async (
    args: z.input<typeof metSearchCollections.input>,
    field: string,
  ) => {
    const err = await contractError(args);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_filter',
        recovery: {
          hint: 'Supply a non-blank value for the named field, or omit the optional filter entirely.',
        },
      },
    });
    expect(err.message).toContain(field);
    expect(mockSearch).not.toHaveBeenCalled();
  };

  it('rejects a whitespace-only q with invalid_filter naming the field', async () => {
    await expectInvalidFilter({ q: '   ', limit: 3 }, 'q');
  });

  it('rejects a blank medium with invalid_filter naming the field', async () => {
    await expectInvalidFilter({ q: 'sunflower', medium: '', limit: 3 }, 'medium');
  });

  it('rejects a whitespace-only medium with invalid_filter', async () => {
    await expectInvalidFilter({ q: 'sunflower', medium: '   ', limit: 3 }, 'medium');
  });

  it('rejects an empty geoLocation array with invalid_filter', async () => {
    await expectInvalidFilter({ q: 'sunflower', geoLocation: [], limit: 3 }, 'geoLocation');
  });

  it('rejects a geoLocation array whose only element is blank', async () => {
    await expectInvalidFilter({ q: 'sunflower', geoLocation: [''], limit: 3 }, 'geoLocation');
  });

  it('rejects a geoLocation array mixing a valid element with a blank one at the schema', () => {
    // geoLocation takes one element, so a blank hiding behind a valid sibling never
    // reaches the handler's blank check — the one-element cap refuses it first.
    expect(() =>
      metSearchCollections.input.parse({ q: 'sunflower', geoLocation: ['France', ''], limit: 3 }),
    ).toThrow(/geoLocation takes one location/);
  });

  it('accepts a q with meaningful content and incidental surrounding whitespace', async () => {
    mockSearch.mockResolvedValue({
      total: 97,
      objectIDs: [1],
      returned: 1,
      truncated: true,
      remaining: 96,
      nextOffset: 1,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: '  sunflower  ', limit: 1 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ q: '  sunflower  ' }),
      ctx,
      aDeadline(),
    );
    expect(result.total).toBe(97);
  });

  it('leaves an omitted medium and geoLocation unaffected', async () => {
    mockSearch.mockResolvedValue({
      total: 5,
      objectIDs: [1, 2, 3, 4, 5],
      returned: 5,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'sunflower', limit: 20 });
    await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ medium: undefined, geoLocation: undefined }),
      ctx,
      aDeadline(),
    );
  });

  it('keeps invalid_date_range ahead of the blank-filter check', async () => {
    // Ordering pin: a request invalid on both counts must still report the
    // date-range fault it reports today.
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: '   ', dateBegin: 1800, limit: 3 });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
  });

  // --- #17: an exhausted offset page is distinguishable from a real final page ---

  it('echoes the resolved offset through the handler output', async () => {
    mockSearch.mockResolvedValue({
      total: 97,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 999999,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'sunflower', limit: 3, offset: 999999 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(result.offset).toBe(999999);
  });

  it('format marks an offset past the end distinctly, never as (complete)', () => {
    const blocks = metSearchCollections.format!({
      total: 97,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 999999,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('(complete)');
    expect(text).toContain('offset beyond result set');
    expect(text).toContain('Offset:** 999999');
  });

  it('format marks the exact offset === total boundary as past the end', () => {
    // The boundary, not merely a far-past offset: offset 97 of 97 is already exhausted.
    const blocks = metSearchCollections.format!({
      total: 97,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 97,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('(complete)');
    expect(text).toContain('offset beyond result set');
  });

  it('format still renders (truncated) on a mid-result page', () => {
    const blocks = metSearchCollections.format!({
      total: 100,
      objectIDs: [51, 52],
      returned: 2,
      truncated: true,
      remaining: 48,
      nextOffset: 52,
      offset: 50,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(truncated)');
    expect(text).not.toContain('offset beyond result set');
    expect(text).toContain('Offset:** 50');
  });

  // --- #27: the 10,000 window adds a fourth format state ---

  it('format marks a last page that stops at the window short of total as (window end)', () => {
    const blocks = metSearchCollections.format!({
      total: 14_398,
      objectIDs: [9999, 10_000],
      returned: 2,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 9998,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(window end)');
    expect(text).not.toContain('(complete)');
    expect(text).not.toContain('offset beyond result set');
  });

  it('format marks an offset at the window, short of total, as past the end', () => {
    const blocks = metSearchCollections.format!({
      total: 14_398,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 10_000,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('offset beyond result set');
    expect(text).not.toContain('(window end)');
  });

  it('format marks the final page of a total of exactly 10,000 as (complete)', () => {
    const blocks = metSearchCollections.format!({
      total: 10_000,
      objectIDs: [10_000],
      returned: 1,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 9999,
    });
    expect((blocks[0] as { text: string }).text).toContain('(complete)');
  });

  // --- #25: the keyword-only count is issued only for a filtered miss ---

  const emptyPage = {
    total: 0,
    objectIDs: [],
    returned: 0,
    truncated: false,
    remaining: 0,
    nextOffset: null,
    offset: 0,
  };

  it('an unfiltered miss does not ask for the keyword-only count', async () => {
    mockSearch.mockResolvedValue(emptyPage);
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'zzznomatch', limit: 20 });
    const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);

    expect(err.data.reason).toBe('no_results');
    expect(err.data.recovery.hint).toContain('"zzznomatch" matches no object');
    expect(mockCountKeywordMatches).not.toHaveBeenCalled();
  });

  it('a filtered miss asks for the keyword-only count once, with the keyword', async () => {
    mockSearch.mockResolvedValue(emptyPage);
    mockCountKeywordMatches.mockResolvedValue(1);
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'sunflower', hasImages: false });
    const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);

    expect(mockCountKeywordMatches).toHaveBeenCalledExactlyOnceWith('sunflower', ctx, aDeadline());
    expect(mockCountKeywordMatches.mock.calls[0]?.[2]).toBe(mockSearch.mock.calls[0]?.[2]);
    expect(err.data.recovery.hint).toContain('matches 1 object on its own');
    expect(err.data.recovery.hint).toContain('removed every match: hasImages.');
    // No medium correction when medium was not set.
    expect(err.data.recovery.hint).not.toContain('classification');
  });

  it('a non-empty filtered page never asks for the keyword-only count', async () => {
    mockSearch.mockResolvedValue({ ...emptyPage, total: 3, objectIDs: [1, 2, 3], returned: 3 });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'vase', medium: 'Ceramics' });
    await metSearchCollections.handler(input, ctx);

    expect(mockCountKeywordMatches).not.toHaveBeenCalled();
  });

  // --- inputAliases: `query` and `keyword` reach the declared `q` ---
  // The rewrite happens in parseToolArguments, above the handler, so the only
  // seam that exercises it is the full tool contract.

  describe('input aliases', () => {
    const page = {
      total: 3,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    };

    /**
     * An alias is an off-schema key by construction, so the runner's typed
     * argument parameter cannot express one — the cast is what lets the test
     * send the arguments a client actually sends.
     */
    const call = (args: Record<string, unknown>) =>
      runToolContract(
        metSearchCollections,
        args as unknown as z.input<typeof metSearchCollections.input>,
      );

    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

    it.each(['query', 'keyword'])('rewrites %s to q before validation', async (alias) => {
      mockSearch.mockResolvedValue(page);
      const result = await call({ [alias]: 'sunflower', limit: 3 });

      expect(result.isError).toBeFalsy();
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'sunflower' }),
        expect.anything(),
        aDeadline(),
      );
      // Both consumption surfaces carry the page, not just structuredContent.
      expect((result.structuredContent as { total: number }).total).toBe(3);
      expect(textOf(result)).toContain('**Total matches:** 3');
    });

    it('leaves a declared q alone when an alias is sent alongside it', async () => {
      mockSearch.mockResolvedValue(page);
      const result = await call({ q: 'sunflower', query: 'tulip', limit: 3 });

      // A rewrite applies only when the target is absent, so `query` stays an
      // unrecognized key and the call is rejected rather than silently choosing.
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('query');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('still rejects an undeclared key that maps to no alias', async () => {
      const result = await call({ q: 'sunflower', sortBy: 'relevance', limit: 3 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('sortBy');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('rejects a missing q as an InvalidParams envelope naming the field', async () => {
      const result = await call({ limit: 3 });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number } }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(textOf(result)).toContain('q');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('delivers no_results on both surfaces — the log severity moves, the envelope does not', async () => {
      mockSearch.mockResolvedValue({
        total: 0,
        objectIDs: [],
        returned: 0,
        truncated: false,
        remaining: 0,
        nextOffset: null,
        offset: 0,
      });
      const result = await call({ q: 'zzznomatch', limit: 3 });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; data: { reason: string; recovery: { hint: string } } };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('no_results');
      expect(error.data.recovery.hint).not.toContain('met_list_departments');
      expect(textOf(result)).toContain('Recovery: The keyword "zzznomatch" matches no object');
      expect(textOf(result)).toContain('no_results');
    });
  });
});
