/**
 * @fileoverview Tests for MetService — offset paging, fail-fast search timeout,
 * cached department-ID validation, and object normalization. Exercises the real
 * service with a mocked global fetch; this is the only layer that reaches
 * `normalizeObject` (the tool tests mock the service wholesale, above it).
 * @module tests/services/met/met-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * True when a `/search` request carries `q` alone — the shape of the unfiltered
 * control run. Mirrors the service's own "any parameter beyond q" test, so a mock
 * can tell the two runs of a filtered search apart.
 */
function isControlRun(request: unknown): boolean {
  const url = new URL(String(request));
  return [...url.searchParams.keys()].every((key) => key === 'q');
}

/**
 * Stage the two responses a filtered search consumes: the filtered run and the
 * unfiltered control run it is intersected against. Routing on the URL rather
 * than call order keeps the mock correct however the two are scheduled.
 */
function routeSearch(filtered: unknown, control: unknown) {
  return (request: unknown) =>
    Promise.resolve(jsonResponse(isControlRun(request) ? control : filtered));
}

/** A `/search` payload carrying exactly these IDs, with a matching total. */
function idsBody(objectIDs: number[]) {
  return { total: objectIDs.length, objectIDs };
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
      // A filtered search consumes two responses concurrently, so the mock has to
      // mint a fresh one per call — a single Response body cannot be read twice.
      fetchMock.mockImplementation(() => Promise.resolve(idsResponse(3)));
      await getMetService().search(
        { q: 'cat', limit: 10, geoLocation: ['France', 'Egypt'] },
        createMockContext(),
      );
      const filteredUrl = fetchMock.mock.calls
        .map((call) => new URL(String(call[0])))
        .find((url) => !isControlRun(url));
      expect(filteredUrl?.searchParams.getAll('geoLocation')).toEqual(['France', 'Egypt']);
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
      // search_timeout only fires on the filtered run — the control run is
      // best-effort — so filters genuinely do shrink the download that timed out.
      expect(err.data.recovery.hint).toContain('Narrow the query');
      expect(err.data.recovery.hint).toContain('filters');
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

  /**
   * The upstream `/search` answers any filter parameter with the union of the real
   * keyword matches and a fixed, query-independent floor. Every case below is drawn
   * from the live measurements in #21: `q=sunflower&isPublicDomain=true` returns
   * `[437261, 436529, 228990, 436043]`, of which only `436529` is in the 97-result
   * unfiltered run.
   */
  describe('search — filtered runs are intersected with an unfiltered control (#21)', () => {
    const SUNFLOWER_FILTERED = [437261, 436529, 228990, 436043];

    it('drops the floor IDs the unfiltered control run does not contain', async () => {
      fetchMock.mockImplementation(
        routeSearch(
          { total: 4, objectIDs: SUNFLOWER_FILTERED },
          { total: 97, objectIDs: [436529, 436580, 337700] },
        ),
      );
      const result = await getMetService().search(
        { q: 'sunflower', isPublicDomain: true, limit: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([436529]);
      expect(result.total).toBe(1);
      expect(result.returned).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.nextOffset).toBeNull();
    });

    it('retains a floor member that genuinely matches the query', async () => {
      // 437261 is a floor member for isPublicDomain, but it is a true match for a
      // query it actually relates to — subtracting a cached floor would lose it.
      fetchMock.mockImplementation(
        routeSearch(
          { total: 4, objectIDs: SUNFLOWER_FILTERED },
          { total: 3, objectIDs: [437261, 436529, 500000] },
        ),
      );
      const result = await getMetService().search(
        { q: 'jerome', isPublicDomain: true, limit: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([437261, 436529]);
      expect(result.total).toBe(2);
    });

    it('preserves the filtered run’s ordering, not the control run’s', async () => {
      fetchMock.mockImplementation(routeSearch(idsBody([30, 10, 20]), idsBody([10, 20, 30, 40])));
      const result = await getMetService().search(
        { q: 'cat', hasImages: true, limit: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([30, 10, 20]);
    });

    it('derives total, remaining, truncated, and nextOffset from the intersection', async () => {
      fetchMock.mockImplementation(
        routeSearch(idsBody([1, 2, 3, 4, 5, 6]), idsBody([2, 3, 5, 6, 99])),
      );
      const result = await getMetService().search(
        { q: 'cat', medium: 'Paintings', limit: 2 },
        createMockContext(),
      );

      // Intersection is [2, 3, 5, 6]; the upstream filtered total of 6 is discarded.
      expect(result.total).toBe(4);
      expect(result.objectIDs).toEqual([2, 3]);
      expect(result.returned).toBe(2);
      expect(result.truncated).toBe(true);
      expect(result.remaining).toBe(2);
      expect(result.nextOffset).toBe(2);
    });

    it('slices the intersection by offset and limit, not the raw filtered array', async () => {
      fetchMock.mockImplementation(routeSearch(idsBody([1, 2, 3, 4, 5, 6]), idsBody([2, 3, 5, 6])));
      const result = await getMetService().search(
        { q: 'cat', isOnView: true, limit: 2, offset: 1 },
        createMockContext(),
      );

      // Offset 1 of the intersection [2, 3, 5, 6] — not offset 1 of [1..6].
      expect(result.objectIDs).toEqual([3, 5]);
      expect(result.offset).toBe(1);
      expect(result.total).toBe(4);
      expect(result.remaining).toBe(1);
      expect(result.nextOffset).toBe(3);
    });

    it('an offset past the end of the intersection returns an empty page, not an error', async () => {
      fetchMock.mockImplementation(routeSearch(idsBody([1, 2, 3, 4, 5, 6]), idsBody([2, 3])));
      const result = await getMetService().search(
        { q: 'cat', isHighlight: true, limit: 10, offset: 5 },
        createMockContext(),
      );

      // Offset 5 runs past the 2-ID intersection even though the filtered run had 6.
      expect(result.objectIDs).toEqual([]);
      expect(result.returned).toBe(0);
      expect(result.total).toBe(2);
      expect(result.offset).toBe(5);
      expect(result.remaining).toBe(0);
      expect(result.nextOffset).toBeNull();
    });

    it('reports total 0 when nothing in the filtered run matched the query', async () => {
      // The #21 reproduction: a nonsense keyword whose filtered run is the floor alone.
      fetchMock.mockImplementation(
        routeSearch(
          { total: 3, objectIDs: [437261, 228990, 436043] },
          { total: 0, objectIDs: null },
        ),
      );
      const result = await getMetService().search(
        { q: 'zzzqqqxyz', isPublicDomain: true, limit: 5 },
        createMockContext(),
      );

      expect(result.total).toBe(0);
      expect(result.objectIDs).toEqual([]);
      expect(result.returned).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('issues the control run with q alone, stripping every filter parameter', async () => {
      fetchMock.mockImplementation(routeSearch(idsBody([1]), idsBody([1])));
      await getMetService().search(
        {
          q: 'cat',
          limit: 20,
          hasImages: true,
          isPublicDomain: true,
          isHighlight: true,
          isOnView: true,
          medium: 'Paintings',
          departmentId: 11,
          geoLocation: ['France'],
          dateBegin: 1800,
          dateEnd: 1900,
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
      const control = urls.find((url) => isControlRun(url));
      const filtered = urls.find((url) => !isControlRun(url));

      expect([...(control?.searchParams.keys() ?? [])]).toEqual(['q']);
      expect(control?.searchParams.get('q')).toBe('cat');
      // The filtered run is untouched — the control run is an addition, not a rewrite.
      expect(filtered?.searchParams.get('medium')).toBe('Paintings');
      expect(filtered?.searchParams.get('dateBegin')).toBe('1800');
      expect(filtered?.searchParams.getAll('geoLocation')).toEqual(['France']);
    });

    it.each([
      ['hasImages true', { hasImages: true }],
      ['hasImages false', { hasImages: false }],
      ['isOnView', { isOnView: true }],
      ['isPublicDomain', { isPublicDomain: true as const }],
      ['isHighlight', { isHighlight: true as const }],
      ['medium', { medium: 'Paintings' }],
      ['departmentId', { departmentId: 11 }],
      ['geoLocation', { geoLocation: ['France'] }],
      ['date range', { dateBegin: 1800, dateEnd: 1900 }],
    ])('issues a control run for %s', async (_label, filter) => {
      fetchMock.mockImplementation(routeSearch(idsBody([1, 2]), idsBody([1])));
      const result = await getMetService().search(
        { q: 'cat', limit: 20, ...filter },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.objectIDs).toEqual([1]);
    });

    it('an unfiltered search issues exactly one upstream request and keeps the upstream total', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ total: 97, objectIDs: [1, 2, 3] }));
      const result = await getMetService().search(
        { q: 'sunflower', limit: 20 },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect([...new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.keys()]).toEqual(['q']);
      // Unfiltered behavior is untouched: the upstream total stands as reported.
      expect(result.total).toBe(97);
      expect(result.objectIDs).toEqual([1, 2, 3]);
    });

    it('issues the two runs in parallel rather than one after the other', async () => {
      let releaseFiltered!: () => void;
      const filteredGate = new Promise<void>((resolve) => {
        releaseFiltered = resolve;
      });
      fetchMock.mockImplementation(async (request: unknown) => {
        if (isControlRun(request)) {
          // Only reachable while the filtered run is still pending — a sequential
          // implementation would block here forever and time the test out.
          releaseFiltered();
          return jsonResponse(idsBody([1, 2]));
        }
        await filteredGate;
        return jsonResponse(idsBody([1, 2, 9]));
      });

      const result = await getMetService().search(
        { q: 'cat', hasImages: true, limit: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([1, 2]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // A control-run failure does not fail the search — that path is covered in the
    // degraded-control block below, alongside the filtered-run timeout that does.

    it('raises no_results through the tool when the intersection is empty', async () => {
      // End to end over the real service: the upstream filtered response is a
      // populated page, and the tool still has to report no_results.
      fetchMock.mockImplementation(
        routeSearch(
          { total: 3, objectIDs: [437261, 228990, 436043] },
          { total: 0, objectIDs: null },
        ),
      );
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const input = metSearchCollections.input.parse({
        q: 'zzzqqqxyz',
        isPublicDomain: true,
        limit: 5,
      });

      const err = await Promise.resolve(metSearchCollections.handler(input, ctx)).catch((e) => e);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data.reason).toBe('no_results');
      // The targeted #20 hint still fires — now reachable behind a filter.
      expect(err.data.recovery.hint).toContain('isPublicDomain');
    });

    it('an intersected page satisfies the output schema and renders through format()', async () => {
      fetchMock.mockImplementation(
        routeSearch(
          { total: 4, objectIDs: SUNFLOWER_FILTERED },
          { total: 97, objectIDs: [436529, 436580] },
        ),
      );
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const input = metSearchCollections.input.parse({
        q: 'sunflower',
        isPublicDomain: true,
        limit: 20,
      });

      const result = await metSearchCollections.handler(input, ctx);
      const parsed = metSearchCollections.output.safeParse(result);
      expect(parsed.error?.message).toBeUndefined();
      expect(parsed.success).toBe(true);

      // content[] carries the intersected count, not the upstream filtered total.
      const text = (metSearchCollections.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Total matches:** 1');
      expect(text).toContain('436529');
      expect(text).not.toContain('228990');
      expect(text).toContain('(complete)');
    });
  });

  /**
   * The control run is the broadest form of the query and can take far longer than
   * the filtered one it corrects: `q=the&departmentId=11` answers in 0.44s with 132
   * IDs, while `q=the` alone needs 12.7s to deliver 2.7 MB — past the default 10s
   * request timeout. Failing the whole search on that would make a fast, working,
   * narrow query unusable in order to strip a floor of 2, so a control failure
   * degrades to the uncorrected behavior and discloses it.
   */
  describe('search — a failed control run degrades instead of failing the search (#21)', () => {
    /** Filtered run succeeds; the unfiltered control run fails with `error`. */
    function controlFails(error: unknown, filtered: unknown = { total: 3, objectIDs: [1, 2, 3] }) {
      return (request: unknown) =>
        isControlRun(request) ? Promise.reject(error) : Promise.resolve(jsonResponse(filtered));
    }

    it('returns the filtered IDs and the upstream total when the control run times out', async () => {
      fetchMock.mockImplementation(controlFails(timeout('Upstream request timed out.')));
      const result = await getMetService().search(
        { q: 'the', isPublicDomain: true, limit: 20 },
        createMockContext(),
      );

      // Uncorrected — exactly what this tool returns today, rather than an error.
      expect(result.objectIDs).toEqual([1, 2, 3]);
      expect(result.total).toBe(3);
      expect(result.returned).toBe(3);
      expect(result.truncated).toBe(false);
    });

    it('does not raise search_timeout when only the control run timed out', async () => {
      fetchMock.mockImplementation(controlFails(timeout('Upstream request timed out.')));
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      await expect(
        getMetService().search({ q: 'the', hasImages: true, limit: 20 }, ctx),
      ).resolves.toMatchObject({ objectIDs: [1, 2, 3] });
    });

    it('still raises search_timeout when the filtered run itself times out', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        isControlRun(request)
          ? Promise.resolve(jsonResponse(idsBody([1, 2, 3])))
          : Promise.reject(timeout('Upstream request timed out.')),
      );
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      const err = await getMetService()
        .search({ q: 'the', hasImages: true, limit: 20 }, ctx)
        .catch((e) => e);

      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data.reason).toBe('search_timeout');
      expect(err.data.retryable).toBe(false);
    });

    it('degrades on a non-timeout control failure too', async () => {
      fetchMock.mockImplementation(controlFails(new Error('socket hang up')));
      const result = await getMetService().search(
        { q: 'the', medium: 'Paintings', limit: 20 },
        createMockContext(),
      );

      expect(result.objectIDs).toEqual([1, 2, 3]);
      expect(result.total).toBe(3);
    });

    it('does not re-run the whole search through withRetry when the control run fails', async () => {
      fetchMock.mockImplementation(controlFails(new Error('socket hang up')));
      await getMetService().search({ q: 'the', hasImages: true, limit: 20 }, createMockContext());

      // One filtered call and one control call — a retried search would show more.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('attaches a notice naming the query, the risk, and the way to get the check to run', async () => {
      fetchMock.mockImplementation(controlFails(timeout('Upstream request timed out.')));
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      await getMetService().search({ q: 'the', isPublicDomain: true, limit: 20 }, ctx);

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('"the"');
      expect(notice).toContain('unrelated');
      expect(notice).toContain('narrower keyword');
      expect(notice).toContain('met_get_object');
    });

    it('attaches no notice when the control run succeeded', async () => {
      fetchMock.mockImplementation(routeSearch(idsBody([1, 2, 3]), idsBody([1, 2])));
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const result = await getMetService().search(
        { q: 'cat', isPublicDomain: true, limit: 20 },
        ctx,
      );

      expect(result.objectIDs).toEqual([1, 2]);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('attaches no notice to an unfiltered search', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ total: 97, objectIDs: [1, 2, 3] }));
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      await getMetService().search({ q: 'sunflower', limit: 20 }, ctx);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('a control run that legitimately matched nothing still empties the intersection', async () => {
      // A resolved `objectIDs: null` is the upstream's "zero matches", not a failure
      // — degrading here would put no_results back out of reach, the whole defect.
      fetchMock.mockImplementation(
        routeSearch(
          { total: 3, objectIDs: [437261, 228990, 436043] },
          { total: 0, objectIDs: null },
        ),
      );
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const result = await getMetService().search(
        { q: 'zzzqqqxyz', isPublicDomain: true, limit: 5 },
        ctx,
      );

      expect(result.total).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('carries the notice onto structuredContent and content[] through the tool contract', async () => {
      // runToolContract runs the real pipeline — output parse, format(), enrichment
      // merge and trailer — so this proves the notice lands where clients read it,
      // on both surfaces, rather than merely having been requested.
      fetchMock.mockImplementation(controlFails(timeout('Upstream request timed out.')));

      const result = await runToolContract(metSearchCollections, {
        q: 'the',
        isPublicDomain: true,
        limit: 20,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.total).toBe(3);
      expect(structured.objectIDs).toEqual([1, 2, 3]);
      expect(String(structured.notice)).toContain('unrelated');

      const text = (result.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain('**Total matches:** 3');
      expect(text).toContain('unrelated');
      expect(text).toContain('narrower keyword');
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
