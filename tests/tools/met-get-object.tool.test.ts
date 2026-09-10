/**
 * @fileoverview Tests for met_get_object tool.
 * @module tests/tools/met-get-object.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metGetObject } from '@/mcp-server/tools/definitions/met-get-object.tool.js';
import { escapeMarkdown } from '@/utils/markdown.js';

const mockGetObject = vi.fn();

vi.mock('@/services/met/met-service.js', () => ({
  getMetService: () => ({
    getObject: mockGetObject,
  }),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ batchConcurrency: 5, requestTimeoutMs: 10000, baseUrl: 'http://test' }),
}));

const sampleRecord = {
  objectID: 437980,
  title: 'Wheat Field with Cypresses',
  isPublicDomain: true,
  hasCC0Image: true,
  primaryImage: 'https://example.com/full.jpg',
  primaryImageSmall: 'https://example.com/small.jpg',
  additionalImages: ['https://example.com/alt.jpg'],
  objectURL: 'https://metmuseum.org/art/collection/437980',
  department: 'European Paintings',
  objectName: 'Painting',
  classification: 'Paintings',
  isHighlight: true,
  isTimelineWork: false,
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
      constituentULAN_URL: '',
      constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q5582',
      gender: '',
    },
  ],
  objectDate: '1889',
  objectBeginDate: 1889,
  objectEndDate: 1889,
  medium: 'Oil on canvas',
  dimensions: '28 7/8 × 36 3/4 in.',
  culture: '',
  period: '',
  dynasty: '',
  accessionNumber: '93.21',
  creditLine: 'Purchase',
  country: '',
  region: '',
  geography: {
    geographyType: '',
    city: '',
    state: '',
    county: '',
    subregion: '',
    locale: '',
    locus: '',
    excavation: '',
    river: '',
  },
  measurements: [
    {
      elementName: 'Overall',
      elementDescription: '',
      elementMeasurements: { Height: 73.2, Width: 93.4 },
    },
  ],
  tags: [{ term: 'Landscapes', AAT_URL: '', Wikidata_URL: '' }],
  objectWikidata_URL: 'https://www.wikidata.org/wiki/Q45585',
  GalleryNumber: '825',
};

/**
 * Met object 1's sparse live shape: empty strings across the board, `tags` and
 * `constituents` null, empty `additionalImages`, false booleans. Exercises the
 * empty/null/false branches of format() that the populated sampleRecord never reaches.
 */
const sparseRecord = {
  objectID: 1,
  title: '',
  isPublicDomain: false,
  hasCC0Image: false,
  primaryImage: '',
  primaryImageSmall: '',
  additionalImages: [] as string[],
  objectURL: '',
  department: '',
  objectName: '',
  classification: '',
  isHighlight: false,
  isTimelineWork: false,
  artistDisplayName: '',
  artistDisplayBio: '',
  artistNationality: '',
  artistBeginDate: '',
  artistEndDate: '',
  constituents: null,
  objectDate: '',
  objectBeginDate: 0,
  objectEndDate: 0,
  medium: '',
  dimensions: '',
  culture: '',
  period: '',
  dynasty: '',
  accessionNumber: '',
  creditLine: '',
  country: '',
  region: '',
  geography: {
    geographyType: '',
    city: '',
    state: '',
    county: '',
    subregion: '',
    locale: '',
    locus: '',
    excavation: '',
    river: '',
  },
  measurements: null as
    | {
        elementName: string;
        elementDescription: string;
        elementMeasurements: Record<string, number>;
      }[]
    | null,
  tags: null,
  objectWikidata_URL: '',
  GalleryNumber: '',
};

/**
 * Configure the service mock so fetches COMPLETE in the reverse of input order —
 * the first input ID resolves last. This is the adversarial timing that a
 * completion-ordered handler reorders; a synchronous mock resolves in input order
 * and would pass even the buggy code, making the regression test vacuous. IDs in
 * `notFound` resolve to null (a 404), landing them in failed[].
 */
function mockCompletionInReverseOrder(ids: number[], notFound = new Set<number>()): void {
  mockGetObject.mockImplementation((objectID: number) => {
    const delayMs = (ids.length - ids.indexOf(objectID)) * 5;
    return new Promise((resolve) => {
      setTimeout(
        () => resolve(notFound.has(objectID) ? null : { ...sampleRecord, objectID }),
        delayMs,
      );
    });
  });
}

/** The budget the tool applies, mirrored here so the arithmetic is explicit. */
const BUDGET = 60_000;

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * A record whose serialized size is `targetBytes`, padded through a single
 * ASCII prose field so the size is exact and the padding is inert to format().
 */
function sizedRecord(objectID: number, targetBytes: number) {
  const base = { ...sampleRecord, objectID, creditLine: '' };
  return { ...base, creditLine: 'x'.repeat(Math.max(0, targetBytes - utf8Bytes(base))) };
}

/** Resolve each mocked ID to its record; anything else is a 404. */
function mockRecords(records: { objectID: number }[]): void {
  const byId = new Map(records.map((r) => [r.objectID, r]));
  mockGetObject.mockImplementation((objectID: number) => byId.get(objectID) ?? null);
}

/**
 * The handler result plus the enrichment it accumulated on the way. `ids`
 * defaults to the mocked records; pass it explicitly to interleave IDs that
 * are not mocked, which the service mock resolves as 404s, or to repeat one.
 */
async function run(
  records: { objectID: number }[],
  ids: number[] = records.map((r) => r.objectID),
) {
  mockRecords(records);
  const ctx = createMockContext({ errors: metGetObject.errors });
  const result = await metGetObject.handler(metGetObject.input.parse({ objectIDs: ids }), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

/** Numeric, not lexicographic — real Met object IDs are multi-digit. */
const byNumber = (a: number, b: number) => a - b;

describe('metGetObject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns fetched objects on success', async () => {
    mockGetObject.mockResolvedValue(sampleRecord);

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [437980] });
    const result = await metGetObject.handler(input, ctx);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]?.objectID).toBe(437980);
    expect(result.failed).toHaveLength(0);
  });

  it('reports 404 as failed item in the failed array', async () => {
    // When a single ID returns null (404), it goes to failed[]; all_failed is only thrown
    // when objects.length === 0 (every single fetch failed), which happens here too for
    // a single-ID request. The partial-success test below covers the real case.
    // This test validates the failed-array structure by checking a multi-ID partial success.
    mockGetObject
      .mockResolvedValueOnce(sampleRecord) // first ID succeeds
      .mockResolvedValue(null); // second ID is 404

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [437980, 999999] });
    const result = await metGetObject.handler(input, ctx);
    expect(result.objects).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.objectID).toBe(999999);
  });

  it('throws all_not_found when every fetch returns 404', async () => {
    mockGetObject.mockResolvedValue(null);

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [999999] });
    await expect(metGetObject.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'all_not_found' },
    });
  });

  it('throws all_failed when every fetch throws a network error', async () => {
    mockGetObject.mockRejectedValue(new Error('network error'));

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [999999] });
    await expect(metGetObject.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'all_failed' },
    });
  });

  it('throws all_failed when failures are a mix of 404 and network errors', async () => {
    mockGetObject
      .mockResolvedValueOnce(null) // first ID is 404
      .mockRejectedValue(new Error('network error')); // second ID throws

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [888888, 999999] });
    await expect(metGetObject.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'all_failed' },
    });
  });

  it('handles partial success — some succeed, some throw', async () => {
    mockGetObject.mockResolvedValueOnce(sampleRecord).mockRejectedValue(new Error('network error'));

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [437980, 999999] });
    const result = await metGetObject.handler(input, ctx);
    expect(result.objects).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.objectID).toBe(999999);
  });

  it('returns objects[] in input order when fetches complete out of order', async () => {
    // Non-monotonic IDs so the assertion locks to INPUT order, not a numeric sort.
    const ids = [104, 100, 106, 102];
    mockCompletionInReverseOrder(ids);

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: ids });
    const result = await metGetObject.handler(input, ctx);

    // Completion order was [102, 106, 100, 104]; output must still mirror the input.
    expect(result.objects.map((o) => o.objectID)).toEqual(ids);
    expect(result.failed).toHaveLength(0);
  });

  it('keeps objects[] and failed[] in input order for an interleaved partial batch', async () => {
    // 201 and 202 are interleaved 404s; the surviving successes and the failures must
    // each preserve input order independently.
    const ids = [100, 201, 102, 202, 104];
    mockCompletionInReverseOrder(ids, new Set([201, 202]));

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: ids });
    const result = await metGetObject.handler(input, ctx);

    expect(result.objects.map((o) => o.objectID)).toEqual([100, 102, 104]);
    expect(result.failed.map((f) => f.objectID)).toEqual([201, 202]);
  });

  it('format renders key fields including boolean field names', () => {
    const blocks = metGetObject.format!({
      objects: [sampleRecord],
      failed: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Wheat Field with Cypresses');
    expect(text).toContain('isPublicDomain');
    expect(text).toContain('hasCC0Image');
    expect(text).toContain('constituentID');
    expect(text).toContain('437980');
    expect(text).toContain('Vincent van Gogh');
  });

  it('format renders failed fetches', () => {
    const blocks = metGetObject.format!({
      objects: [sampleRecord],
      failed: [{ objectID: 99, error: 'Not found.' }],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Failed Fetches');
    expect(text).toContain('99');
  });

  it('format renders a placeholder for every empty field (sparse object 1 shape)', () => {
    const blocks = metGetObject.format!({ objects: [sparseRecord], failed: [] });
    const text = (blocks[0] as { text: string }).text;
    // Every otherwise-dropped empty field must surface a placeholder in content[] —
    // structuredContent already carries these values; content[] must not lose them.
    expect(text).toContain('## (Untitled) — Object 1');
    expect(text).toContain('**Artist:** —');
    expect(text).toContain('**Nationality:** —');
    expect(text).toContain('**Artist dates:** —');
    expect(text).toContain('**Classification:** —');
    expect(text).toContain('**Medium:** —');
    expect(text).toContain('**Dimensions:** —');
    expect(text).toContain('**Culture:** —');
    expect(text).toContain('**Period:** —');
    expect(text).toContain('**Dynasty:** —');
    expect(text).toContain('**Geography:** —');
    expect(text).toContain('**Credit:** —');
    expect(text).toContain('**Gallery:** —');
    expect(text).toContain('**URL:** —');
    expect(text).toContain('**Image (full):** —');
    expect(text).toContain('**Image (small):** —');
    expect(text).toContain('**Additional images:** —');
    expect(text).toContain('**Wikidata:** —');
    expect(text).toContain('**Tags:** —');
    expect(text).toContain('**Constituents:** —');
    // Empty failed[] renders an explicit placeholder, not an omitted section.
    expect(text).toContain('**Failed fetches:** none');
  });

  describe('batch byte budget (#15)', () => {
    it('returns every record and discloses nothing when the batch fits', async () => {
      const { result, enrichment } = await run([sizedRecord(1, 5_000), sizedRecord(2, 5_000)]);

      expect(result.objects).toHaveLength(2);
      // A fitting batch is what it was before the budget existed: no disclosure
      // field appears at all on either surface — absent, not empty.
      expect(result.deferred).toBeUndefined();
      expect(enrichment.notice).toBeUndefined();
      expect((metGetObject.format!(result)[0] as { text: string }).text).not.toContain('Deferred');
    });

    it('defers whole records once the cumulative budget is spent', async () => {
      // 3 × 20,000 lands exactly on the budget; the fourth cannot fit.
      const { result } = await run([
        sizedRecord(1, 20_000),
        sizedRecord(2, 20_000),
        sizedRecord(3, 20_000),
        sizedRecord(4, 20_000),
      ]);

      expect(result.objects.map((o) => o.objectID)).toEqual([1, 2, 3]);
      expect(result.deferred?.map((d) => d.objectID)).toEqual([4]);
      // Every returned record is whole — a deferral never splits one.
      expect(result.objects.every((o) => o.title === sampleRecord.title)).toBe(true);
    });

    it('delivers a response larger than the budget, since content[] repeats the records', async () => {
      mockRecords([sizedRecord(1, 50_000), sizedRecord(2, 30_000)]);
      const called = await runToolContract(metGetObject, { objectIDs: [1, 2] });

      const structuredBytes = utf8Bytes(called.structuredContent);
      const contentBytes = utf8Bytes(called.content);
      const admittedBytes = (
        called.structuredContent as { objects: unknown[] }
      ).objects.reduce<number>((sum, o) => sum + utf8Bytes(o), 0);

      // What the budget actually bounds: the admitted records, serialized.
      expect(admittedBytes).toBeLessThanOrEqual(BUDGET);
      // content[] renders those same records again, on the same order of
      // magnitude, so what reaches the wire is roughly twice the budget — which
      // is why the notice must not present the budget as a response-size cap.
      expect(contentBytes).toBeGreaterThan(admittedBytes / 2);
      expect(structuredBytes + contentBytes).toBeGreaterThan(BUDGET);
    });

    it('names the surface the budget measures, and that the response is larger', async () => {
      const { enrichment } = await run([sizedRecord(1, 50_000), sizedRecord(2, 30_000)]);

      expect(enrichment.notice).toContain('structuredContent');
      expect(enrichment.notice).toContain('content[]');
      // An unqualified "60000-byte batch budget" reads as a bound on the response
      // an agent is about to receive, which is roughly double that.
      expect(enrichment.notice).not.toMatch(/60000-byte batch budget/);
    });

    it('reports each deferred record’s size so a follow-up batch can be sized', async () => {
      const { result, enrichment } = await run([sizedRecord(1, 50_000), sizedRecord(2, 30_000)]);

      expect(result.deferred).toEqual([{ objectID: 2, bytes: 30_000 }]);
      expect(enrichment.notice).toContain('60000-byte budget measured on that surface alone');
      expect(enrichment.notice).toContain('Returned 1 of 2 fetched records');
    });

    it('admits the first record unconditionally even when it alone exceeds the budget', async () => {
      // Without the unconditional first admission this ID is unreachable: every
      // call that requests it would defer it forever.
      const { result } = await run([sizedRecord(1, BUDGET + 20_000), sizedRecord(2, 1_000)]);

      expect(result.objects.map((o) => o.objectID)).toEqual([1]);
      expect(result.deferred?.map((d) => d.objectID)).toEqual([2]);
    });

    it('partitions every requested ID across objects, failed, and deferred exactly once', async () => {
      // Real multi-digit Met IDs: a single-digit fixture makes the union comparison
      // below pass under a lexicographic sort, which would not hold for real input.
      // 11207 and 45734 are interleaved 404s; 548211 overflows and 544683 follows
      // it into deferred.
      const requested = [437980, 11207, 548211, 544683, 45734];
      const { result: mixed } = await run(
        [sizedRecord(437980, 30_000), sizedRecord(548211, 40_000), sizedRecord(544683, 2_000)],
        requested,
      );

      const returned = mixed.objects.map((o) => o.objectID);
      const failed = mixed.failed.map((f) => f.objectID);
      const deferred = mixed.deferred?.map((d) => d.objectID) ?? [];

      expect(returned).toEqual([437980]);
      expect(failed).toEqual([11207, 45734]);
      expect(deferred).toEqual([548211, 544683]);

      const union = [...returned, ...failed, ...deferred];
      expect([...union].sort(byNumber)).toEqual([...requested].sort(byNumber));
      // Exactly once, not merely all-present: a duplicated ID would still satisfy
      // a membership check while breaking the partition.
      expect(new Set(union).size).toBe(union.length);
    });

    it('spends the budget in request order when fetches complete out of order', async () => {
      // The budget cases above mock a synchronous service, so they resolve in input
      // order no matter how the handler assembles its results — a completion-ordered
      // handler would pass them and still return a scattered set. Here the first
      // input ID resolves last, which is what makes "objects[] is a prefix of the
      // successes in request order" a real assertion rather than a restatement.
      const ids = [104, 100, 106, 102, 108];
      const byId = new Map(ids.map((id) => [id, sizedRecord(id, 25_000)]));
      mockGetObject.mockImplementation(
        (objectID: number) =>
          new Promise((resolve) =>
            setTimeout(() => resolve(byId.get(objectID)), (ids.length - ids.indexOf(objectID)) * 5),
          ),
      );

      const ctx = createMockContext({ errors: metGetObject.errors });
      const result = await metGetObject.handler(metGetObject.input.parse({ objectIDs: ids }), ctx);

      // 2 × 25,000 fits; a third would not. Completion order was [108, 102, 106, 100, 104].
      expect(result.objects.map((o) => o.objectID)).toEqual([104, 100]);
      expect(result.deferred?.map((d) => d.objectID)).toEqual([106, 102, 108]);
    });

    it('bounds a heavy 20-ID batch, in request order, under the budget', async () => {
      // The reported defect's shape: twenty records each far heavier than typical.
      const records = Array.from({ length: 20 }, (_, i) => sizedRecord(i + 1, 5_000));
      const { result } = await run(records);

      expect(result.objects.map((o) => o.objectID)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(result.deferred?.map((d) => d.objectID)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
      // The invariant the handler enforces: the sum of the admitted records fits,
      // and one more would have broken it.
      const admitted = result.objects.reduce((sum, o) => sum + utf8Bytes(o), 0);
      expect(admitted).toBeLessThanOrEqual(BUDGET);
      expect(admitted + (result.deferred?.[0]?.bytes ?? 0)).toBeGreaterThan(BUDGET);
    });

    it('leaves a sparse batch of many records entirely untouched', async () => {
      const records = Array.from({ length: 20 }, (_, i) => ({ ...sparseRecord, objectID: i + 1 }));
      const { result } = await run(records);

      expect(result.objects).toHaveLength(20);
      expect(result.deferred).toBeUndefined();
    });

    it('discloses the same budget outcome on both client surfaces', async () => {
      // Driven through the real contract boundary so structuredContent and
      // content[] are the ones a client would actually receive — enrichment
      // included, which format() never renders itself.
      mockRecords([sizedRecord(1, 50_000), sizedRecord(2, 30_000)]);
      const called = await runToolContract(metGetObject, { objectIDs: [1, 2] });

      const structured = called.structuredContent as {
        objects: { objectID: number }[];
        deferred?: { objectID: number; bytes: number }[];
        notice?: string;
      };
      const text = called.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

      expect(structured.objects.map((o) => o.objectID)).toEqual([1]);
      expect(structured.deferred).toEqual([{ objectID: 2, bytes: 30_000 }]);
      expect(structured.notice).toContain('Returned 1 of 2 fetched records');

      // The same outcome, in the markdown twin — including the caveat that the
      // budget bounds structuredContent, not the response the caller receives.
      expect(text).toContain('## Deferred — batch byte budget');
      expect(text).toContain('- **2:** 30000 bytes');
      expect(text).toContain('Returned 1 of 2 fetched records');
      expect(text).toContain('the delivered response is roughly twice that');
      expect(structured.notice).toContain('the delivered response is roughly twice that');
    });
  });

  describe('duplicate object IDs', () => {
    it('fetches and returns a repeated ID once', async () => {
      const { result } = await run([sizedRecord(437980, 5_000)], [437980, 437980]);

      expect(result.objects.map((o) => o.objectID)).toEqual([437980]);
      expect(result.deferred).toBeUndefined();
      expect(mockGetObject).toHaveBeenCalledTimes(1);
    });

    it('never lists a repeated ID in both objects[] and deferred[]', async () => {
      // One ID heavy enough to spend the budget, requested twice: the second
      // occurrence overflows and the caller is told to re-request a record it
      // already received, breaking the returned/failed/deferred partition.
      const { result } = await run([sizedRecord(437980, 50_000)], [437980, 437980]);

      expect(result.objects.map((o) => o.objectID)).toEqual([437980]);
      expect(result.deferred).toBeUndefined();
    });

    it('does not let a repeat spend the budget twice and displace a distinct record', async () => {
      const { result } = await run(
        [sizedRecord(437980, 50_000), sizedRecord(548211, 5_000)],
        [437980, 437980, 548211],
      );

      // 50,000 + 5,000 fits the budget; charging 437980 twice would defer 548211.
      expect(result.objects.map((o) => o.objectID)).toEqual([437980, 548211]);
      expect(result.deferred).toBeUndefined();
    });

    it('collapses an all-duplicate call to one fetch and one record', async () => {
      const { result } = await run([sizedRecord(437980, 5_000)], [437980, 437980, 437980]);

      expect(result.objects.map((o) => o.objectID)).toEqual([437980]);
      expect(mockGetObject).toHaveBeenCalledTimes(1);
    });

    it('reports a repeated ID that fails upstream once in failed[]', async () => {
      // 11207 is not mocked, so the service mock resolves it as a 404.
      const { result } = await run([sizedRecord(437980, 5_000)], [437980, 11207, 11207]);

      expect(result.objects.map((o) => o.objectID)).toEqual([437980]);
      expect(result.failed.map((f) => f.objectID)).toEqual([11207]);
    });

    it('counts unique IDs, not repeats, when every fetch fails', async () => {
      mockRecords([]);
      const ctx = createMockContext({ errors: metGetObject.errors });

      await expect(
        metGetObject.handler(metGetObject.input.parse({ objectIDs: [11207, 11207] }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'all_not_found' },
        message: expect.stringContaining('All 1 requested object ID not found'),
      });
    });

    it('keeps a repeated ID at its first requested position', async () => {
      const { result } = await run(
        [sizedRecord(437980, 5_000), sizedRecord(548211, 5_000), sizedRecord(544683, 5_000)],
        [544683, 437980, 548211, 437980],
      );

      expect(result.objects.map((o) => o.objectID)).toEqual([544683, 437980, 548211]);
    });

    it('leaves a duplicate-free call untouched', async () => {
      const { result, enrichment } = await run([
        sizedRecord(437980, 5_000),
        sizedRecord(548211, 5_000),
      ]);

      expect(result.objects.map((o) => o.objectID)).toEqual([437980, 548211]);
      expect(result.failed).toEqual([]);
      expect(result.deferred).toBeUndefined();
      expect(enrichment.notice).toBeUndefined();
      expect(mockGetObject).toHaveBeenCalledTimes(2);
    });

    it('renders a repeated ID once on both client surfaces', async () => {
      mockRecords([sizedRecord(437980, 5_000)]);
      const called = await runToolContract(metGetObject, { objectIDs: [437980, 437980] });

      const structured = called.structuredContent as {
        objects: { objectID: number }[];
        deferred?: { objectID: number }[];
      };
      const text = called.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

      expect(structured.objects.map((o) => o.objectID)).toEqual([437980]);
      expect(structured.deferred).toBeUndefined();
      expect(text.match(/— Object 437980/g)).toHaveLength(1);
    });
  });

  describe('geography and measurements (#16)', () => {
    /** 548211's shape after normalization — seven findspot fields, three axes. */
    const geographyRichRecord = {
      ...sparseRecord,
      objectID: 548211,
      title: 'Sarcophagus of Harkhebit',
      country: 'Egypt',
      region: 'Memphite Region',
      geography: {
        geographyType: 'From',
        city: '',
        state: '',
        county: '',
        subregion: 'Saqqara',
        locale: 'Late Period cemetery, Tomb of Harkhebit',
        locus: 'burial chamber',
        excavation: 'Egyptian Antiquities Service excavations, 1902',
        river: '',
      },
      measurements: [
        {
          elementName: 'Overall',
          elementDescription: '',
          elementMeasurements: { Height: 256.5405, Thickness: 132.0803, Width: 127.0003 },
        },
      ],
    };

    /** 544683's shape — sibling elements carrying different axis keys. */
    const multiMeasurementRecord = {
      ...sparseRecord,
      objectID: 544683,
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
          elementDescription: '',
          elementMeasurements: { Height: 17, Width: 12.5 },
        },
      ],
    };

    const render = (record: typeof sparseRecord) =>
      (metGetObject.format!({ objects: [record], failed: [] })[0] as { text: string }).text;

    it('renders populated findspot fields on the existing Geography line', () => {
      const text = render(geographyRichRecord);

      expect(text).toContain(
        '**Geography:** Egypt, Memphite Region (Type: From; Subregion: Saqqara; Locale: Late Period cemetery, Tomb of Harkhebit; Locus: burial chamber; Excavation: Egyptian Antiquities Service excavations, 1902)',
      );
      // Empty findspot fields are omitted, not dashed — nine placeholders would
      // bury the two fields that are usually populated.
      expect(text).not.toContain('City:');
      expect(text).not.toContain('River:');
    });

    it('leaves the Geography line exactly as it was when no findspot is recorded', () => {
      // sampleRecord has an all-empty geography block, so its line must not gain
      // a parenthetical.
      const text = (
        metGetObject.format!({ objects: [sampleRecord], failed: [] })[0] as { text: string }
      ).text;
      expect(text).toContain('**Geography:** —\n');
    });

    it('renders every measurement element with its own axis keys', () => {
      const text = render(multiMeasurementRecord);

      expect(text).toContain(
        '**Measurements:** Other (Depth nxt to boy): Depth 4.8; Other (Depth nxt to man): Depth 5.7; Overall: Height 17, Width 12.5',
      );
    });

    it('renders a multi-axis element without inventing axes it does not carry', () => {
      const text = render(geographyRichRecord);

      expect(text).toContain(
        '**Measurements:** Overall: Height 256.5405, Thickness 132.0803, Width 127.0003',
      );
      expect(text).not.toContain('Depth');
      expect(text).not.toContain('Length');
    });

    it('renders a placeholder when measurements is null, like the other nullable arrays', () => {
      expect(render(sparseRecord)).toContain('**Measurements:** —');
    });

    it('escapes upstream text in element names, descriptions, and axis keys', () => {
      // The axis keys are upstream map keys, not schema-fixed labels — they reach
      // content[] as text and are escaped on the same boundary as the values.
      const text = render({
        ...sparseRecord,
        measurements: [
          {
            elementName: '[Overall]',
            elementDescription: '*sight*',
            elementMeasurements: { Height_max: 12 },
          },
        ],
      });

      expect(text).toContain('**Measurements:** \\[Overall\\] (\\*sight\\*): Height\\_max 12');
    });
  });

  describe('format — unknown machine-readable date (#14)', () => {
    /** Object 61296's shape after normalization: no machine-readable range. */
    const nullDateRecord = {
      ...sparseRecord,
      objectID: 61296,
      title: 'Bodhisattvas of the Four Directions(?)',
      objectDate: 'date unknown',
      objectBeginDate: null,
      objectEndDate: null,
    };

    it('renders objectDate alone, never a fabricated or null range', () => {
      const blocks = metGetObject.format!({ objects: [nullDateRecord], failed: [] });
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('**Date:** date unknown');
      expect(text).not.toContain('0–0');
      expect(text).not.toContain('null');
    });

    it('still renders the range for a genuine BCE record', () => {
      const blocks = metGetObject.format!({
        objects: [
          {
            ...sparseRecord,
            objectID: 547802,
            objectDate: 'completed by 10 CE',
            objectBeginDate: -10,
            objectEndDate: -10,
          },
        ],
        failed: [],
      });
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('**Date:** completed by 10 CE (-10–-10)');
    });

    it('still renders the range for a genuine CE record', () => {
      const blocks = metGetObject.format!({ objects: [sampleRecord], failed: [] });
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('**Date:** 1889 (1889–1889)');
    });
  });

  describe('format — Markdown escaping of upstream text (#18)', () => {
    /**
     * Object 288322's real title shape (cataloger-supplied titles are bracketed),
     * plus tags[] and constituents[] whose items differ from one another: the
     * first of each carries metacharacters and no URLs, the second is plain text
     * with both URLs populated. A uniform array would let a per-item bug through.
     */
    const metacharacterRecord = {
      ...sampleRecord,
      objectID: 288322,
      title: '[Group of 122 Stereograph Views]',
      creditLine: 'Gilman Collection *Purchase* <2005>',
      dimensions: 'Overall\r\n# Mount: 5 x 7 in. (12.7 x 17.8 cm)',
      artistDisplayName: 'Unknown_Photographer',
      tags: [
        { term: '[Stereographs]', AAT_URL: '', Wikidata_URL: '' },
        {
          term: 'Men',
          AAT_URL: 'http://vocab.getty.edu/page/aat/300025928',
          Wikidata_URL: 'https://www.wikidata.org/wiki/Q8441',
        },
      ],
      constituents: [
        {
          constituentID: 1,
          role: '*Photographer*',
          name: '[Unknown]',
          constituentULAN_URL: '',
          constituentWikidata_URL: '',
          gender: '_female_',
        },
        {
          constituentID: 161947,
          role: 'Artist',
          name: 'Vincent van Gogh',
          constituentULAN_URL: 'http://vocab.getty.edu/page/ulan/500115588',
          constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q5582',
          gender: '',
        },
      ],
    };

    const renderedText = () =>
      (metGetObject.format!({ objects: [metacharacterRecord], failed: [] })[0] as { text: string })
        .text;

    it('escapes a bracketed title so it cannot form a link label in the heading', () => {
      const text = renderedText();
      expect(text).toContain('## \\[Group of 122 Stereograph Views\\] — Object 288322');
      expect(text).not.toContain('## [Group of 122 Stereograph Views]');
    });

    it('escapes emphasis and raw-HTML characters in prose fields', () => {
      const text = renderedText();
      expect(text).toContain('Gilman Collection \\*Purchase\\* \\<2005>');
      expect(text).toContain('Unknown\\_Photographer');
    });

    it('collapses an embedded newline so no upstream text reaches a line start', () => {
      const text = renderedText();
      expect(text).toContain('**Dimensions:** Overall # Mount: 5 x 7 in. (12.7 x 17.8 cm)');
    });

    it('leaves parentheses and periods in a dimensions value unescaped', () => {
      expect(renderedText()).toContain('(12.7 x 17.8 cm)');
    });

    it('escapes each tags[] item independently, URLs untouched', () => {
      const text = renderedText();
      expect(text).toContain('\\[Stereographs\\]');
      expect(text).not.toContain(' [Stereographs]');
      // The sibling item's link wrapper and destination survive verbatim.
      expect(text).toContain('Men [AAT](http://vocab.getty.edu/page/aat/300025928)');
      expect(text).toContain('[WD](https://www.wikidata.org/wiki/Q8441)');
    });

    it('escapes each constituents[] item independently, URLs untouched', () => {
      const text = renderedText();
      expect(text).toContain('constituentID:1 \\[Unknown\\] (\\*Photographer\\*, \\_female\\_)');
      expect(text).toContain('[ULAN](http://vocab.getty.edu/page/ulan/500115588)');
    });

    it('leaves the server-written heading and bold labels unescaped', () => {
      const text = renderedText();
      expect(text).not.toContain('\\*\\*');
      expect(text).not.toContain('\\#\\#');
      expect(text).toContain('**Credit:**');
    });

    it('renders escaped text while the record itself stays raw', () => {
      // format() must not mutate its input — structuredContent is the same object.
      renderedText();
      expect(metacharacterRecord.title).toBe('[Group of 122 Stereograph Views]');
      expect(renderedText()).toContain(escapeMarkdown('[Group of 122 Stereograph Views]'));
    });
  });

  describe('format — URL-shaped upstream fields are validated, not trusted (#18)', () => {
    /**
     * The nine URL-shaped fields are free catalog text that usually happens to
     * hold a URL, so this fixture carries every boundary across both rendering
     * positions — bare, and inside the server's own `[label](…)` wrapper. Each
     * array holds items that differ from one another, including one valid URL
     * and one hostile value in the same array, so a per-item bug cannot hide
     * behind a uniform fixture.
     *
     * Object 288322's constituent 92583 really does carry `(not assigned)`.
     */
    const urlFieldRecord = {
      ...sampleRecord,
      objectID: 288322,
      // A full link value in a bare position renders as a link today.
      objectURL: '[Met](https://evil.example)',
      primaryImage: 'https://images.metmuseum.org/full.jpg',
      primaryImageSmall: '',
      additionalImages: ['https://images.metmuseum.org/alt.jpg', '(not assigned)'],
      objectWikidata_URL: '[wd](https://evil.example)',
      tags: [
        {
          term: 'Stereographs',
          // Closes the server's own destination early and opens its own link.
          AAT_URL: 'a) [go](https://evil.example',
          Wikidata_URL: 'https://www.wikidata.org/wiki/Q8441',
        },
        { term: 'Men', AAT_URL: 'javascript:alert(1)', Wikidata_URL: '' },
      ],
      constituents: [
        {
          constituentID: 92583,
          role: 'Artist',
          name: 'Truman Ward Ingersoll',
          constituentULAN_URL: '(not assigned)',
          constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q59238987',
          gender: '',
        },
        {
          constituentID: 169986,
          role: 'Artist',
          name: 'Unknown',
          constituentULAN_URL: 'http://vocab.getty.edu/page/ulan/500125274',
          constituentWikidata_URL: '',
          gender: '',
        },
      ],
    };

    const text = () =>
      (metGetObject.format!({ objects: [urlFieldRecord], failed: [] })[0] as { text: string }).text;

    it('renders a valid http/https value as a link destination, unescaped', () => {
      expect(text()).toContain('**Image (full):** https://images.metmuseum.org/full.jpg');
      expect(text()).toContain('[WD](https://www.wikidata.org/wiki/Q8441)');
      expect(text()).toContain('[ULAN](http://vocab.getty.edu/page/ulan/500125274)');
    });

    it('renders a non-URL value as visible text instead of a dead link', () => {
      // Object 288322's real ULAN value: `[ULAN]((not assigned))` is a dead link.
      expect(text()).toContain('ULAN: (not assigned)');
      expect(text()).not.toContain('[ULAN]((not assigned))');
      expect(text()).toContain('https://images.metmuseum.org/alt.jpg, (not assigned)');
    });

    it('renders an empty value as a placeholder, never an empty destination', () => {
      expect(text()).toContain('**Image (small):** —');
      expect(text()).not.toContain('[WD]()');
    });

    it('refuses a non-http scheme as a link destination', () => {
      expect(text()).toContain('AAT: javascript:alert(1)');
      expect(text()).not.toContain('[AAT](javascript:');
    });

    it('neutralizes a value crafted to break out of the link destination', () => {
      // Unescaped, this closes `[AAT](` early and opens an attacker link.
      expect(text()).not.toContain('[AAT](a) [go](https://evil.example)');
      expect(text()).toContain('AAT: a) \\[go\\](https://evil.example');
    });

    it('neutralizes a full link value rendered in a bare position', () => {
      expect(text()).toContain('**URL:** \\[Met\\](https://evil.example)');
      expect(text()).toContain('**Wikidata:** \\[wd\\](https://evil.example)');
    });
  });
});
