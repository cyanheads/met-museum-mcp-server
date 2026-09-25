/**
 * @fileoverview Tests for MetService — `/v1.1/search` paging and its 10,000
 * window, retry of Timeout-coded failures, the keyword-only count behind the
 * `no_results` hint, cached department-ID validation, and object normalization.
 * Exercises the real service with a mocked global fetch; the search-tool cases
 * here run the tool over that real service through `runToolContract`, the seam
 * that includes the URL building and window arithmetic under test.
 * @module tests/services/met/met-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { metGetObject } from '@/mcp-server/tools/definitions/met-get-object.tool.js';
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

const COLLECTION_ORIGIN = 'https://collectionapi.metmuseum.org';
const SEARCH_PATH = '/public/collection/v1.1/search';
const DEPARTMENTS_PATH = '/public/collection/v1/departments';

/** The parameters every search request carries; anything else is a filter. */
const PAGING_PARAMS = new Set(['q', 'offset', 'limit']);

/**
 * One `/v1.1/search` page over `total` sequential matches (IDs 1..total), shaped
 * the way the upstream answers: `offset`/`limit` read off the request, the page
 * clipped at the 10,000 window, and `objectIDs: null` for an empty page while
 * `total` stays the full count.
 */
function searchPage(url: URL, total: number): Response {
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  const end = Math.min(offset + limit, total, 10_000);
  const objectIDs = Array.from({ length: Math.max(0, end - offset) }, (_, i) => offset + i + 1);
  return jsonResponse({ total, objectIDs: objectIDs.length > 0 ? objectIDs : null });
}

/**
 * A fetch fake over the collection host, dispatching on origin + pathname. Any
 * request no handler claims rejects, so a stray endpoint fails the test.
 */
function routes(handlers: Record<string, (url: URL) => Response>) {
  return (request: unknown) => {
    const url = new URL(String(request));
    const handler = url.origin === COLLECTION_ORIGIN ? handlers[url.pathname] : undefined;
    return handler
      ? Promise.resolve(handler(url))
      : Promise.reject(new Error(`unrouted fetch ${url.origin}${url.pathname}`));
  };
}

/** `/v1.1/search` serving `total` sequential matches for every query. */
const searchUpstream = (total: number) =>
  routes({ [SEARCH_PATH]: (url) => searchPage(url, total) });

/** The search requests a test issued, parsed. */
function searchRequests(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls
    .map((call) => new URL(String(call[0])))
    .filter((url) => url.pathname === SEARCH_PATH);
}

/** Every text block of a tool result's `content[]`, joined. */
function textOf(result: { content?: { type: string }[] }): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Live object shapes, trimmed to the fields `normalizeObject` reads. Captured
 * from `https://collectionapi.metmuseum.org/public/collection/v1/objects/<id>`
 * rather than hand-invented, so the sparsity each one exercises is the API's.
 */
const rawObjects = {
  /** 487659 — a tag with a null `AAT_URL` beside three fully populated siblings. */
  nullTagUrl: {
    objectID: 487659,
    title: 'Indian Hunter and His Dog',
    isPublicDomain: false,
    primaryImage: '',
    primaryImageSmall: '',
    additionalImages: [],
    objectURL: 'https://www.metmuseum.org/art/collection/search/487659',
    department: 'Modern and Contemporary Art',
    objectName: 'Sculpture',
    classification: 'Sculpture',
    isHighlight: false,
    isTimelineWork: false,
    artistDisplayName: 'Paul Manship',
    artistDisplayBio: 'American, St. Paul, Minnesota 1885–1966 New York',
    artistNationality: 'American',
    artistBeginDate: '1885',
    artistEndDate: '1966',
    constituents: [
      {
        constituentID: 162095,
        role: 'Artist',
        name: 'Paul Manship',
        constituentULAN_URL: 'http://vocab.getty.edu/page/ulan/500032239',
        constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q3371768',
        gender: '',
      },
    ],
    objectDate: '1926',
    objectBeginDate: 1926,
    objectEndDate: 1926,
    medium: 'Bronze',
    dimensions: '21 1/2 × 23 1/2 × 8 1/8 in. (54.6 × 59.7 × 20.6 cm)',
    culture: '',
    period: '',
    dynasty: '',
    accessionNumber: '29.162',
    creditLine: 'Gift of Thomas Cochran, 1929',
    country: '',
    region: '',
    tags: [
      {
        term: 'Bow and Arrow',
        AAT_URL: null,
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q19827042',
      },
      {
        term: 'Men',
        AAT_URL: 'http://vocab.getty.edu/page/aat/300025928',
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q8441',
      },
      {
        term: 'Hunting',
        AAT_URL: 'http://vocab.getty.edu/page/aat/300239666',
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q36963',
      },
      {
        term: 'Dogs',
        AAT_URL: 'http://vocab.getty.edu/page/aat/300265714',
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q144',
      },
    ],
    objectWikidata_URL: 'https://www.wikidata.org/wiki/Q116411921',
    GalleryNumber: '765',
  },

  /** 436535 — every tag URL populated; a genuine CE date. */
  populated: {
    objectID: 436535,
    title: 'Wheat Field with Cypresses',
    isPublicDomain: true,
    primaryImage: 'https://images.metmuseum.org/CRDImages/ep/original/DT1567.jpg',
    primaryImageSmall: 'https://images.metmuseum.org/CRDImages/ep/web-large/DT1567.jpg',
    additionalImages: ['https://images.metmuseum.org/CRDImages/ep/original/LC-93_21-002.jpg'],
    objectURL: 'https://www.metmuseum.org/art/collection/search/436535',
    department: 'European Paintings',
    objectName: 'Painting',
    classification: 'Paintings',
    isHighlight: true,
    isTimelineWork: true,
    artistDisplayName: 'Vincent van Gogh',
    artistDisplayBio: 'Dutch, Zundert 1853–1890 Auvers-sur-Oise',
    artistNationality: 'Dutch',
    artistBeginDate: '1853',
    artistEndDate: '1890',
    constituents: [
      {
        constituentID: 161947,
        role: 'Artist',
        name: 'Vincent van Gogh',
        constituentULAN_URL: 'http://vocab.getty.edu/page/ulan/500115588',
        constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q5582',
        gender: '',
      },
    ],
    objectDate: '1889',
    objectBeginDate: 1889,
    objectEndDate: 1889,
    medium: 'Oil on canvas',
    dimensions: '28 7/8 × 36 3/4 in. (73.2 × 93.4 cm)',
    culture: '',
    period: '',
    dynasty: '',
    accessionNumber: '1993.132',
    creditLine: 'Purchase, The Annenberg Foundation Gift, 1993',
    country: '',
    region: '',
    tags: [
      {
        term: 'Landscapes',
        AAT_URL: 'http://vocab.getty.edu/page/aat/300132294',
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q191163',
      },
      {
        term: 'Cypresses',
        AAT_URL: 'http://vocab.getty.edu/page/aat/300343641',
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q146911',
      },
    ],
    objectWikidata_URL: 'https://www.wikidata.org/wiki/Q45585',
    GalleryNumber: '822',
  },

  /** 547802 — `tags` null, `constituents` null, and a genuine BCE date. */
  bceNullTags: {
    objectID: 547802,
    title: 'The Temple of Dendur',
    isPublicDomain: true,
    primaryImage: 'https://images.metmuseum.org/CRDImages/eg/original/DP239218.jpg',
    primaryImageSmall: 'https://images.metmuseum.org/CRDImages/eg/web-large/DP239218.jpg',
    additionalImages: [],
    objectURL: 'https://www.metmuseum.org/art/collection/search/547802',
    department: 'Egyptian Art',
    objectName: 'Temple',
    classification: '',
    isHighlight: true,
    isTimelineWork: true,
    artistDisplayName: '',
    artistDisplayBio: '',
    artistNationality: '',
    artistBeginDate: '',
    artistEndDate: '',
    constituents: null,
    objectDate: 'completed by 10 CE',
    objectBeginDate: -10,
    objectEndDate: -10,
    medium: 'Aeolian sandstone',
    dimensions: 'Temple Proper: H. 6.4 m (21 ft.)',
    culture: '',
    period: 'Roman Period',
    dynasty: '',
    accessionNumber: '68.154',
    creditLine:
      'Given to the United States by Egypt in 1965, awarded to The Metropolitan Museum of Art in 1967, and installed in The Sackler Wing in 1978',
    country: 'Egypt',
    region: 'Nubia',
    tags: null,
    objectWikidata_URL: 'https://www.wikidata.org/wiki/Q1362653',
    GalleryNumber: '131',
  },

  /** 61296 — the Met's `0`/`0` unknown-machine-readable-date shape. */
  unknownDate: {
    objectID: 61296,
    title: 'Bodhisattvas of the Four Directions(?)',
    isPublicDomain: false,
    primaryImage: '',
    primaryImageSmall: '',
    additionalImages: [],
    objectURL: 'https://www.metmuseum.org/art/collection/search/61296',
    department: 'Asian Art',
    objectName: 'Figure',
    classification: 'Sculpture',
    isHighlight: false,
    isTimelineWork: false,
    artistDisplayName: '',
    artistDisplayBio: '',
    artistNationality: '',
    artistBeginDate: '',
    artistEndDate: '',
    constituents: null,
    objectDate: 'date unknown',
    objectBeginDate: 0,
    objectEndDate: 0,
    medium: 'Wood, plaster',
    dimensions: 'H. 51 in. (129.5 cm); Diam. of base 13 in. (33 cm)',
    culture: 'China',
    period: '',
    dynasty: '',
    accessionNumber: '21.135',
    creditLine: 'Rogers Fund, 1921',
    country: '',
    region: '',
    tags: [
      {
        term: 'Bodhisattvas',
        AAT_URL: 'http://vocab.getty.edu/page/aat/300264360',
        Wikidata_URL: 'https://www.wikidata.org/wiki/Q178149',
      },
    ],
    objectWikidata_URL: '',
    GalleryNumber: '',
  },

  /**
   * 548211 — the richest findspot in the sampled archaeological departments:
   * seven geography fields populated at once, and a single measurements element
   * carrying three axes.
   */
  geographyRich: {
    objectID: 548211,
    title: 'Sarcophagus of Harkhebit',
    isPublicDomain: true,
    primaryImage: 'https://images.metmuseum.org/CRDImages/eg/original/07.229.1a-b_EGDP011797.jpg',
    primaryImageSmall: '',
    additionalImages: [],
    objectURL: 'https://www.metmuseum.org/art/collection/search/548211',
    department: 'Egyptian Art',
    objectName: 'Sarcophagus, Harkhebit',
    classification: '',
    isHighlight: false,
    isTimelineWork: true,
    artistDisplayName: '',
    artistDisplayBio: '',
    artistNationality: '',
    artistBeginDate: '',
    artistEndDate: '',
    constituents: null,
    objectDate: '595–526 BCE',
    objectBeginDate: -595,
    objectEndDate: -526,
    medium: 'Greywacke',
    dimensions: 'H. 256.5 cm  (101 in.); W. 127 cm (50 in.) at shoulders',
    culture: '',
    period: 'Late Period (Saite)',
    dynasty: 'Dynasty 26, mid to late',
    accessionNumber: '07.229.1a, b',
    creditLine: 'Rogers Fund, 1907',
    country: 'Egypt',
    region: 'Memphite Region',
    geographyType: 'From',
    city: '',
    state: '',
    county: '',
    subregion: 'Saqqara',
    locale: 'Late Period cemetery, Tomb of Harkhebit',
    locus: 'burial chamber',
    excavation: 'Egyptian Antiquities Service excavations, 1902',
    river: '',
    measurements: [
      {
        elementName: 'Overall',
        elementDescription: null,
        elementMeasurements: { Height: 256.5405, Thickness: 132.0803, Width: 127.0003 },
      },
    ],
    tags: null,
    objectWikidata_URL: 'https://www.wikidata.org/wiki/Q28670008',
    GalleryNumber: '123',
  },

  /**
   * 544683 — three measurement elements whose axis keys differ from one another:
   * two `Depth`-only siblings distinguished only by their descriptions, and one
   * `Height`/`Width` element with a null description. The shape a fixed set of
   * named measurement fields could not carry.
   */
  multiMeasurement: {
    objectID: 544683,
    title: 'Statue of two men and a boy that served as a domestic icon',
    isPublicDomain: true,
    primaryImage: 'https://images.metmuseum.org/CRDImages/eg/original/DP206147.jpg',
    primaryImageSmall: '',
    additionalImages: [],
    objectURL: 'https://www.metmuseum.org/art/collection/search/544683',
    department: 'Egyptian Art',
    objectName: 'Statue group, two men, boy',
    classification: '',
    isHighlight: true,
    isTimelineWork: true,
    artistDisplayName: '',
    artistDisplayBio: '',
    artistNationality: '',
    artistBeginDate: '',
    artistEndDate: '',
    constituents: null,
    objectDate: 'ca. 1347–1330 BCE',
    objectBeginDate: -1353,
    objectEndDate: -1353,
    medium: 'Limestone, paint',
    dimensions: 'h. 17 cm (6 11/16 in); w. 12.5 cm (4 15/16 in)',
    culture: '',
    period: 'New Kingdom, Amarna Period',
    dynasty: 'Dynasty 18',
    accessionNumber: '11.150.21',
    creditLine: 'Rogers Fund, 1911',
    country: '',
    region: 'Middle Egypt',
    geographyType: 'Probably originally from',
    city: '',
    state: '',
    county: '',
    subregion: 'Amarna (Akhetaten)',
    locale: '',
    locus: '',
    excavation: '',
    river: '',
    measurements: [
      {
        elementName: 'Other',
        elementDescription: 'Depth nxt to boy',
        elementMeasurements: { Depth: 4.8 },
      },
      {
        elementName: 'Other',
        elementDescription: 'Depth nxt to man',
        elementMeasurements: { Depth: 5.7 },
      },
      {
        elementName: 'Overall',
        elementDescription: null,
        elementMeasurements: { Height: 17, Width: 12.5 },
      },
    ],
    tags: null,
    objectWikidata_URL: 'https://www.wikidata.org/wiki/Q29385817',
    GalleryNumber: '121',
  },
} as const;

describe('MetService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initMetService({} as AppConfig, createInMemoryStorage());
    // Unstaged calls fail loudly; each test layers the fakes it needs on top.
    fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('per-endpoint URLs under the default base', () => {
    it('fetches an object from /v1/objects/{id} on the collection host', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rawObjects.populated));
      await getMetService().getObject(436535, createMockContext());

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.origin).toBe('https://collectionapi.metmuseum.org');
      expect(url.pathname).toBe('/public/collection/v1/objects/436535');
    });

    it('fetches departments from /v1/departments on the collection host', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ departments: [] }));
      await getMetService().getDepartments(createMockContext());

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.origin).toBe('https://collectionapi.metmuseum.org');
      expect(url.pathname).toBe('/public/collection/v1/departments');
    });
  });

  /**
   * An upstream 504/408/425 and the server's own timer abort all arrive as a
   * `Timeout`-coded `McpError`. Each is transient, so each takes the same retry
   * ladder `met_list_departments` uses rather than a non-retryable relabel.
   */
  describe('search — a Timeout-coded failure is retried like any transient error (#28)', () => {
    /** A real 504 exchange, minted per call so every retry reads a fresh body. */
    const gatewayTimeout = () =>
      Promise.resolve(
        new Response('<html>gateway timeout</html>', {
          status: 504,
          statusText: 'Gateway Timeout',
          headers: { 'content-type': 'text/html' },
        }),
      );

    /** A request that never answers until its signal aborts — the timer-abort shape. */
    const neverAnswers = (_request: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    it('retries an upstream 504 on the ordinary ladder and surfaces it as the upstream error', async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(gatewayTimeout);
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      const pending = getMetService()
        .search({ q: 'cat', limit: 20 }, ctx)
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = (await pending) as {
        code: number;
        message: string;
        data: Record<string, unknown>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toContain('Status: 504');
      expect(err.data.status).toBe(504);
      expect(err.data.errorSource).toBe('FetchHttpError');
      expect(err.data.retryAttempts).toBe(4);
      expect(err.data.reason).toBeUndefined();
      expect(err.data.retryable).toBeUndefined();
    });

    it('retries a request-timer abort (FetchTimeout) the same way', async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(neverAnswers);
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      const pending = getMetService()
        .search({ q: 'cat', limit: 20 }, ctx)
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = (await pending) as { code: number; data: Record<string, unknown> };

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data.errorSource).toBe('FetchTimeout');
      expect(err.data.retryAttempts).toBe(4);
      expect(err.data.reason).toBeUndefined();
    });

    it('recovers when a retry after a 504 succeeds', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockImplementationOnce(gatewayTimeout)
        .mockImplementationOnce(() => Promise.resolve(idsResponse(3)));

      const pending = getMetService().search({ q: 'cat', limit: 20 }, createMockContext());
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(3);
    });

    it('reaches the caller through the tool contract as the 504, with no search_timeout reason', async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(gatewayTimeout);

      const pending = runToolContract(metSearchCollections, { q: 'cat', limit: 20 });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.status).toBe(504);
      expect(error.data.reason).toBeUndefined();
      const text = (result.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain('Status: 504');
      expect(text).not.toContain('search_timeout');
      expect(text).not.toContain('too large');
    });
  });

  /**
   * `/v1.1/search` pages upstream: one request per page, `offset`/`limit` passed
   * through, nothing past `offset + limit = 10,000`, and `total` still the full
   * count. The fake mirrors those measured behaviors, so every case below runs
   * the service's real URL building and window arithmetic.
   */
  describe('search — /v1.1 paging (#27)', () => {
    it('requests /v1.1/search once, carrying offset, limit, and every filter', async () => {
      fetchMock.mockImplementation(searchUpstream(3));
      await getMetService().search(
        {
          q: 'cat',
          limit: 20,
          hasImages: true,
          isHighlight: true,
          isOnView: false,
          medium: 'Paintings',
          departmentId: 11,
          geoLocation: ['France'],
          dateBegin: 1800,
          dateEnd: 1900,
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.origin).toBe(COLLECTION_ORIGIN);
      expect(url.pathname).toBe(SEARCH_PATH);
      expect([...url.searchParams.entries()]).toEqual([
        ['q', 'cat'],
        ['offset', '0'],
        ['limit', '20'],
        ['hasImages', 'true'],
        ['isHighlight', 'true'],
        ['isOnView', 'false'],
        ['medium', 'Paintings'],
        ['departmentId', '11'],
        ['geoLocation', 'France'],
        ['dateBegin', '1800'],
        ['dateEnd', '1900'],
      ]);
      expect(url.searchParams.has('isPublicDomain')).toBe(false);
    });

    it('sends q, offset, and limit alone when no filter is set (#13: omitted filters stay off)', async () => {
      fetchMock.mockImplementation(searchUpstream(3));
      await getMetService().search({ q: 'cat', limit: 10, offset: 40 }, createMockContext());

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect([...url.searchParams.entries()]).toEqual([
        ['q', 'cat'],
        ['offset', '40'],
        ['limit', '10'],
      ]);
    });

    it('returns the first page with continuation at offset 0', async () => {
      fetchMock.mockImplementation(searchUpstream(100));
      const result = await getMetService().search({ q: 'cat', limit: 10 }, createMockContext());

      expect(result).toEqual({
        total: 100,
        objectIDs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        returned: 10,
        truncated: true,
        remaining: 90,
        nextOffset: 10,
        offset: 0,
      });
    });

    it('returns a mid-window page of a result set larger than the window', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const result = await getMetService().search(
        { q: 'horse', limit: 500, offset: 5000 },
        createMockContext(),
      );

      expect(result.objectIDs[0]).toBe(5001);
      expect(result.objectIDs.at(-1)).toBe(5500);
      expect(result.returned).toBe(500);
      expect(result.total).toBe(14_398);
      // Against the 10,000 window, not the 14,398 total.
      expect(result.remaining).toBe(4500);
      expect(result.truncated).toBe(true);
      expect(result.nextOffset).toBe(5500);
    });

    it('ends paging on the page that crosses the 10,000 window', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const result = await getMetService().search(
        { q: 'horse', limit: 500, offset: 9900 },
        createMockContext(),
      );

      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('offset')).toBe('9900');
      expect(result.returned).toBe(100);
      expect(result.objectIDs.at(-1)).toBe(10_000);
      expect(result.total).toBe(14_398);
      expect(result.remaining).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('returns an empty page, not an error, at an offset of exactly 10,000', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const result = await getMetService().search(
        { q: 'horse', limit: 20, offset: 10_000 },
        createMockContext(),
      );

      expect(result).toEqual({
        total: 14_398,
        objectIDs: [],
        returned: 0,
        truncated: false,
        remaining: 0,
        nextOffset: null,
        offset: 10_000,
      });
    });

    it('returns an empty page, not an error, at an offset of exactly total', async () => {
      fetchMock.mockImplementation(searchUpstream(178));
      const result = await getMetService().search(
        { q: 'sunflower', limit: 20, offset: 178 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([]);
      expect(result.total).toBe(178);
      expect(result.offset).toBe(178);
      expect(result.remaining).toBe(0);
      expect(result.nextOffset).toBeNull();
    });

    it('returns an empty page for an offset far past total', async () => {
      fetchMock.mockImplementation(searchUpstream(25));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 999 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([]);
      expect(result.offset).toBe(999);
      expect(result.total).toBe(25);
      expect(result.truncated).toBe(false);
    });

    it('ends paging on the last partial page of a result set inside the window', async () => {
      fetchMock.mockImplementation(searchUpstream(25));
      const result = await getMetService().search(
        { q: 'cat', limit: 10, offset: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([21, 22, 23, 24, 25]);
      expect(result.remaining).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('treats a total of exactly 10,000 as fully reachable', async () => {
      fetchMock.mockImplementation(searchUpstream(10_000));
      const result = await getMetService().search(
        { q: 'cat', limit: 500, offset: 9500 },
        createMockContext(),
      );

      expect(result.returned).toBe(500);
      expect(result.remaining).toBe(0);
      expect(result.nextOffset).toBeNull();
    });

    it('normalizes an upstream objectIDs: null with total 0 to an empty page', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ total: 0, objectIDs: null }));
      const result = await getMetService().search(
        { q: 'zzzqqqxyz', limit: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.nextOffset).toBeNull();
    });

    it('echoes the applied default of 0 when offset is omitted (#17)', async () => {
      fetchMock.mockImplementation(searchUpstream(5));
      const result = await getMetService().search({ q: 'rare', limit: 20 }, createMockContext());
      expect(result.offset).toBe(0);
    });

    it('walks the whole reachable window by following nextOffset', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const seen = new Set<number>();
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const page = await getMetService().search(
          { q: 'horse', limit: 500, offset },
          createMockContext(),
        );
        for (const id of page.objectIDs) seen.add(id);
        offset = page.nextOffset;
        pages++;
      }

      expect(pages).toBe(20);
      expect(seen.size).toBe(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(20);
    });
  });

  describe('countKeywordMatches — the keyword-only count behind the no_results hint (#25)', () => {
    it('sends one limit=1 request carrying q alone and returns the upstream total', async () => {
      fetchMock.mockImplementation(searchUpstream(178));
      const total = await getMetService().countKeywordMatches('sunflower', createMockContext());

      expect(total).toBe(178);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.pathname).toBe(SEARCH_PATH);
      expect([...url.searchParams.entries()]).toEqual([
        ['q', 'sunflower'],
        ['offset', '0'],
        ['limit', '1'],
      ]);
    });

    it('returns null after one failed attempt instead of throwing or retrying', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('<html>busy</html>', { status: 503 })),
      );
      const total = await getMetService().countKeywordMatches('sunflower', createMockContext());

      expect(total).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows a caller abort as cancellation rather than degrading it to null', async () => {
      fetchMock.mockImplementation(
        (_request: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      const controller = new AbortController();
      const pending = getMetService().countKeywordMatches(
        'sunflower',
        createMockContext({ signal: controller.signal }),
      );
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });
  });

  /**
   * The tool over the real service and a fake upstream, through `runToolContract`
   * — schema, handler, output parse, `format()`, and the enrichment trailer — so
   * each case asserts what a client reads on both surfaces.
   */
  describe('met_search_collections — the reachable window on both surfaces (#27)', () => {
    type Structured = Record<string, unknown> & { notice?: string };

    it('discloses the window when total exceeds 10,000, on a truncated page', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const result = await runToolContract(metSearchCollections, { q: 'horse', limit: 20 });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Structured;
      expect(structured.total).toBe(14_398);
      expect(structured.remaining).toBe(9980);
      expect(structured.notice).toContain('first 10,000 of 14,398');
      const text = textOf(result);
      expect(text).toContain('(truncated)');
      expect(text).toContain('first 10,000 of 14,398');
    });

    it('marks the page that stops at the window short of total as (window end)', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const result = await runToolContract(metSearchCollections, {
        q: 'horse',
        offset: 9900,
        limit: 500,
      });

      const structured = result.structuredContent as Structured;
      expect(structured.returned).toBe(100);
      expect(structured.remaining).toBe(0);
      expect(structured.nextOffset).toBeNull();
      expect(structured.notice).toContain('10,000');
      const text = textOf(result);
      expect(text).toContain('**Returned IDs:** 100 (window end)');
      expect(text).not.toContain('(complete)');
    });

    it('marks an offset of exactly 10,000 as beyond the result set, not an error', async () => {
      fetchMock.mockImplementation(searchUpstream(14_398));
      const result = await runToolContract(metSearchCollections, { q: 'horse', offset: 10_000 });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Structured;
      expect(structured.objectIDs).toEqual([]);
      expect(structured.offset).toBe(10_000);
      expect(textOf(result)).toContain('**Returned IDs:** 0 (offset beyond result set)');
    });

    it('marks an offset of exactly total as beyond the result set, with no window notice', async () => {
      fetchMock.mockImplementation(searchUpstream(178));
      const result = await runToolContract(metSearchCollections, { q: 'sunflower', offset: 178 });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Structured;
      expect(structured.total).toBe(178);
      expect(structured.notice).toBeUndefined();
      const text = textOf(result);
      expect(text).toContain('(offset beyond result set)');
      expect(text).not.toContain('10,000');
    });

    it('renders the last page of a result set inside the window as (complete), with no notice', async () => {
      fetchMock.mockImplementation(searchUpstream(178));
      const result = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        offset: 170,
        limit: 20,
      });

      const structured = result.structuredContent as Structured;
      expect(structured.returned).toBe(8);
      expect(structured.notice).toBeUndefined();
      expect(textOf(result)).toContain('**Returned IDs:** 8 (complete)');
    });

    it('renders a total of exactly 10,000 as (complete) on its last page, with no notice', async () => {
      fetchMock.mockImplementation(searchUpstream(10_000));
      const result = await runToolContract(metSearchCollections, {
        q: 'cat',
        offset: 9500,
        limit: 500,
      });

      const structured = result.structuredContent as Structured;
      expect(structured.notice).toBeUndefined();
      expect(textOf(result)).toContain('**Returned IDs:** 500 (complete)');
    });

    /**
     * The window matrix: every boundary cell, asserted on both surfaces. `notice`
     * is whether the window disclosure appears — on `structuredContent` and in the
     * `content[]` trailer alike.
     */
    it.each([
      // total, offset, limit → returned, remaining, nextOffset, marker, notice
      [5, 0, 20, 5, 0, null, '(complete)', false],
      [20, 0, 20, 20, 0, null, '(complete)', false],
      [10_000, 9500, 500, 500, 0, null, '(complete)', false],
      [10_001, 9500, 500, 500, 0, null, '(window end)', true],
      [10_001, 9000, 500, 500, 500, 9500, '(truncated)', true],
      [14_398, 9800, 500, 200, 0, null, '(window end)', true],
      [178, 500, 20, 0, 0, null, '(offset beyond result set)', false],
      [14_398, 12_000, 20, 0, 0, null, '(offset beyond result set)', true],
    ] as const)(
      'total %i, offset %i, limit %i → %i IDs, remaining %i, nextOffset %s, %s',
      async (total, offset, limit, returned, remaining, nextOffset, marker, notice) => {
        fetchMock.mockImplementation(searchUpstream(total));
        const result = await runToolContract(metSearchCollections, { q: 'horse', offset, limit });

        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as Structured;
        expect(structured).toMatchObject({ total, offset, returned, remaining, nextOffset });
        expect(structured.truncated).toBe(nextOffset !== null);
        const text = textOf(result);
        expect(text).toContain(`**Returned IDs:** ${returned} ${marker}`);
        if (notice) {
          expect(structured.notice).toContain('first 10,000 of');
          expect(text).toContain('first 10,000 of');
        } else {
          expect(structured.notice).toBeUndefined();
          expect(text).not.toContain('reachable by paging');
        }
      },
    );

    it('continues from the delivered count when a mid-window page comes back short', async () => {
      // A page shorter than requested inside the window: continuation keys on what
      // was delivered, so following nextOffset can re-read a position but never skip one.
      fetchMock.mockImplementation(
        routes({
          [SEARCH_PATH]: (url) =>
            jsonResponse({
              total: 14_398,
              objectIDs: Array.from(
                { length: 499 },
                (_, i) => Number(url.searchParams.get('offset')) + i + 1,
              ),
            }),
        }),
      );
      const result = await runToolContract(metSearchCollections, {
        q: 'horse',
        offset: 5000,
        limit: 500,
      });

      expect(result.structuredContent).toMatchObject({
        returned: 499,
        remaining: 4501,
        truncated: true,
        nextOffset: 5499,
      });
      expect(textOf(result)).toContain('**Returned IDs:** 499 (truncated)');
    });

    it('rejects isPublicDomain at the schema, naming the key, before any request', async () => {
      // An undeclared key by construction, so the typed argument cannot express it.
      const result = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        isPublicDomain: true,
      } as unknown as z.input<typeof metSearchCollections.input>);

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number } }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(textOf(result)).toContain('isPublicDomain');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a two-element geoLocation at the schema and accepts one location', async () => {
      const rejected = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        geoLocation: ['France', 'Japan'],
      });
      expect(rejected.isError).toBe(true);
      expect((rejected.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(textOf(rejected)).toContain('geoLocation takes one location');
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockImplementation(searchUpstream(35));
      const accepted = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        geoLocation: ['France'],
      });
      expect(accepted.isError).toBeFalsy();
      expect(searchRequests(fetchMock)[0]?.searchParams.getAll('geoLocation')).toEqual(['France']);
    });
  });

  /**
   * The `no_results` recovery is composed from the levers the call used. Whether
   * the keyword matches on its own separates "bad keyword" from "filters removed
   * every match", and it costs one extra `limit=1` request, only when a filtered
   * search comes back empty.
   */
  describe('met_search_collections — no_results names the levers that zeroed the query (#25)', () => {
    /**
     * `/v1.1/search` whose filtered requests match `filteredTotal` and whose
     * keyword-only requests match `keywordTotal` — or answer 503 on `'fail'`.
     */
    function searchByShape(filteredTotal: number, keywordTotal: number | 'fail') {
      return (url: URL) => {
        const filtered = [...url.searchParams.keys()].some((key) => !PAGING_PARAMS.has(key));
        if (filtered) return searchPage(url, filteredTotal);
        return keywordTotal === 'fail'
          ? new Response('<html>busy</html>', { status: 503 })
          : searchPage(url, keywordTotal);
      };
    }

    const departmentsRoute = () =>
      jsonResponse({ departments: [{ departmentId: 11, displayName: 'European Paintings' }] });

    type NoResults = {
      code: number;
      data: { reason: string; recovery: { hint: string } };
    };
    const errorOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { error: NoResults }).error;

    const OTHER_FILTERS = ['hasImages', 'isHighlight', 'isOnView', 'geoLocation', 'dateBegin'];

    it('an unfiltered miss gets the keyword hint and issues no extra request', async () => {
      fetchMock.mockImplementation(routes({ [SEARCH_PATH]: searchByShape(0, 0) }));
      const result = await runToolContract(metSearchCollections, { q: 'zzzqqqxyz' });

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('no_results');
      expect(error.data.recovery.hint).toContain('"zzzqqqxyz" matches no object');
      expect(error.data.recovery.hint).not.toContain('departmentId');
      expect(error.data.recovery.hint).not.toContain('met_list_departments');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The text surface carries the same hint and the reason a caller branches on.
      const text = textOf(result);
      expect(text).toContain('Recovery: The keyword "zzzqqqxyz" matches no object');
      expect(text).toContain('no_results');
    });

    it('a keyword that matches nothing even unfiltered names no filter', async () => {
      fetchMock.mockImplementation(routes({ [SEARCH_PATH]: searchByShape(0, 0) }));
      const result = await runToolContract(metSearchCollections, {
        q: 'zzzqqqxyz',
        medium: 'Paintings',
      });

      const { hint } = errorOf(result).data.recovery;
      expect(errorOf(result).data.reason).toBe('no_results');
      expect(hint).toContain('even with no filter applied');
      expect(hint).not.toContain('medium');
      expect(hint).not.toContain('classification');

      // Exactly one extra request: q alone, limit 1.
      const requests = searchRequests(fetchMock);
      expect(requests).toHaveLength(2);
      expect([...(requests[1]?.searchParams.entries() ?? [])]).toEqual([
        ['q', 'zzzqqqxyz'],
        ['offset', '0'],
        ['limit', '1'],
      ]);
    });

    it('a medium that zeroed a matching keyword is named with its correction, alone', async () => {
      fetchMock.mockImplementation(routes({ [SEARCH_PATH]: searchByShape(0, 178) }));
      const result = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        medium: 'Painting',
      });

      const { hint } = errorOf(result).data.recovery;
      expect(errorOf(result).data.reason).toBe('no_results');
      expect(hint).toContain('matches 178 objects on its own');
      expect(hint).toContain('so the filter removed every match: medium. Correct or drop it,');
      expect(hint).toContain('case-sensitive');
      expect(hint).toContain('classification');
      expect(hint).toContain('not a material');
      for (const other of [...OTHER_FILTERS, 'departmentId']) expect(hint).not.toContain(other);
      expect(searchRequests(fetchMock)).toHaveLength(2);
      const text = textOf(result);
      expect(text).toContain('No objects matched the query "sunflower" with the filter medium.');
      expect(text).toContain('removed every match: medium.');
    });

    it('names every filter the call set in one hint', async () => {
      fetchMock.mockImplementation(
        routes({ [SEARCH_PATH]: searchByShape(0, 178), [DEPARTMENTS_PATH]: departmentsRoute }),
      );
      const result = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        medium: 'Painting',
        departmentId: 11,
      });

      const { hint } = errorOf(result).data.recovery;
      expect(errorOf(result).data.reason).toBe('no_results');
      expect(hint).toContain(
        'the filters removed every match: medium, departmentId. Correct or drop them,',
      );
      expect(hint).toContain('case-sensitive');
      for (const other of OTHER_FILTERS) expect(hint).not.toContain(other);
      expect(textOf(result)).toContain('with the filters medium, departmentId.');
    });

    it('names the filters used when the keyword-only request fails, and still returns no_results', async () => {
      fetchMock.mockImplementation(routes({ [SEARCH_PATH]: searchByShape(0, 'fail') }));
      const result = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        medium: 'Painting',
        isOnView: true,
      });

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('no_results');
      expect(error.data.recovery.hint).toContain('may have removed every match: isOnView, medium');
      expect(error.data.recovery.hint).toContain('could not be checked');
      // One filtered request, one keyword-only attempt — no retry ladder on the hint.
      expect(searchRequests(fetchMock)).toHaveLength(2);
    });

    it('a caller abort during the keyword-only request surfaces as cancellation, not no_results', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) => {
        const url = new URL(String(request));
        if ([...url.searchParams.keys()].some((key) => !PAGING_PARAMS.has(key))) {
          return Promise.resolve(searchPage(url, 0));
        }
        // The keyword-only request is in flight when the caller goes away.
        queueMicrotask(() => controller.abort());
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      });
      const ctx = createMockContext({
        errors: metSearchCollections.errors,
        signal: controller.signal,
      });
      const input = metSearchCollections.input.parse({ q: 'sunflower', medium: 'Painting' });

      const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);
      expect(err).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(err.data?.reason).toBeUndefined();
      expect(searchRequests(fetchMock)).toHaveLength(2);
    });

    it('a filtered search with results issues no extra request', async () => {
      fetchMock.mockImplementation(routes({ [SEARCH_PATH]: searchByShape(11, 178) }));
      const result = await runToolContract(metSearchCollections, {
        q: 'sunflower',
        medium: 'Paintings',
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { total: number }).total).toBe(11);
      expect(searchRequests(fetchMock)).toHaveLength(1);
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
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(DEPARTMENTS_PATH);
    });
  });

  describe('getObject — normalizeObject', () => {
    it('passes a fully populated record through unchanged', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rawObjects.populated));
      const record = await getMetService().getObject(436535, createMockContext());

      expect(record).not.toBeNull();
      expect(record?.objectID).toBe(436535);
      expect(record?.title).toBe('Wheat Field with Cypresses');
      expect(record?.objectURL).toBe(rawObjects.populated.objectURL);
      expect(record?.creditLine).toBe(rawObjects.populated.creditLine);
      expect(record?.additionalImages).toEqual(rawObjects.populated.additionalImages);
      // hasCC0Image is derived, not passed through.
      expect(record?.hasCC0Image).toBe(true);
    });

    it('preserves every item of a fully populated tags array, in order', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rawObjects.populated));
      const record = await getMetService().getObject(436535, createMockContext());

      expect(record?.tags).toHaveLength(2);
      expect(record?.tags?.map((t) => t.term)).toEqual(['Landscapes', 'Cypresses']);
      expect(record?.tags?.[0]?.AAT_URL).toBe('http://vocab.getty.edu/page/aat/300132294');
      expect(record?.tags?.[1]?.Wikidata_URL).toBe('https://www.wikidata.org/wiki/Q146911');
    });

    it('preserves constituents items with their sparse sub-fields intact', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rawObjects.nullTagUrl));
      const record = await getMetService().getObject(487659, createMockContext());

      expect(record?.constituents).toHaveLength(1);
      expect(record?.constituents?.[0]).toEqual({
        constituentID: 162095,
        role: 'Artist',
        name: 'Paul Manship',
        constituentULAN_URL: 'http://vocab.getty.edu/page/ulan/500032239',
        constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q3371768',
        // Upstream sends '' rather than null here — no per-item guard needed.
        gender: '',
      });
    });

    it('keeps a null tags/constituents array null rather than coercing it to []', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rawObjects.bceNullTags));
      const record = await getMetService().getObject(547802, createMockContext());

      expect(record?.tags).toBeNull();
      expect(record?.constituents).toBeNull();
    });

    it('coalesces absent upstream fields to the empty-value convention', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ objectID: 999 }));
      const record = await getMetService().getObject(999, createMockContext());

      expect(record?.title).toBe('');
      expect(record?.creditLine).toBe('');
      expect(record?.GalleryNumber).toBe('');
      expect(record?.additionalImages).toEqual([]);
      expect(record?.isPublicDomain).toBe(false);
      expect(record?.hasCC0Image).toBe(false);
      expect(record?.tags).toBeNull();
      expect(record?.constituents).toBeNull();
    });

    describe('geography and measurements (#16)', () => {
      it('normalizes the nine findspot fields without touching country/region', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.geographyRich));
        const record = await getMetService().getObject(548211, createMockContext());

        expect(record?.geography).toEqual({
          geographyType: 'From',
          city: '',
          state: '',
          county: '',
          subregion: 'Saqqara',
          locale: 'Late Period cemetery, Tomb of Harkhebit',
          locus: 'burial chamber',
          excavation: 'Egyptian Antiquities Service excavations, 1902',
          river: '',
        });
        // country and region stay top-level and are not duplicated into the block.
        expect(record?.country).toBe('Egypt');
        expect(record?.region).toBe('Memphite Region');
        expect(record?.geography).not.toHaveProperty('country');
        expect(record?.geography).not.toHaveProperty('region');
      });

      it('defaults every findspot field to the empty-string convention when absent', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ objectID: 999 }));
        const record = await getMetService().getObject(999, createMockContext());

        expect(Object.values(record?.geography ?? {})).toEqual(Array(9).fill(''));
      });

      it('preserves every measurements element in order, each with its own axes', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.multiMeasurement));
        const record = await getMetService().getObject(544683, createMockContext());

        expect(record?.measurements).toEqual([
          {
            elementName: 'Other',
            elementDescription: 'Depth nxt to boy',
            elementMeasurements: { Depth: 4.8 },
          },
          {
            elementName: 'Other',
            elementDescription: 'Depth nxt to man',
            elementMeasurements: { Depth: 5.7 },
          },
          // Sibling elements carry different axis keys — the open map is load-bearing.
          {
            elementName: 'Overall',
            elementDescription: '',
            elementMeasurements: { Height: 17, Width: 12.5 },
          },
        ]);
      });

      it('normalizes a null elementDescription to the empty-string convention', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.geographyRich));
        const record = await getMetService().getObject(548211, createMockContext());

        // Null on the wire; '' here, matching the tag URL fields rather than the
        // date pair — a string field has a safe in-domain sentinel.
        expect(record?.measurements?.[0]?.elementDescription).toBe('');
        expect(record?.measurements?.[0]?.elementMeasurements).toEqual({
          Height: 256.5405,
          Thickness: 132.0803,
          Width: 127.0003,
        });
      });

      it('keeps a null measurements array null rather than coercing it to []', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ objectID: 999, measurements: null }));
        const record = await getMetService().getObject(999, createMockContext());

        expect(record?.measurements).toBeNull();
      });

      it('defaults a measurement element with no axes to an empty map', async () => {
        fetchMock.mockResolvedValue(
          jsonResponse({ objectID: 999, measurements: [{ elementName: 'Overall' }] }),
        );
        const record = await getMetService().getObject(999, createMockContext());

        expect(record?.measurements).toEqual([
          { elementName: 'Overall', elementDescription: '', elementMeasurements: {} },
        ]);
      });

      it('produces a geography-rich record met_get_object’s output schema accepts', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.geographyRich));
        const rich = await getMetService().getObject(548211, createMockContext());
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.multiMeasurement));
        const multi = await getMetService().getObject(544683, createMockContext());

        const parsed = metGetObject.output.safeParse({ objects: [rich, multi], failed: [] });
        expect(parsed.error?.message).toBeUndefined();
        expect(parsed.success).toBe(true);
      });
    });

    describe('unknown machine-readable dates (#14)', () => {
      it('normalizes the upstream 0/0 unknown-date shape to null/null', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.unknownDate));
        const record = await getMetService().getObject(61296, createMockContext());

        expect(record?.objectBeginDate).toBeNull();
        expect(record?.objectEndDate).toBeNull();
        // The human-readable field still carries what the Met knows.
        expect(record?.objectDate).toBe('date unknown');
      });

      it('normalizes a genuinely absent upstream date to null rather than year zero', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ objectID: 999 }));
        const record = await getMetService().getObject(999, createMockContext());

        expect(record?.objectBeginDate).toBeNull();
        expect(record?.objectEndDate).toBeNull();
      });

      it('passes a genuine BCE date through as the exact negative integers', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.bceNullTags));
        const record = await getMetService().getObject(547802, createMockContext());

        expect(record?.objectBeginDate).toBe(-10);
        expect(record?.objectEndDate).toBe(-10);
      });

      it('passes a genuine CE date through unchanged', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.populated));
        const record = await getMetService().getObject(436535, createMockContext());

        expect(record?.objectBeginDate).toBe(1889);
        expect(record?.objectEndDate).toBe(1889);
      });

      it('passes a BCE century span ending at -1 through, the year adjacent to the sentinel', async () => {
        // Object 250240 encodes "1st century BCE" as -100 to -1: the Met's date
        // model skips year zero, which is what leaves 0 free to mean "unknown".
        fetchMock.mockResolvedValue(
          jsonResponse({
            ...rawObjects.populated,
            objectID: 250240,
            objectDate: '1st century BCE',
            objectBeginDate: -100,
            objectEndDate: -1,
          }),
        );
        const record = await getMetService().getObject(250240, createMockContext());

        expect(record?.objectBeginDate).toBe(-100);
        expect(record?.objectEndDate).toBe(-1);
      });

      it('leaves a single zero bound alone — only the 0/0 pair is the unknown sentinel', async () => {
        fetchMock.mockResolvedValue(
          jsonResponse({ ...rawObjects.populated, objectBeginDate: 0, objectEndDate: 1500 }),
        );
        const record = await getMetService().getObject(436535, createMockContext());

        expect(record?.objectBeginDate).toBe(0);
        expect(record?.objectEndDate).toBe(1500);
      });
    });

    describe('nullable tag URLs (#19)', () => {
      it('normalizes a null tag URL to the empty-string absence convention', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.nullTagUrl));
        const record = await getMetService().getObject(487659, createMockContext());

        expect(record?.tags?.[0]).toEqual({
          term: 'Bow and Arrow',
          AAT_URL: '',
          Wikidata_URL: 'https://www.wikidata.org/wiki/Q19827042',
        });
      });

      it('leaves the null tag’s fully populated siblings untouched', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.nullTagUrl));
        const record = await getMetService().getObject(487659, createMockContext());

        expect(record?.tags).toHaveLength(4);
        expect(record?.tags?.map((t) => t.term)).toEqual([
          'Bow and Arrow',
          'Men',
          'Hunting',
          'Dogs',
        ]);
        expect(record?.tags?.[1]?.AAT_URL).toBe('http://vocab.getty.edu/page/aat/300025928');
        expect(record?.tags?.[3]?.Wikidata_URL).toBe('https://www.wikidata.org/wiki/Q144');
      });

      it('normalizes a null Wikidata_URL on the same per-item guard', async () => {
        fetchMock.mockResolvedValue(
          jsonResponse({
            ...rawObjects.nullTagUrl,
            tags: [{ term: 'Bow and Arrow', AAT_URL: null, Wikidata_URL: null }],
          }),
        );
        const record = await getMetService().getObject(487659, createMockContext());

        expect(record?.tags?.[0]).toEqual({ term: 'Bow and Arrow', AAT_URL: '', Wikidata_URL: '' });
      });

      it('produces a record met_get_object’s output schema accepts', async () => {
        // The framework runs def.output.parse(handlerResult) before format(), so a
        // null that reaches structuredContent discards the whole valid batch.
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.nullTagUrl));
        const record = await getMetService().getObject(487659, createMockContext());

        const parsed = metGetObject.output.safeParse({ objects: [record], failed: [] });
        expect(parsed.error?.message).toBeUndefined();
        expect(parsed.success).toBe(true);
      });

      it('accepts a record whose tags are all populated, and one with null tags', async () => {
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.populated));
        const populated = await getMetService().getObject(436535, createMockContext());
        fetchMock.mockResolvedValue(jsonResponse(rawObjects.bceNullTags));
        const nullTags = await getMetService().getObject(547802, createMockContext());

        const parsed = metGetObject.output.safeParse({
          objects: [populated, nullTags],
          failed: [],
        });
        expect(parsed.error?.message).toBeUndefined();
        expect(parsed.success).toBe(true);
      });
    });

    it('returns null for a 404 instead of throwing', async () => {
      fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }));
      const record = await getMetService().getObject(999999999, createMockContext());

      expect(record).toBeNull();
    });
  });
});
