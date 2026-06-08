/**
 * @fileoverview Tests for met_search_collections tool.
 * @module tests/tools/met-search-collections.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';

const mockSearch = vi.fn();

vi.mock('@/services/met/met-service.js', () => ({
  getMetService: () => ({
    search: mockSearch,
  }),
}));

describe('metSearchCollections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns search results', async () => {
    mockSearch.mockResolvedValue({
      total: 100,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: true,
    });

    const ctx = createMockContext();
    const input = metSearchCollections.input.parse({ q: 'Van Gogh', limit: 3 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(result.total).toBe(100);
    expect(result.objectIDs).toEqual([1, 2, 3]);
    expect(result.returned).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('throws no_results when total is 0', async () => {
    mockSearch.mockResolvedValue({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'zzznomatch', limit: 20 });
    await expect(metSearchCollections.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  it('throws invalid_date_range when only dateBegin provided', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'test', limit: 20, dateBegin: 1800 });
    await expect(metSearchCollections.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range when dateBegin > dateEnd', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'test',
      limit: 20,
      dateBegin: 1900,
      dateEnd: 1800,
    });
    await expect(metSearchCollections.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('passes geoLocation array to service (AND-combined by API)', async () => {
    mockSearch.mockResolvedValue({
      total: 12,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
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
    });

    const ctx = createMockContext();
    const input = metSearchCollections.input.parse({ q: 'Rembrandt', isOnView: true, limit: 3 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ isOnView: true }), ctx);
    expect(result.objectIDs).toEqual([437392, 437389, 436929]);
  });

  it('format renders total and object IDs', () => {
    const blocks = metSearchCollections.format!({
      total: 500,
      objectIDs: [1001, 1002],
      returned: 2,
      truncated: true,
    });
    const text = blocks[0].text as string;
    expect(text).toContain('500');
    expect(text).toContain('1001');
    expect(text).toContain('1002');
    expect(text).toContain('truncated');
  });
});
