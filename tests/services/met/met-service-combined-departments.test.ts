/**
 * @fileoverview `met_search_collections` for the two departments the Met's
 * search answers as one combined result set, 7 (The Cloisters) and 17 (Medieval
 * Art) (#39). Each page keeps only the requested department's IDs, read from
 * the cached sorted `/v1/objects?departmentIds=` list, while `total` and the
 * paging fields stay in the combined result space. Every other department, and
 * a search with none, is pinned to its prior requests and output. Runs the real
 * service — the list cache, the shared load, the retry ladder, and the call
 * deadline included — over a faked global fetch, through `runToolContract`.
 * @module tests/services/met/met-service-combined-departments.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';
import { initMetService } from '@/services/met/met-service.js';

const COLLECTION = 'https://collectionapi.metmuseum.org/public/collection';
const SEARCH_PATH = '/public/collection/v1.1/search';
const DEPARTMENTS_PATH = '/public/collection/v1/departments';
const LIST_PATH = '/public/collection/v1/objects';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** The department roster the validation lookup reads. */
const departmentsBody = () =>
  jsonResponse({
    departments: [
      { departmentId: 7, displayName: 'The Cloisters' },
      { departmentId: 11, displayName: 'European Paintings' },
      { departmentId: 17, displayName: 'Medieval Art' },
    ],
  });

/** One page of `ids` (relevance order), shaped as `/v1.1/search` answers it: `null` when empty. */
function searchPage(url: URL, ids: readonly number[]): Response {
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  const page = ids.slice(offset, Math.min(offset + limit, 10_000));
  return jsonResponse({ total: ids.length, objectIDs: page.length > 0 ? page : null });
}

/** The pathname of a fetch call's URL. */
const pathOf = (request: unknown) => new URL(String(request)).pathname;

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block of a tool result's `content[]`, joined — the enrichment trailer included. */
function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The exact `content[]` of a success: the `format()` block, then the enrichment trailer. */
const contentOf = (formatLines: string[], trailer: string) => [
  { type: 'text', text: formatLines.join('\n') },
  { type: 'text', text: `\n\n${trailer}` },
];

/** Department 7's `/v1/objects` list: the five Unicorn Tapestries, The Cloisters only. */
const CLOISTERS_IDS = [467638, 467639, 467640, 467641, 467642];
/** Department 17's `/v1/objects` list. */
const MEDIEVAL_IDS = [464100, 464101, 464102, 464103, 464104, 464105, 464106];
/** In the search index but on neither department's list — such an ID 404s on met_get_object. */
const INDEX_ONLY = 999_001;
/**
 * The one result set `/v1.1/search` answers for `departmentId` 7 and 17 alike, in
 * relevance order: both departments interleaved, out of ID order, plus an
 * index-only ID. Thirteen positions, so a two-ID walk ends on a short page.
 */
const COMBINED = [
  464100,
  464101,
  467638,
  464102,
  INDEX_ONLY,
  464105,
  467639,
  464104,
  464103,
  464106,
  467641,
  467640,
  467642,
];

/** A department's `/v1/objects` answer, in the scrambled order the upstream sends. */
function listBody(departmentId: number): Response {
  const ids = departmentId === 7 ? CLOISTERS_IDS : departmentId === 17 ? MEDIEVAL_IDS : [];
  return jsonResponse({ total: ids.length, objectIDs: [...ids].reverse() });
}

type Fetch = (request: unknown, init?: RequestInit) => Promise<Response>;

/**
 * The collection host: the department roster, a search over `COMBINED`, and each
 * department's list, each replaceable. Any other request rejects.
 */
function upstream(overrides: { search?: Fetch; list?: Fetch } = {}): Fetch {
  const search: Fetch =
    overrides.search ??
    ((request) => Promise.resolve(searchPage(new URL(String(request)), COMBINED)));
  const list: Fetch =
    overrides.list ??
    ((request) =>
      Promise.resolve(
        listBody(Number(new URL(String(request)).searchParams.get('departmentIds'))),
      ));
  return (request, init) => {
    const url = new URL(String(request));
    if (url.pathname === DEPARTMENTS_PATH) return Promise.resolve(departmentsBody());
    if (url.pathname === SEARCH_PATH) return search(request, init);
    if (url.pathname === LIST_PATH) return list(request, init);
    return Promise.reject(new Error(`unrouted fetch ${url.href}`));
  };
}

/** A request that never answers until its signal aborts, as a hung `fetch` behaves. */
const neverAnswers: Fetch = (_request, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason));
  });

/** An HTML error page exchange with `status`, minted per attempt. */
const errorPage =
  (status: number): Fetch =>
  () =>
    Promise.resolve(
      new Response('<html><body>error page</body></html>', {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );

/** The opening every 7/17 notice shares. */
const COMBINED_SET =
  "The Met's search returns departments 7 (The Cloisters) and 17 (Medieval Art) as one combined result set";

/** The notice on a 7/17 page the department filter narrowed. */
const filteredNotice = (departmentId: number) =>
  `${COMBINED_SET}: total counts matches in both, and offset, remaining, and nextOffset step through that combined set. objectIDs keeps only department ${departmentId}'s matches, so a page can hold fewer than limit IDs, or none, while more remain; keep paging until nextOffset is null. For exact department membership, use met_list_objects with departmentId ${departmentId}.`;

/** The notice on a 7/17 page left unfiltered because the department list could not be loaded. */
const unfilteredNotice = (departmentId: number) =>
  `${COMBINED_SET}, and total counts matches in both. Department ${departmentId}'s object list could not be loaded, so the department filter was not applied: objectIDs holds this page's matches from both departments. Retry later to filter them, or use met_list_objects with departmentId ${departmentId} for exact department membership.`;

/** The success fields of a search result's `structuredContent`. */
interface SearchPage {
  effectiveQuery?: string;
  nextOffset: number | null;
  notice?: string;
  objectIDs: number[];
  offset: number;
  remaining: number;
  returned: number;
  total: number;
  truncated: boolean;
}

function pageOf(result: ToolResult): SearchPage {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as unknown as SearchPage;
}

interface ErrorEnvelope {
  code: number;
  data: Record<string, unknown>;
  message: string;
}

function errorOf(result: ToolResult): ErrorEnvelope {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

describe('met_search_collections — departments 7 and 17 share one search result set (#39)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initMetService({} as AppConfig, createInMemoryStorage());
    fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Every request URL a test issued, in order. */
  const requested = () => fetchMock.mock.calls.map((call) => new URL(String(call[0])).href);

  /**
   * Characterization: these cases pin the requests and both surfaces as they
   * stood before the 7/17 filter, so the filter provably leaves every other
   * department, and a search with none, byte-identical.
   */
  describe('every other department, and no department, is unchanged', () => {
    /** Thirteen matches, so a five-ID page walk ends on a short page. */
    const MATCHES = Array.from({ length: 13 }, (_, i) => 436_100 + i);

    beforeEach(() => {
      fetchMock.mockImplementation((request: unknown) => {
        const url = new URL(String(request));
        if (url.pathname === DEPARTMENTS_PATH) return Promise.resolve(departmentsBody());
        if (url.pathname === SEARCH_PATH) return Promise.resolve(searchPage(url, MATCHES));
        return Promise.reject(new Error(`unrouted fetch ${url.href}`));
      });
    });

    it('departmentId 11: the lookup and one search, the page as the Met answered it, no notice', async () => {
      const result = await runToolContract(metSearchCollections, {
        q: 'tapestry',
        departmentId: 11,
        limit: 5,
      });

      expect(requested()).toEqual([
        `${COLLECTION}/v1/departments`,
        `${COLLECTION}/v1.1/search?q=tapestry&offset=0&limit=5&departmentId=11`,
      ]);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        total: 13,
        objectIDs: [436100, 436101, 436102, 436103, 436104],
        returned: 5,
        truncated: true,
        remaining: 8,
        nextOffset: 5,
        offset: 0,
        effectiveQuery: 'q="tapestry", departmentId=11',
      });
      expect(result.content).toEqual(
        contentOf(
          [
            '**Total matches:** 13',
            '**Returned IDs:** 5 (truncated)',
            '**Offset:** 0',
            '**Remaining:** 8',
            '**Next offset:** 5',
            '',
            '**Object IDs:**',
            '436100, 436101, 436102, 436103, 436104',
          ],
          'Query: q="tapestry", departmentId=11',
        ),
      );
    });

    it('departmentId 11: the short last page advances by what it read', async () => {
      const result = await runToolContract(metSearchCollections, {
        q: 'tapestry',
        departmentId: 11,
        limit: 5,
        offset: 10,
      });

      expect(requested()).toEqual([
        `${COLLECTION}/v1/departments`,
        `${COLLECTION}/v1.1/search?q=tapestry&offset=10&limit=5&departmentId=11`,
      ]);
      expect(result.structuredContent).toEqual({
        total: 13,
        objectIDs: [436110, 436111, 436112],
        returned: 3,
        truncated: false,
        remaining: 0,
        nextOffset: null,
        offset: 10,
        effectiveQuery: 'q="tapestry", departmentId=11',
      });
      expect(result.content).toEqual(
        contentOf(
          [
            '**Total matches:** 13',
            '**Returned IDs:** 3 (complete)',
            '**Offset:** 10',
            '**Remaining:** 0',
            '**Next offset:** none',
            '',
            '**Object IDs:**',
            '436110, 436111, 436112',
          ],
          'Query: q="tapestry", departmentId=11',
        ),
      );
    });

    it('no departmentId: one search, no lookup, no notice', async () => {
      const result = await runToolContract(metSearchCollections, { q: 'tapestry', limit: 5 });

      expect(requested()).toEqual([`${COLLECTION}/v1.1/search?q=tapestry&offset=0&limit=5`]);
      expect(result.structuredContent).toEqual({
        total: 13,
        objectIDs: [436100, 436101, 436102, 436103, 436104],
        returned: 5,
        truncated: true,
        remaining: 8,
        nextOffset: 5,
        offset: 0,
        effectiveQuery: 'q="tapestry"',
      });
      expect(result.content).toEqual(
        contentOf(
          [
            '**Total matches:** 13',
            '**Returned IDs:** 5 (truncated)',
            '**Offset:** 0',
            '**Remaining:** 8',
            '**Next offset:** 5',
            '',
            '**Object IDs:**',
            '436100, 436101, 436102, 436103, 436104',
          ],
          'Query: q="tapestry"',
        ),
      );
    });

    it('never requests a department list, however many pages are read', async () => {
      for (const offset of [0, 5, 10]) {
        await runToolContract(metSearchCollections, {
          q: 'tapestry',
          departmentId: 11,
          limit: 5,
          offset,
        });
      }
      await runToolContract(metSearchCollections, { q: 'tapestry', limit: 5 });

      expect(fetchMock.mock.calls.map((call) => pathOf(call[0]))).not.toContain(LIST_PATH);
    });
  });

  /** One 7/17 search page over the faked host. */
  const search = (
    departmentId: number,
    args: { limit?: number; offset?: number; q?: string } = {},
  ) => runToolContract(metSearchCollections, { q: 'tapestry', departmentId, ...args });

  /** The paths of the requests a test issued, in order. */
  const paths = () => fetchMock.mock.calls.map((call) => pathOf(call[0]));

  /** How many `/v1/objects` list requests a test issued. */
  const listRequests = () => paths().filter((path) => path === LIST_PATH).length;

  describe('each page keeps only the requested department, paging in the combined space', () => {
    it('departmentId 7: department 7 IDs only, the search first, then its list, on both surfaces', async () => {
      fetchMock.mockImplementation(upstream());

      const result = await search(7, { limit: 5 });

      expect(requested()).toEqual([
        `${COLLECTION}/v1/departments`,
        `${COLLECTION}/v1.1/search?q=tapestry&offset=0&limit=5&departmentId=7`,
        `${COLLECTION}/v1/objects?departmentIds=7`,
      ]);
      expect(pageOf(result)).toEqual({
        total: 13,
        objectIDs: [467638],
        returned: 1,
        truncated: true,
        remaining: 8,
        nextOffset: 5,
        offset: 0,
        notice: filteredNotice(7),
        effectiveQuery: 'q="tapestry", departmentId=7',
      });
      expect(result.content?.[0]).toEqual({
        type: 'text',
        text: [
          '**Total matches:** 13',
          '**Returned IDs:** 1 (truncated)',
          '**Offset:** 0',
          '**Remaining:** 8',
          '**Next offset:** 5',
          '',
          '**Object IDs:**',
          '467638',
        ].join('\n'),
      });
      const text = textOf(result);
      expect(text).toContain(`> ${filteredNotice(7)}`);
      expect(text).toContain('Query: q="tapestry", departmentId=7');
    });

    it('departmentId 17: department 17 IDs only from the same combined page, the index-only ID dropped', async () => {
      fetchMock.mockImplementation(upstream());

      const result = await search(17, { limit: 5 });

      expect(requested()).toEqual([
        `${COLLECTION}/v1/departments`,
        `${COLLECTION}/v1.1/search?q=tapestry&offset=0&limit=5&departmentId=17`,
        `${COLLECTION}/v1/objects?departmentIds=17`,
      ]);
      expect(pageOf(result)).toEqual({
        total: 13,
        objectIDs: [464100, 464101, 464102],
        returned: 3,
        truncated: true,
        remaining: 8,
        nextOffset: 5,
        offset: 0,
        notice: filteredNotice(17),
        effectiveQuery: 'q="tapestry", departmentId=17',
      });
      expect(textOf(result)).toContain('**Returned IDs:** 3 (truncated)');
      expect(textOf(result)).toContain(`> ${filteredNotice(17)}`);
    });

    it('advances by the combined positions a short page read, not by limit or by returned', async () => {
      // The upstream answers four IDs to a five-ID request, one of them department 7's.
      fetchMock.mockImplementation(
        upstream({
          search: () =>
            Promise.resolve(jsonResponse({ total: 13, objectIDs: COMBINED.slice(0, 4) })),
        }),
      );

      const page = pageOf(await search(7, { limit: 5 }));

      expect(page).toMatchObject({
        objectIDs: [467638],
        returned: 1,
        truncated: true,
        remaining: 9,
        nextOffset: 4,
      });
    });

    it('returns an all-filtered page as objectIDs [], truncated, and a nextOffset — never the zero-match guidance', async () => {
      fetchMock.mockImplementation(upstream());

      const result = await search(7, { limit: 2 });

      expect(pageOf(result)).toEqual({
        total: 13,
        objectIDs: [],
        returned: 0,
        truncated: true,
        remaining: 11,
        nextOffset: 2,
        offset: 0,
        notice: filteredNotice(7),
        effectiveQuery: 'q="tapestry", departmentId=7',
      });
      const text = textOf(result);
      expect(text).toContain('**Returned IDs:** 0 (truncated)');
      expect(text).toContain('**Next offset:** 2');
      expect(text).not.toContain('matches no object');
      expect(text).not.toContain('removed every match');
      // No keyword-only count: that request belongs to the Met's total of 0 alone.
      expect(paths().filter((path) => path === SEARCH_PATH)).toHaveLength(1);
    });

    it('walks nextOffset to the end reading every combined position once, each department its own IDs', async () => {
      fetchMock.mockImplementation(upstream());

      /** Every page from offset 0 until nextOffset is null. */
      const walk = async (departmentId: number) => {
        const pages: SearchPage[] = [];
        let offset: number | null = 0;
        while (offset !== null && pages.length < 20) {
          const page = pageOf(await search(departmentId, { limit: 2, offset }));
          pages.push(page);
          offset = page.nextOffset;
        }
        return pages;
      };

      const cloisters = await walk(7);
      const medieval = await walk(17);

      for (const pages of [cloisters, medieval]) {
        expect(pages.map((page) => page.offset)).toEqual([0, 2, 4, 6, 8, 10, 12]);
        // Each page starts where the previous one's nextOffset pointed.
        for (const [i, page] of pages.slice(1).entries()) {
          expect(page.offset).toBe(pages[i]?.nextOffset);
        }
        // Positions read per page — nextOffset (or total, on the last page) minus offset — cover all 13 once.
        const read = pages.map((page) => (page.nextOffset ?? page.total) - page.offset);
        expect(read).toEqual([2, 2, 2, 2, 2, 2, 1]);
        expect(read.reduce((sum, n) => sum + n, 0)).toBe(13);
        expect(pages.map((page) => page.truncated)).toEqual([
          true,
          true,
          true,
          true,
          true,
          true,
          false,
        ]);
        expect(pages.map((page) => page.remaining)).toEqual([11, 9, 7, 5, 3, 1, 0]);
        expect(pages.every((page) => page.total === 13)).toBe(true);
      }

      // Department 7: its five IDs, in relevance order, the empty parts included.
      expect(cloisters.map((page) => page.objectIDs)).toEqual([
        [],
        [467638],
        [],
        [467639],
        [],
        [467641, 467640],
        [467642],
      ]);
      expect(cloisters.map((page) => page.returned)).toEqual([0, 1, 0, 1, 0, 2, 1]);
      // Department 17: its seven IDs; its last page reads one position and keeps none.
      expect(medieval.map((page) => page.objectIDs)).toEqual([
        [464100, 464101],
        [464102],
        [464105],
        [464104],
        [464103, 464106],
        [],
        [],
      ]);

      const cloistersIds = cloisters.flatMap((page) => page.objectIDs);
      const medievalIds = medieval.flatMap((page) => page.objectIDs);
      expect([...cloistersIds].sort()).toEqual(CLOISTERS_IDS);
      expect([...medievalIds].sort()).toEqual(MEDIEVAL_IDS);
      expect(cloistersIds.filter((id) => medievalIds.includes(id))).toEqual([]);
      expect([...cloistersIds, ...medievalIds]).not.toContain(INDEX_ONLY);

      // Fourteen searches, one roster lookup, and one list per department for the whole walk.
      expect(paths().filter((path) => path === SEARCH_PATH)).toHaveLength(14);
      expect(paths().filter((path) => path === DEPARTMENTS_PATH)).toHaveLength(1);
      expect(
        fetchMock.mock.calls
          .map((call) => new URL(String(call[0])))
          .filter((url) => url.pathname === LIST_PATH)
          .map((url) => url.searchParams.get('departmentIds')),
      ).toEqual(['7', '17']);
    });

    it('marks the last 7/17 page (complete) even when it keeps no ID', async () => {
      fetchMock.mockImplementation(upstream());

      const result = await search(17, { limit: 2, offset: 12 });

      expect(pageOf(result)).toMatchObject({
        objectIDs: [],
        returned: 0,
        truncated: false,
        remaining: 0,
        nextOffset: null,
      });
      expect(textOf(result)).toContain('**Returned IDs:** 0 (complete)');
    });
  });

  describe('the department list is requested once per cache lifetime', () => {
    /** The list cache's TTL: one hour. */
    const TTL_MS = 60 * 60 * 1000;

    it('a second call inside the TTL sends only the search; the first call past it reloads the list', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const loadedAt = Date.now();
      fetchMock.mockImplementation(upstream());

      await search(7, { limit: 5 });
      expect(paths()).toEqual([DEPARTMENTS_PATH, SEARCH_PATH, LIST_PATH]);

      fetchMock.mockClear();
      vi.setSystemTime(loadedAt + TTL_MS - 1);
      const cached = pageOf(await search(7, { limit: 5, offset: 5 }));
      expect(paths()).toEqual([SEARCH_PATH]);
      expect(cached.objectIDs).toEqual([467639]);

      fetchMock.mockClear();
      vi.setSystemTime(loadedAt + TTL_MS);
      await search(7, { limit: 5 });
      expect(paths()).toEqual([DEPARTMENTS_PATH, SEARCH_PATH, LIST_PATH]);
    });

    it('shares the list met_list_objects caches for the same department', async () => {
      fetchMock.mockImplementation(upstream());
      const { metListObjects } = await import(
        '@/mcp-server/tools/definitions/met-list-objects.tool.js'
      );

      await runToolContract(metListObjects, { departmentId: 7 });
      fetchMock.mockClear();
      const page = pageOf(await search(7, { limit: 5 }));

      expect(paths()).toEqual([SEARCH_PATH]);
      expect(page.objectIDs).toEqual([467638]);
    });

    it('never reads a list met_list_objects cached under updatedSince', async () => {
      fetchMock.mockImplementation(
        upstream({
          list: (request) => {
            const url = new URL(String(request));
            return Promise.resolve(
              url.searchParams.has('metadataDate')
                ? jsonResponse({ total: 1, objectIDs: [467642] })
                : listBody(Number(url.searchParams.get('departmentIds'))),
            );
          },
        }),
      );
      const { metListObjects } = await import(
        '@/mcp-server/tools/definitions/met-list-objects.tool.js'
      );

      await runToolContract(metListObjects, { departmentId: 7, updatedSince: '2026-09-01' });
      fetchMock.mockClear();
      const page = pageOf(await search(7, { limit: 5 }));

      expect(requested()).toEqual([
        `${COLLECTION}/v1.1/search?q=tapestry&offset=0&limit=5&departmentId=7`,
        `${COLLECTION}/v1/objects?departmentIds=7`,
      ]);
      expect(page.objectIDs).toEqual([467638]);
    });

    it('sends no list request for a page with no IDs to narrow', async () => {
      fetchMock.mockImplementation(upstream());

      const result = await search(7, { offset: 13 });

      expect(paths()).toEqual([DEPARTMENTS_PATH, SEARCH_PATH]);
      expect(pageOf(result)).toMatchObject({
        objectIDs: [],
        returned: 0,
        offset: 13,
        notice: filteredNotice(7),
      });
      expect(textOf(result)).toContain('**Returned IDs:** 0 (offset beyond result set)');
    });
  });

  describe('the department notice joins the other notices into one string', () => {
    it('follows the zero-match guidance on a total of 0, with no list request', async () => {
      fetchMock.mockImplementation(
        upstream({
          search: (request) => Promise.resolve(searchPage(new URL(String(request)), [])),
        }),
      );

      const result = await search(7, { q: 'zzznomatch' });

      const notice = `The keyword "zzznomatch" matches no object in the collection, even with no filter applied. Try a different, broader, or differently spelled keyword. ${filteredNotice(7)}`;
      expect(pageOf(result)).toMatchObject({ total: 0, objectIDs: [], notice });
      expect(textOf(result)).toContain(`> ${notice}`);
      expect(listRequests()).toBe(0);
    });

    it('follows the 10,000-window notice when the combined total exceeds it', async () => {
      const matches = Array.from({ length: 12_000 }, (_, i) => 500_000 + i);
      fetchMock.mockImplementation(
        upstream({
          search: (request) => Promise.resolve(searchPage(new URL(String(request)), matches)),
          list: () => Promise.resolve(jsonResponse({ total: 2, objectIDs: [500_003, 500_001] })),
        }),
      );

      const result = await search(7, { q: '*', limit: 5 });

      const notice = `Only the first 10,000 of 12,000 matches are reachable by paging. Narrow the search with filters or a more specific keyword to reach the rest. ${filteredNotice(7)}`;
      expect(pageOf(result)).toMatchObject({
        total: 12_000,
        objectIDs: [500_001, 500_003],
        returned: 2,
        remaining: 9995,
        nextOffset: 5,
        notice,
      });
      expect(textOf(result)).toContain(`> ${notice}`);
    });
  });

  /**
   * The filter is best-effort: a list that cannot be loaded leaves the combined
   * page as the Met answered it, with a notice saying so. Fake timers carry the
   * list's retry ladder and the call deadline.
   */
  describe('a department list that cannot be loaded leaves the page unfiltered, with a notice', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    /** Run `start` to completion under fake timers. */
    async function settle<T>(start: () => Promise<T>): Promise<T> {
      const pending = start();
      await vi.runAllTimersAsync();
      return await pending;
    }

    /** The unfiltered first five-ID page of the combined set. */
    const unfilteredPage = {
      total: 13,
      objectIDs: COMBINED.slice(0, 5),
      returned: 5,
      truncated: true,
      remaining: 8,
      nextOffset: 5,
      offset: 0,
      notice: unfilteredNotice(7),
      effectiveQuery: 'q="tapestry", departmentId=7',
    };

    it('after a 5xx outage outlasts the list ladder (upstream_unavailable)', async () => {
      fetchMock.mockImplementation(upstream({ list: errorPage(503) }));

      const result = await settle(() => search(7, { limit: 5 }));

      expect(pageOf(result)).toEqual(unfilteredPage);
      const text = textOf(result);
      expect(text).toContain('**Returned IDs:** 5 (truncated)');
      expect(text).toContain(`> ${unfilteredNotice(7)}`);
      expect(text).not.toContain('error page');
      expect(listRequests()).toBe(4);
    });

    it('sends no list request for a minute after a failed load, then asks again', async () => {
      fetchMock.mockImplementation(upstream({ list: errorPage(503) }));

      expect(pageOf(await settle(() => search(7, { limit: 5 })))).toEqual(unfilteredPage);
      expect(listRequests()).toBe(4);

      fetchMock.mockClear();
      const next = pageOf(await settle(() => search(7, { limit: 5, offset: 5 })));
      expect(next.notice).toBe(unfilteredNotice(7));
      expect(next.objectIDs).toEqual(COMBINED.slice(5, 10));
      expect(paths()).toEqual([SEARCH_PATH]);

      fetchMock.mockClear();
      fetchMock.mockImplementation(upstream());
      vi.setSystemTime(Date.now() + 60 * 1000);
      const recovered = pageOf(await settle(() => search(7, { limit: 5 })));
      expect(recovered.objectIDs).toEqual([467638]);
      expect(listRequests()).toBe(1);
    });

    it('filters again as soon as met_list_objects loads the list after a failure', async () => {
      fetchMock.mockImplementation(upstream({ list: errorPage(403) }));
      await settle(() => search(7, { limit: 5 }));

      fetchMock.mockImplementation(upstream());
      const { metListObjects } = await import(
        '@/mcp-server/tools/definitions/met-list-objects.tool.js'
      );
      await settle(() => runToolContract(metListObjects, { departmentId: 7 }));
      fetchMock.mockClear();
      const page = pageOf(await settle(() => search(7, { limit: 5 })));

      expect(page.objectIDs).toEqual([467638]);
      expect(paths()).toEqual([SEARCH_PATH]);
    });

    it('remembers a failed load per department: department 17 still asks for its own list', async () => {
      fetchMock.mockImplementation(
        upstream({
          list: (request) =>
            new URL(String(request)).searchParams.get('departmentIds') === '7'
              ? errorPage(403)(request)
              : Promise.resolve(listBody(17)),
        }),
      );
      await settle(() => search(7, { limit: 5 }));
      fetchMock.mockClear();

      const page = pageOf(await settle(() => search(17, { limit: 5 })));

      expect(page.objectIDs).toEqual([464100, 464101, 464102]);
      expect(listRequests()).toBe(1);
    });

    it('arms the same wait when a met_list_objects load of the department fails', async () => {
      fetchMock.mockImplementation(upstream({ list: errorPage(403) }));
      const { metListObjects } = await import(
        '@/mcp-server/tools/definitions/met-list-objects.tool.js'
      );
      await settle(() => runToolContract(metListObjects, { departmentId: 7 }));
      fetchMock.mockImplementation(upstream());
      fetchMock.mockClear();

      const page = pageOf(await settle(() => search(7, { limit: 5 })));

      expect(page.notice).toBe(unfilteredNotice(7));
      expect(paths()).toEqual([SEARCH_PATH]);
    });

    it('after a firewall 403 (upstream_blocked), with one list request and no retry', async () => {
      fetchMock.mockImplementation(upstream({ list: errorPage(403) }));

      const result = await settle(() => search(7, { limit: 5 }));

      expect(pageOf(result)).toEqual(unfilteredPage);
      expect(listRequests()).toBe(1);
    });

    it('waits on a hung list for one request timeout, then answers unfiltered: a success, not a timeout', async () => {
      fetchMock.mockImplementation(upstream({ list: neverAnswers }));

      const startedAt = Date.now();
      let settledAt = 0;
      const result = await settle(() =>
        search(7, { limit: 5 }).then((value) => {
          settledAt = Date.now();
          return value;
        }),
      );

      expect(pageOf(result)).toEqual(unfilteredPage);
      expect(settledAt - startedAt).toBe(10_000);
    });

    it('a caller abort while waiting on the list cancels the call, never an unfiltered success', async () => {
      fetchMock.mockImplementation(upstream({ list: neverAnswers }));
      const controller = new AbortController();

      const pending = runToolContract(
        metSearchCollections,
        { q: 'tapestry', departmentId: 7, limit: 5 },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(listRequests()).toBe(1);
      controller.abort();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(textOf(result)).not.toContain(COMBINED_SET);
    });

    it('a failed search still fails the call, and no list is requested', async () => {
      fetchMock.mockImplementation(upstream({ search: errorPage(403) }));

      const result = await settle(() => search(7, { limit: 5 }));

      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_blocked' },
      });
      expect(listRequests()).toBe(0);
    });
  });
});
