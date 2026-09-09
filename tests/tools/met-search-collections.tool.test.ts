/**
 * @fileoverview Tests for met_search_collections tool.
 * @module tests/tools/met-search-collections.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';

const mockSearch = vi.fn();
const mockGetValidDepartmentIds = vi.fn();

vi.mock('@/services/met/met-service.js', () => ({
  getMetService: () => ({
    search: mockSearch,
    getValidDepartmentIds: mockGetValidDepartmentIds,
  }),
}));

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

  // --- #6: invalid_date_range now carries the declared recovery hint ---
  // The framework mirrors data.recovery.hint into the content[] "Recovery:" line,
  // so asserting the hint reaches data.recovery.hint covers both client surfaces.

  it('invalid_date_range (missing pair) carries the recovery hint on data.recovery.hint', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'test', limit: 20, dateBegin: 1800 });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
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
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'test',
      limit: 20,
      dateBegin: 1900,
      dateEnd: 1800,
    });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
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
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ departmentId: 11 }), ctx);
    expect(result.total).toBe(42);
  });

  it('rejects a gap departmentId (2) with invalid_department and never searches', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'painting', departmentId: 2, limit: 3 });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
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
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ offset: 50, limit: 2 }), ctx);
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
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }), ctx);
  });

  it('passes geoLocation array to service (AND-combined by API)', async () => {
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
      geoLocation: ['France', 'Spain'],
      limit: 5,
    });
    // Multiple geoLocation values are AND-combined by the Met API (not OR) — passing two narrows results
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ geoLocation: ['France', 'Spain'] }),
      ctx,
    );
    expect(result.total).toBe(12);
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
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ isOnView: true }), ctx);
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

  // --- #12: isPublicDomain and isHighlight are true-only opt-ins ---
  // The Met search index is only sound on the `true` arm of each; the `false` arm
  // returns objects whose own record contradicts the filter. Narrowing at the
  // schema is what puts the constraint in `tools/list`, so a model never builds
  // the bad call in the first place.

  it('rejects isPublicDomain: false at the input schema, naming the remedy', () => {
    // The schema rejection surfaces as a bare -32602 with no recovery hint, so the
    // Zod message is the only guidance the caller gets — it has to say what to do.
    expect(() =>
      metSearchCollections.input.parse({ q: 'sunflower', isPublicDomain: false }),
    ).toThrow(/isPublicDomain accepts true only — omit the filter/);
  });

  it('rejects isHighlight: false at the input schema, naming the remedy', () => {
    expect(() => metSearchCollections.input.parse({ q: 'sunflower', isHighlight: false })).toThrow(
      /isHighlight accepts true only — omit the filter/,
    );
  });

  it('still accepts isPublicDomain: true and forwards it to the service', async () => {
    mockSearch.mockResolvedValue({
      total: 4,
      objectIDs: [437261, 436529],
      returned: 2,
      truncated: true,
      remaining: 2,
      nextOffset: 2,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'sunflower',
      isPublicDomain: true,
      limit: 2,
    });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ isPublicDomain: true }), ctx);
    expect(result.total).toBe(4);
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
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ isHighlight: true }), ctx);
  });

  it('leaves hasImages and isOnView as plain two-valued booleans', () => {
    // #12 narrows only the two filters with a reproduced false-arm defect.
    expect(() =>
      metSearchCollections.input.parse({ q: 'vase', hasImages: false, isOnView: false }),
    ).not.toThrow();
  });

  // --- #13: blank filter values are rejected in the handler ---
  // A blank value is not an absent one upstream: the Met index answers a blank
  // parameter with a different result set, so there is no safe value to forward.

  const expectInvalidFilter = async (raw: Record<string, unknown>, field: string) => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse(raw);
    const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);
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

  it('rejects a geoLocation array mixing a valid element with a blank one', async () => {
    // Depth case: the blank hides behind a valid sibling, so an all-blank check misses it.
    await expectInvalidFilter(
      { q: 'sunflower', geoLocation: ['France', ''], limit: 3 },
      'geoLocation',
    );
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
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ q: '  sunflower  ' }), ctx);
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

  // --- #20: no_results names isPublicDomain when it zeroed the query ---

  it('no_results with isPublicDomain: true names the filter in the recovery hint', async () => {
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
    const input = metSearchCollections.input.parse({
      q: 'vase',
      departmentId: 13,
      isPublicDomain: true,
      limit: 20,
    });
    const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);
    expect(err.data.reason).toBe('no_results');
    expect(err.data.recovery.hint).toContain('isPublicDomain');
    expect(err.data.recovery.hint).toContain('met_get_object');
  });

  it('no_results without isPublicDomain keeps the generic recovery hint', async () => {
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
    const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);
    expect(err.data.reason).toBe('no_results');
    expect(err.data.recovery.hint).toBe(
      'Broaden the query, remove filters, or call met_list_departments and set a valid departmentId.',
    );
  });
});
