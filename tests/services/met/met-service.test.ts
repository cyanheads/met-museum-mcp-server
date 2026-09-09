/**
 * @fileoverview Tests for MetService — offset paging, fail-fast search timeout,
 * and cached department-ID validation. Exercises the real service with a mocked
 * global fetch (the tool tests mock the service wholesale).
 * @module tests/services/met/met-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';
import { getMetService, initMetService } from '@/services/met/met-service.js';

/** JSON response with a real body stream for fetchWithTimeout's deadline wrapper. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

/** A `/search` payload with `count` sequential IDs (1..count) and a reported total. */
function idsResponse(total: number, count = total): Response {
  return jsonResponse({ total, objectIDs: Array.from({ length: count }, (_, i) => i + 1) });
}

/** A real streaming response whose body fails after headers with the supplied error. */
function bodyFailureResponse(error: unknown): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('MetService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initMetService({} as AppConfig, createInMemoryStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('search — offset paging (#9)', () => {
    it('slices the first page and reports continuation at offset 0', async () => {
      fetchMock.mockResolvedValue(idsResponse(100));
      const result = await getMetService().search({ q: 'cat', limit: 10 }, createMockContext());
      expect(result.objectIDs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(result.returned).toBe(10);
      expect(result.truncated).toBe(true);
      expect(result.remaining).toBe(90);
      expect(result.nextOffset).toBe(10);
    });

    it('slices a mid window via offset', async () => {
      fetchMock.mockResolvedValue(idsResponse(100));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 20 },
        createMockContext(),
      );
      expect(result.objectIDs[0]).toBe(21);
      expect(result.objectIDs.at(-1)).toBe(30);
      expect(result.returned).toBe(10);
      expect(result.remaining).toBe(70);
      expect(result.nextOffset).toBe(30);
      expect(result.truncated).toBe(true);
    });

    it('the last partial page ends pagination (truncated false, nextOffset null)', async () => {
      fetchMock.mockResolvedValue(idsResponse(25));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 20 },
        createMockContext(),
      );
      expect(result.objectIDs).toEqual([21, 22, 23, 24, 25]);
      expect(result.returned).toBe(5);
      expect(result.remaining).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('an offset at or beyond total returns an empty page, not an error', async () => {
      fetchMock.mockResolvedValue(idsResponse(25));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 999 },
        createMockContext(),
      );
      expect(result.objectIDs).toEqual([]);
      expect(result.returned).toBe(0);
      expect(result.remaining).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('default offset 0 with a fully-returned set is not truncated', async () => {
      fetchMock.mockResolvedValue(idsResponse(5));
      const result = await getMetService().search({ q: 'rare', limit: 20 }, createMockContext());
      expect(result.objectIDs).toEqual([1, 2, 3, 4, 5]);
      expect(result.truncated).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.nextOffset).toBeNull();
    });

    // --- #17: the resolved offset is echoed on the result ---

    it('echoes the requested offset on the result', async () => {
      fetchMock.mockResolvedValue(idsResponse(100));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 20 },
        createMockContext(),
      );
      expect(result.offset).toBe(20);
    });

    it('echoes the applied default of 0 when offset is omitted', async () => {
      fetchMock.mockResolvedValue(idsResponse(5));
      const result = await getMetService().search({ q: 'rare', limit: 20 }, createMockContext());
      expect(result.offset).toBe(0);
    });

    it('echoes an offset that ran past the end alongside the empty page', async () => {
      fetchMock.mockResolvedValue(idsResponse(25));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 999 },
        createMockContext(),
      );
      // total is knowable from the same result, so offset >= total is directly readable.
      expect(result.offset).toBe(999);
      expect(result.total).toBe(25);
    });
  });

  describe('buildSearchUrl — omitted optional filters stay off the request (#13)', () => {
    it('omits medium and geoLocation entirely when they are not supplied', async () => {
      fetchMock.mockResolvedValue(idsResponse(3));
      await getMetService().search({ q: 'cat', limit: 10 }, createMockContext());
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.searchParams.get('q')).toBe('cat');
      expect(url.searchParams.has('medium')).toBe(false);
      expect(url.searchParams.has('geoLocation')).toBe(false);
    });

    it('appends every geoLocation value when they are supplied', async () => {
      fetchMock.mockResolvedValue(idsResponse(3));
      await getMetService().search(
        { q: 'cat', limit: 10, geoLocation: ['France', 'Egypt'] },
        createMockContext(),
      );
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.searchParams.getAll('geoLocation')).toEqual(['France', 'Egypt']);
    });
  });

  describe('search — fail-fast on a deterministic timeout (#11)', () => {
    it('does not retry an aborted (timed-out) search and surfaces search_timeout with recovery', async () => {
      // fetchWithTimeout classifies its own deadline before the service adds the
      // search-specific reason and non-retryable recovery contract.
      fetchMock.mockRejectedValue(timeout('Upstream request timed out.'));
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      const err = await getMetService()
        .search({ q: 'the', limit: 20 }, ctx)
        .catch((e) => e);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data.reason).toBe('search_timeout');
      expect(err.data.retryable).toBe(false);
      expect(err.data.recovery.hint).toContain('Narrow the query');
    });

    it('also classifies a timeout while reading the response body as search_timeout', async () => {
      fetchMock.mockResolvedValue(bodyFailureResponse(timeout('Upstream request timed out.')));
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      await expect(getMetService().search({ q: 'the', limit: 20 }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'search_timeout', retryable: false },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a normal-latency search still succeeds in one fetch (no retry-behavior regression)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ total: 3, objectIDs: [1, 2, 3] }));
      const result = await getMetService().search({ q: 'vermeer', limit: 20 }, createMockContext());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.objectIDs).toEqual([1, 2, 3]);
    });
  });

  describe('getValidDepartmentIds — memoized (#7)', () => {
    const departmentsBody = {
      departments: [
        { departmentId: 1, displayName: 'American Decorative Arts' },
        { departmentId: 11, displayName: 'European Paintings' },
        { departmentId: 21, displayName: 'Modern and Contemporary Art' },
      ],
    };

    it('returns the department ID set and fetches upstream only once across calls', async () => {
      fetchMock.mockResolvedValue(jsonResponse(departmentsBody));
      const ctx = createMockContext();

      const first = await getMetService().getValidDepartmentIds(ctx);
      const second = await getMetService().getValidDepartmentIds(ctx);

      expect(first.has(11)).toBe(true);
      expect(first.has(2)).toBe(false);
      expect([...second].sort((a, b) => a - b)).toEqual([1, 11, 21]);
      // Memoized: the second lookup reads the cache instead of re-fetching /departments.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/departments');
    });
  });
});
