/**
 * @fileoverview Tests for met_list_objects (#26). Every case runs the tool over
 * the real `MetService` — sort, cache, and paging arithmetic included — with a
 * faked global fetch standing in for the Met API, through `runToolContract`, the
 * seam that builds both client surfaces and the error envelope.
 * @module tests/tools/met-list-objects.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { metListObjects } from '@/mcp-server/tools/definitions/met-list-objects.tool.js';
import { initMetService } from '@/services/met/met-service.js';

const COLLECTION_ORIGIN = 'https://collectionapi.metmuseum.org';
const OBJECTS_PATH = '/public/collection/v1/objects';
const DEPARTMENTS_PATH = '/public/collection/v1/departments';

/** The live-verified Met department ID set (gaps at 2 and 20, nothing ≥ 22). */
const VALID_DEPARTMENT_IDS = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21];

interface FixtureRecord {
  departmentId: number;
  id: number;
  /** The UTC day of the record's last metadata update. */
  updated: string;
}

/**
 * The collection the fake `/v1/objects` serves: three Egyptian Art records (two
 * sharing the update day of object 545138, captured live), two European
 * Paintings records, and forty Modern and Contemporary Art records so a default
 * page of 20 is truncated.
 */
const RECORDS: FixtureRecord[] = [
  { id: 545138, departmentId: 10, updated: '2026-09-26' },
  { id: 555799, departmentId: 10, updated: '2026-09-26' },
  { id: 544100, departmentId: 10, updated: '2026-09-02' },
  { id: 436535, departmentId: 11, updated: '2026-08-15' },
  { id: 437984, departmentId: 11, updated: '2026-09-10' },
  ...Array.from({ length: 40 }, (_, i) => ({
    id: 480_000 + i * 7,
    departmentId: 21,
    updated: '2026-07-01',
  })),
];

const ALL_IDS_ASCENDING = RECORDS.map((r) => r.id).sort((a, b) => a - b);

/** A deterministic order that is not ascending, as upstream's is not. */
const scramble = (ids: number[]) =>
  [...ids].sort((a, b) => ((a * 7919) % 104_729) - ((b * 7919) % 104_729));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/**
 * `/v1/objects` as the Met answers it: `departmentIds` selects one department,
 * `metadataDate` keeps records updated on or after that day (the day itself
 * included — verified live), and the IDs come back unsorted with `[]` for none.
 */
function objectsPage(url: URL): Response {
  const department = url.searchParams.get('departmentIds');
  const since = url.searchParams.get('metadataDate');
  const ids = RECORDS.filter(
    (r) =>
      (department == null || r.departmentId === Number(department)) &&
      (since == null || r.updated >= since),
  ).map((r) => r.id);
  return jsonResponse({ total: ids.length, objectIDs: scramble(ids) });
}

function upstream(request: unknown): Promise<Response> {
  const url = new URL(String(request));
  if (url.origin === COLLECTION_ORIGIN && url.pathname === OBJECTS_PATH) {
    return Promise.resolve(objectsPage(url));
  }
  if (url.origin === COLLECTION_ORIGIN && url.pathname === DEPARTMENTS_PATH) {
    return Promise.resolve(
      jsonResponse({
        departments: VALID_DEPARTMENT_IDS.map((departmentId) => ({
          departmentId,
          displayName: `Department ${departmentId}`,
        })),
      }),
    );
  }
  return Promise.reject(new Error(`unrouted fetch ${url.origin}${url.pathname}`));
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

interface ListPage {
  nextOffset: number | null;
  notice?: string;
  objectIDs: number[];
  offset: number;
  remaining: number;
  returned: number;
  total: number;
  truncated: boolean;
}

interface ErrorEnvelope {
  code: number;
  data: { reason?: string; recovery?: { hint: string } };
  message: string;
}

/**
 * Arguments as a client sends them. An alias or a malformed value is outside the
 * runner's typed parameter by construction, so the cast lets a test send it.
 */
const list = (args: Record<string, unknown>) =>
  runToolContract(metListObjects, args as unknown as z.input<typeof metListObjects.input>);

function pageOf(result: ToolResult): ListPage {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as ListPage;
}

function errorOf(result: ToolResult): ErrorEnvelope {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

/** Every text block of a tool result's `content[]`, joined. */
function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('met_list_objects (#26)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /** The `/v1/objects` requests the test issued, parsed. */
  const objectsRequests = () =>
    fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname === OBJECTS_PATH);

  beforeEach(() => {
    initMetService({} as AppConfig, createInMemoryStorage());
    fetchMock = vi.fn(upstream);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('an unfiltered call', () => {
    it('returns the upstream count and the lowest IDs ascending, on both surfaces', async () => {
      const result = await list({});

      const page = pageOf(result);
      expect(page).toEqual({
        total: RECORDS.length,
        objectIDs: ALL_IDS_ASCENDING.slice(0, 20),
        returned: 20,
        offset: 0,
        remaining: RECORDS.length - 20,
        truncated: true,
        nextOffset: 20,
      });
      expect(objectsRequests().map((url) => url.search)).toEqual(['']);

      const text = textOf(result);
      expect(text).toContain(`**Total objects:** ${RECORDS.length}`);
      expect(text).toContain('**Returned IDs:** 20 (truncated)');
      expect(text).toContain('**Offset:** 0');
      expect(text).toContain(`**Remaining:** ${RECORDS.length - 20}`);
      expect(text).toContain('**Next offset:** 20');
      expect(text).toContain(ALL_IDS_ASCENDING.slice(0, 20).join(', '));
      expect(text).not.toContain('No objects match');
    });

    it('answers a second identical call inside the TTL from the cache, with no upstream request', async () => {
      const first = pageOf(await list({}));
      const second = pageOf(await list({}));

      expect(second).toEqual(first);
      expect(objectsRequests()).toHaveLength(1);
    });

    it('walks every ID exactly once, ascending, by following nextOffset — one upstream request', async () => {
      const seen: number[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: ListPage = pageOf(await list({ limit: 7, offset }));
        seen.push(...page.objectIDs);
        offset = page.nextOffset;
      }

      expect(seen).toEqual(ALL_IDS_ASCENDING);
      expect(objectsRequests()).toHaveLength(1);
    });
  });

  describe('paging boundaries', () => {
    it('marks the last page (complete), with nextOffset null', async () => {
      const result = await list({ offset: 40 });

      expect(pageOf(result)).toEqual({
        total: 45,
        objectIDs: ALL_IDS_ASCENDING.slice(40),
        returned: 5,
        offset: 40,
        remaining: 0,
        truncated: false,
        nextOffset: null,
      });
      expect(textOf(result)).toContain('**Returned IDs:** 5 (complete)');
      expect(textOf(result)).toContain('**Next offset:** none');
    });

    it.each([45, 46, 10_000, 1_000_000])(
      'returns an empty page marked (offset beyond result set) at offset %i, not an error',
      async (offset) => {
        const result = await list({ offset });

        expect(pageOf(result)).toEqual({
          total: 45,
          objectIDs: [],
          returned: 0,
          offset,
          remaining: 0,
          truncated: false,
          nextOffset: null,
        });
        expect(textOf(result)).toContain('**Returned IDs:** 0 (offset beyond result set)');
      },
    );

    it('pages past 10,000 — there is no search window here', async () => {
      const ids = Array.from({ length: 12_000 }, (_, i) => 12_000 - i);
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ total: ids.length, objectIDs: ids })),
      );

      const page = pageOf(await list({ offset: 11_990, limit: 500 }));

      expect(page.total).toBe(12_000);
      expect(page.objectIDs).toEqual(Array.from({ length: 10 }, (_, i) => 11_991 + i));
      expect(page.nextOffset).toBeNull();
    });

    it('accepts limit 1 and 500, and rejects 0, 501, and a negative offset at the schema', async () => {
      expect(pageOf(await list({ limit: 1 })).objectIDs).toEqual(ALL_IDS_ASCENDING.slice(0, 1));
      expect(pageOf(await list({ limit: 500 })).returned).toBe(45);

      for (const args of [{ limit: 0 }, { limit: 501 }, { offset: -1 }]) {
        expect(errorOf(await list(args)).code).toBe(JsonRpcErrorCode.InvalidParams);
      }
    });
  });

  describe('departmentId', () => {
    it('sends departmentIds and lists that department alone, sorted', async () => {
      const page = pageOf(await list({ departmentId: 10 }));

      expect(page.objectIDs).toEqual([544100, 545138, 555799]);
      expect(page.total).toBe(3);
      const [request] = objectsRequests();
      expect(request?.searchParams.get('departmentIds')).toBe('10');
      expect(request?.searchParams.has('metadataDate')).toBe(false);
    });

    it.each([2, 999])(
      'rejects %i as invalid_department before any /v1/objects request',
      async (departmentId) => {
        const result = await list({ departmentId });

        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_department');
        expect(error.message).toBe(`departmentId ${departmentId} is not a valid Met department.`);
        expect(error.data.recovery?.hint).toContain('met_list_departments');
        const text = textOf(result);
        expect(text).toContain('Recovery: Call met_list_departments');
        expect(text).toContain('reason invalid_department');
        expect(objectsRequests()).toHaveLength(0);
        expect(fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
          DEPARTMENTS_PATH,
        ]);
      },
    );
  });

  describe('updatedSince', () => {
    it('sends the date unchanged as metadataDate and keeps records updated that same day', async () => {
      const result = await list({ departmentId: 10, updatedSince: '2026-09-26' });

      expect(pageOf(result).objectIDs).toEqual([545138, 555799]);
      const [request] = objectsRequests();
      expect(request?.searchParams.get('metadataDate')).toBe('2026-09-26');
      expect(request?.searchParams.get('departmentIds')).toBe('10');
    });

    it('filters the whole collection by update date when no department is set', async () => {
      const page = pageOf(await list({ updatedSince: '2026-09-02' }));

      expect(page.objectIDs).toEqual([437984, 544100, 545138, 555799]);
      expect(objectsRequests()[0]?.searchParams.has('departmentIds')).toBe(false);
    });

    it('reads an empty string as unset — no metadataDate, the same list as no filter', async () => {
      const page = pageOf(await list({ updatedSince: '' }));

      expect(page.total).toBe(RECORDS.length);
      expect(objectsRequests()[0]?.search).toBe('');
    });

    it('accepts the Met API name metadataDate for updatedSince', async () => {
      const page = pageOf(await list({ metadataDate: '2026-09-26' }));

      expect(page.objectIDs).toEqual([545138, 555799]);
    });

    it.each(['2026-09-01T00:00:00', '09/01/2026', '2026-9-1', '20260901'])(
      'rejects %s at the schema, before any request',
      async (updatedSince) => {
        const result = await list({ updatedSince });

        expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(textOf(result)).toContain('updatedSince takes a date as YYYY-MM-DD');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(['2026-02-30', '2026-13-01', '2026-04-31', '2025-02-29', '2026-00-10'])(
      'rejects the impossible calendar date %s as invalid_date, before any request',
      async (updatedSince) => {
        const result = await list({ departmentId: 10, updatedSince });

        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_date');
        expect(error.message).toBe(`updatedSince ${updatedSince} is not a calendar date.`);
        expect(textOf(result)).toContain('Recovery: Pass updatedSince as a real calendar date');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(['2024-02-29', '0050-01-01', '2026-12-31'])(
      'accepts the real calendar date %s',
      async (updatedSince) => {
        expect((await list({ updatedSince })).isError).toBeFalsy();
      },
    );

    it('answers a date after the newest update with total 0 and a notice, not an error', async () => {
      const result = await list({ departmentId: 10, updatedSince: '2026-09-27' });

      expect(pageOf(result)).toEqual({
        total: 0,
        objectIDs: [],
        returned: 0,
        offset: 0,
        remaining: 0,
        truncated: false,
        nextOffset: null,
        notice:
          'No objects match departmentId 10 and updatedSince 2026-09-27. Pass an earlier updatedSince or drop a filter to widen the list.',
      });
      const text = textOf(result);
      expect(text).toContain('**Returned IDs:** 0 (complete)');
      expect(text).toContain('No objects match departmentId 10 and updatedSince 2026-09-27.');
    });

    it('marks an empty list read from a nonzero offset (offset beyond result set), notice kept', async () => {
      const result = await list({ departmentId: 10, updatedSince: '2026-09-27', offset: 50 });

      const page = pageOf(result);
      expect(page).toMatchObject({ total: 0, objectIDs: [], returned: 0, offset: 50 });
      expect(page.notice).toContain(
        'No objects match departmentId 10 and updatedSince 2026-09-27.',
      );
      const text = textOf(result);
      expect(text).toContain('**Returned IDs:** 0 (offset beyond result set)');
      expect(text).toContain('**Offset:** 50');
      expect(text).toContain('No objects match departmentId 10 and updatedSince 2026-09-27.');
    });

    it('reads a null objectIDs answer as an empty list: total 0 and a notice, in one request', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        new URL(String(request)).pathname === OBJECTS_PATH
          ? Promise.resolve(jsonResponse({ total: 0, objectIDs: null }))
          : upstream(request),
      );

      const result = await list({ updatedSince: '2026-09-27' });

      expect(pageOf(result)).toEqual({
        total: 0,
        objectIDs: [],
        returned: 0,
        offset: 0,
        remaining: 0,
        truncated: false,
        nextOffset: null,
        notice:
          'No objects match updatedSince 2026-09-27. Pass an earlier updatedSince to widen the list.',
      });
      const text = textOf(result);
      expect(text).toContain('**Total objects:** 0');
      expect(text).toContain('**Returned IDs:** 0 (complete)');
      expect(text).toContain('No objects match updatedSince 2026-09-27.');
      expect(objectsRequests()).toHaveLength(1);
    });

    it('answers a future date with total 0 and a notice saying the date is after today', async () => {
      const result = await list({ updatedSince: '2999-01-01' });

      const page = pageOf(result);
      expect(page.total).toBe(0);
      expect(page.notice).toBe(
        "No objects match updatedSince 2999-01-01. 2999-01-01 is after today's date (UTC), so no record has been created or revised since then; pass an earlier updatedSince.",
      );
      expect(textOf(result)).toContain("2999-01-01 is after today's date (UTC)");
    });
  });

  describe('the cache key', () => {
    it('keeps each filter set apart: department, date, and both together are three lists', async () => {
      await list({ departmentId: 10 });
      await list({ updatedSince: '2026-09-26' });
      await list({ departmentId: 10, updatedSince: '2026-09-26' });
      await list({ departmentId: 10 });
      await list({ departmentId: 10, updatedSince: '2026-09-26', offset: 1, limit: 1 });

      expect(objectsRequests().map((url) => url.search)).toEqual([
        '?departmentIds=10',
        '?metadataDate=2026-09-26',
        '?departmentIds=10&metadataDate=2026-09-26',
      ]);
    });
  });

  describe('concurrent callers', () => {
    /** Holds the `/v1/objects` answer until `release()`; departments answer at once. */
    function heldUpstream() {
      const held = Promise.withResolvers<void>();
      fetchMock.mockImplementation(async (request: unknown) => {
        if (new URL(String(request)).pathname === OBJECTS_PATH) await held.promise;
        return upstream(request);
      });
      return () => held.resolve();
    }

    it('share one upstream request for one filter set', async () => {
      const release = heldUpstream();

      const pending = [list({ departmentId: 10 }), list({ departmentId: 10, offset: 1 })];
      await vi.waitFor(() => expect(objectsRequests()).toHaveLength(1));
      release();
      const [first, second] = await Promise.all(pending);

      expect(pageOf(first as ToolResult).objectIDs).toEqual([544100, 545138, 555799]);
      expect(pageOf(second as ToolResult).objectIDs).toEqual([545138, 555799]);
      expect(objectsRequests()).toHaveLength(1);
    });

    it('cancelling one caller leaves the other’s result intact', async () => {
      const release = heldUpstream();
      const controller = new AbortController();

      const cancelled = runToolContract(
        metListObjects,
        { departmentId: 10 },
        { context: { signal: controller.signal } },
      );
      const kept = list({ departmentId: 10 });
      await vi.waitFor(() => expect(objectsRequests()).toHaveLength(1));
      controller.abort();

      expect(errorOf(await cancelled).code).toBe(JsonRpcErrorCode.RequestCancelled);
      release();
      expect(pageOf(await kept).objectIDs).toEqual([544100, 545138, 555799]);
      // The shared load finished and was cached despite the cancellation.
      pageOf(await list({ departmentId: 10 }));
      expect(objectsRequests()).toHaveLength(1);
    });
  });

  describe('format()', () => {
    const page = {
      total: 3,
      objectIDs: [544100, 545138],
      returned: 2,
      offset: 0,
      remaining: 1,
      truncated: true,
      nextOffset: 2,
    };
    const render = (result: z.output<typeof metListObjects.output>) =>
      (metListObjects.format!(result)[0] as { text: string }).text;

    it('renders every output field', () => {
      expect(render(page)).toBe(
        [
          '**Total objects:** 3',
          '**Returned IDs:** 2 (truncated)',
          '**Offset:** 0',
          '**Remaining:** 1',
          '**Next offset:** 2',
          '',
          '**Object IDs:**',
          '544100, 545138',
        ].join('\n'),
      );
    });

    it('marks an empty list read from offset 0 (complete), not beyond the result set', () => {
      const text = render({
        total: 0,
        objectIDs: [],
        returned: 0,
        offset: 0,
        remaining: 0,
        truncated: false,
        nextOffset: null,
      });
      expect(text).toContain('**Returned IDs:** 0 (complete)');
    });

    it('marks an empty list read from a nonzero offset (offset beyond result set)', () => {
      const text = render({
        total: 0,
        objectIDs: [],
        returned: 0,
        offset: 50,
        remaining: 0,
        truncated: false,
        nextOffset: null,
      });
      expect(text).toContain('**Returned IDs:** 0 (offset beyond result set)');
    });
  });
});
