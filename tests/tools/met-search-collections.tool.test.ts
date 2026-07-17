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
    vi.clearAllMocks();
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
    });

    const ctx = createMockContext();
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
    const err = await metSearchCollections.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('invalid_date_range');
    expect(err.data.recovery.hint).toBe(
      'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
    );
  });

  it('invalid_date_range (dateBegin > dateEnd) carries the recovery hint on data.recovery.hint', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'test',
      limit: 20,
      dateBegin: 1900,
      dateEnd: 1800,
    });
    const err = await metSearchCollections.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('invalid_date_range');
    expect(err.data.recovery.hint).toBe(
      'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
    );
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
    const err = await metSearchCollections.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('invalid_department');
    expect(err.data.recovery.hint).toContain('met_list_departments');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects a high invalid departmentId (999) with invalid_department', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'painting', departmentId: 999, limit: 3 });
    const err = await metSearchCollections.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('invalid_department');
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
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'zzznomatch',
      departmentId: 11,
      limit: 20,
    });
    const err = await metSearchCollections.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_results');
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
    });
    const ctx = createMockContext();
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
    });
    const ctx = createMockContext();
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
    });

    const ctx = createMockContext();
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
    });

    const ctx = createMockContext();
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
    });
    const text = blocks[0].text as string;
    expect(text).toContain('500');
    expect(text).toContain('1001');
    expect(text).toContain('1002');
    expect(text).toContain('truncated');
    expect(text).toContain('Remaining:** 498');
    expect(text).toContain('Next offset:** 2');
  });

  it('format shows "none" for nextOffset on the final page', () => {
    const blocks = metSearchCollections.format!({
      total: 2,
      objectIDs: [1001, 1002],
      returned: 2,
      truncated: false,
      remaining: 0,
      nextOffset: null,
    });
    const text = blocks[0].text as string;
    expect(text).toContain('Next offset:** none');
    expect(text).toContain('Remaining:** 0');
  });
});
