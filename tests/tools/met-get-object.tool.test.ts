/**
 * @fileoverview Tests for met_get_object tool.
 * @module tests/tools/met-get-object.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createMockContext,
  getContentBlocks,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { metGetObject } from '@/mcp-server/tools/definitions/met-get-object.tool.js';
import { escapeMarkdown } from '@/utils/markdown.js';

const mockGetObject = vi.fn();

/**
 * The service is stubbed at its accessor; `startCallDeadline` stays real, and so
 * does `fetchImage` — it runs on a real service over the stubbed global fetch,
 * so the host pin, redirect refusal, and status mapping are part of every image
 * case here.
 */
vi.mock('@/services/met/met-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/met/met-service.js')>();
  const real = new actual.MetService({} as AppConfig, {} as StorageService);
  return {
    ...actual,
    getMetService: () => ({
      getObject: mockGetObject,
      fetchImage: (...args: Parameters<typeof real.fetchImage>) => real.fetchImage(...args),
    }),
  };
});

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    batchConcurrency: 5,
    requestTimeoutMs: 10000,
    callDeadlineMs: 30000,
    baseUrl: 'http://test',
  }),
}));

/** The per-call deadline every service call receives as its third argument. */
const aDeadline = () =>
  expect.objectContaining({ deadlineAt: expect.any(Number), signal: expect.any(AbortSignal) });

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
  departmentId: 11 as number | null,
  objectName: 'Painting',
  classification: 'Paintings',
  isHighlight: true,
  isTimelineWork: false,
  artistPrefix: '',
  artistDisplayName: 'Vincent van Gogh',
  artistSuffix: '',
  artistRole: 'Artist',
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
  accessionYear: '1993',
  creditLine: 'Purchase',
  rightsAndReproduction: '',
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
  metadataDate: '2026-04-18T04:56:48.367Z',
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
  departmentId: null as number | null,
  objectName: '',
  classification: '',
  isHighlight: false,
  isTimelineWork: false,
  artistPrefix: '',
  artistDisplayName: '',
  artistSuffix: '',
  artistRole: '',
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
  accessionYear: '',
  creditLine: '',
  rightsAndReproduction: '',
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
  metadataDate: '',
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

type RecordOutput = z.infer<typeof metGetObject.output>['objects'][number];

/** `format()`'s text for a batch of the given records and no failures. */
const renderText = (...objects: RecordOutput[]) =>
  (metGetObject.format!({ objects, failed: [] })[0] as { text: string }).text;

/** The rendered line that starts with `label`, or undefined when none does. */
const lineOf = (text: string, label: string) =>
  text.split('\n').find((line) => line.startsWith(label));

/** Every text block of a tool result's `content[]`, joined. */
const contentText = (result: { content?: { type: string }[] }) =>
  (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

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

  it('words a single-ID all_not_found for the one object it names', async () => {
    mockGetObject.mockResolvedValue(null);

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [999999] });
    await expect(metGetObject.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'all_not_found' },
      message: 'Object 999999 was not found.',
    });
  });

  it('words a multi-ID all_not_found with the count', async () => {
    mockGetObject.mockResolvedValue(null);

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [888888, 999999] });
    await expect(metGetObject.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'all_not_found' },
      message: 'All 2 requested object IDs not found.',
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

  it('words a single-ID all_failed for the one object it names', async () => {
    mockGetObject.mockRejectedValue(new Error('network error'));

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [999999] });
    await expect(metGetObject.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'all_failed' },
      message: 'Object 999999 could not be fetched.',
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

  /**
   * The parts of the Artist, Department, and Accession/Credit lines that the
   * attribution, departmentId, and rights fields must leave as they are.
   */
  describe('format — the record lines new fields extend keep their existing parts', () => {
    const text = renderText(sampleRecord);

    it('renders an unqualified name and bio as it always has', () => {
      expect(lineOf(text, '**Artist:**')).toMatch(
        /^\*\*Artist:\*\* Vincent van Gogh \(Dutch, Zundert 1853–1890 Auvers-sur-Oise\)/,
      );
    });

    it('renders the named artist’s dates on their own line', () => {
      expect(lineOf(text, '**Artist dates:**')).toBe('**Artist dates:** 1853–1890');
    });

    it('keeps department, object name, and classification on the Department line', () => {
      const line = lineOf(text, '**Department:**');
      expect(line).toMatch(/^\*\*Department:\*\* European Paintings \| /);
      expect(line).toMatch(
        / \| \*\*Object name:\*\* Painting \| \*\*Classification:\*\* Paintings$/,
      );
    });

    it('keeps the accession number, credit line, and gallery values', () => {
      expect(lineOf(text, '**Accession:**')).toMatch(/^\*\*Accession:\*\* 93\.21/);
      expect(lineOf(text, '**Credit:**')).toBe('**Credit:** Purchase');
      expect(lineOf(text, '**Gallery:**')).toBe('**Gallery:** 825');
    });
  });

  describe('artist attribution qualifier and role (#38)', () => {
    /** 437403's attribution: a "Style of" work whose dates are Rembrandt's own. */
    const styleOf = {
      ...sampleRecord,
      objectID: 437403,
      artistPrefix: 'Style of',
      artistDisplayName: 'Rembrandt',
      artistSuffix: '',
      artistRole: 'Artist',
      artistDisplayBio: 'Dutch, ca. 1655',
      artistBeginDate: '1606',
      artistEndDate: '1669',
    };
    /** 456947's: a patron, with the reign in the suffix and no bio. */
    const patron = {
      ...sampleRecord,
      objectID: 456947,
      artistDisplayName: 'Sultan Abdülhamid II',
      artistSuffix: '(r. 1876–1909)',
      artistRole: 'Patron',
      artistDisplayBio: '',
      artistBeginDate: '1842',
      artistEndDate: '1918',
    };
    /** Object 338304's attribution in the Open Access CSV, bio left empty: a comma suffix. */
    const commaSuffix = {
      ...sampleRecord,
      objectID: 338304,
      artistPrefix: 'Published by',
      artistDisplayName: 'Thielman Kerver',
      artistSuffix: ', Paris',
      artistRole: 'Publisher',
      artistDisplayBio: '',
    };
    const artistLine = (record: RecordOutput) => lineOf(renderText(record), '**Artist:**');

    it('renders a "Style of" attribution with its qualifier and role', () => {
      expect(artistLine(styleOf)).toBe(
        '**Artist:** Style of Rembrandt (Dutch, ca. 1655) | **Artist role:** Artist',
      );
    });

    it('leaves the named artist’s dates on the Artist dates line', () => {
      expect(lineOf(renderText(styleOf), '**Artist dates:**')).toBe('**Artist dates:** 1606–1669');
    });

    it('renders a patron with the suffix after a space, and the role', () => {
      expect(artistLine(patron)).toBe(
        '**Artist:** Sultan Abdülhamid II (r. 1876–1909) | **Artist role:** Patron',
      );
    });

    it('appends a suffix that starts with a comma directly, with no space', () => {
      expect(artistLine(commaSuffix)).toBe(
        '**Artist:** Published by Thielman Kerver, Paris | **Artist role:** Publisher',
      );
    });

    it('renders a placeholder for an empty attribution and an empty role', () => {
      expect(artistLine(sparseRecord)).toBe('**Artist:** — | **Artist role:** —');
    });

    it('renders an unqualified record’s name and bio as before, plus the role', () => {
      expect(artistLine(sampleRecord)).toBe(
        '**Artist:** Vincent van Gogh (Dutch, Zundert 1853–1890 Auvers-sur-Oise) | **Artist role:** Artist',
      );
    });

    it('trims the whitespace the Met leaves around a prefix or suffix', () => {
      expect(artistLine({ ...styleOf, artistPrefix: 'Style of ' })).toBe(
        '**Artist:** Style of Rembrandt (Dutch, ca. 1655) | **Artist role:** Artist',
      );
      expect(artistLine({ ...commaSuffix, artistSuffix: ' , Paris ' })).toBe(
        '**Artist:** Published by Thielman Kerver, Paris | **Artist role:** Publisher',
      );
    });

    it('renders a suffix alone when the record names no one', () => {
      expect(artistLine({ ...sparseRecord, artistSuffix: 'Chinese, 13th century' })).toBe(
        '**Artist:** Chinese, 13th century | **Artist role:** —',
      );
    });

    it('escapes a qualifier, suffix, and role like the name', () => {
      expect(
        artistLine({
          ...styleOf,
          artistPrefix: '*Attributed to*',
          artistDisplayName: 'Unknown_Maker',
          artistSuffix: '[?]',
          artistRole: '<Artist>',
        }),
      ).toBe(
        '**Artist:** \\*Attributed to\\* Unknown\\_Maker \\[?\\] (Dutch, ca. 1655) | **Artist role:** \\<Artist>',
      );
    });

    it('carries the three fields as sent on structuredContent, through output validation', async () => {
      mockRecords([styleOf, patron]);
      const called = await runToolContract(metGetObject, { objectIDs: [437403, 456947] });

      const { objects } = called.structuredContent as { objects: RecordOutput[] };
      expect(
        objects.map((o) => [o.artistPrefix, o.artistDisplayName, o.artistSuffix, o.artistRole]),
      ).toEqual([
        ['Style of', 'Rembrandt', '', 'Artist'],
        ['', 'Sultan Abdülhamid II', '(r. 1876–1909)', 'Patron'],
      ]);
      const text = contentText(called);
      expect(text).toContain(
        '**Artist:** Style of Rembrandt (Dutch, ca. 1655) | **Artist role:** Artist',
      );
      expect(text).toContain(
        '**Artist:** Sultan Abdülhamid II (r. 1876–1909) | **Artist role:** Patron',
      );
    });

    it('requires all three on the output schema', () => {
      const { artistPrefix: _prefix, ...withoutPrefix } = styleOf;
      expect(metGetObject.output.safeParse({ objects: [styleOf], failed: [] }).success).toBe(true);
      expect(metGetObject.output.safeParse({ objects: [withoutPrefix], failed: [] }).success).toBe(
        false,
      );
    });
  });

  describe('rights, metadata date, and accession year (#41)', () => {
    /** 437403's acquisition fields: the credit line's year (1959) is not accessionYear's (1960). */
    const timken = {
      ...sampleRecord,
      objectID: 437403,
      accessionNumber: '60.71.14',
      accessionYear: '1960',
      creditLine: 'Bequest of Lillian S. Timken, 1959',
      rightsAndReproduction: '',
      metadataDate: '2025-09-17T04:49:46.407Z',
    };
    /** 488978's: a copyrighted work carrying its rights holder. */
    const pollock = {
      ...sampleRecord,
      objectID: 488978,
      isPublicDomain: false,
      accessionNumber: '57.92',
      accessionYear: '1957',
      creditLine: 'George A. Hearn Fund, 1957',
      rightsAndReproduction:
        '© 2026 Pollock-Krasner Foundation / Artists Rights Society (ARS), New York',
      metadataDate: '2026-10-01T04:59:29.693Z',
    };

    it('renders the accession, credit, rights, and metadata-date lines in that order', () => {
      const lines = renderText(timken).split('\n');
      const start = lines.findIndex((line) => line.startsWith('**Accession:**'));
      expect(lines.slice(start, start + 4)).toEqual([
        '**Accession:** 60.71.14 | **Accession year:** 1960',
        '**Credit:** Bequest of Lillian S. Timken, 1959',
        '**Rights:** —',
        '**Metadata date:** 2025-09-17T04:49:46.407Z',
      ]);
    });

    it('renders the rights holder of a copyrighted work', () => {
      expect(lineOf(renderText(pollock), '**Rights:**')).toBe(
        '**Rights:** © 2026 Pollock-Krasner Foundation / Artists Rights Society (ARS), New York',
      );
    });

    it('renders a placeholder for each of the three on a record with none', () => {
      const text = renderText(sparseRecord);
      expect(lineOf(text, '**Accession:**')).toBe('**Accession:** — | **Accession year:** —');
      expect(lineOf(text, '**Rights:**')).toBe('**Rights:** —');
      expect(lineOf(text, '**Metadata date:**')).toBe('**Metadata date:** —');
    });

    it('renders a full-date accessionYear and any fraction length exactly as sent', () => {
      // 286850: a full-date accessionYear and a metadataDate with no fraction;
      // 512: a two-digit fraction.
      const text = renderText(
        {
          ...sampleRecord,
          objectID: 286850,
          accessionNumber: '2005.100.429',
          accessionYear: '2005-02-15',
          metadataDate: '2025-03-06T04:54:30Z',
        },
        { ...sampleRecord, objectID: 512, metadataDate: '2023-02-07T04:46:51.34Z' },
      );
      expect(text).toContain('**Accession:** 2005.100.429 | **Accession year:** 2005-02-15');
      expect(text).toContain('**Metadata date:** 2025-03-06T04:54:30Z');
      expect(text).toContain('**Metadata date:** 2023-02-07T04:46:51.34Z');
    });

    it('escapes rights text like the neighbouring prose', () => {
      expect(
        lineOf(
          renderText({ ...pollock, rightsAndReproduction: '© *Estate* of [X]' }),
          '**Rights:**',
        ),
      ).toBe('**Rights:** © \\*Estate\\* of \\[X\\]');
    });

    it('carries the three fields as sent on structuredContent, through output validation', async () => {
      mockRecords([timken, pollock]);
      const called = await runToolContract(metGetObject, { objectIDs: [437403, 488978] });

      const { objects } = called.structuredContent as { objects: RecordOutput[] };
      expect(
        objects.map((o) => [o.accessionYear, o.rightsAndReproduction, o.metadataDate]),
      ).toEqual([
        ['1960', '', '2025-09-17T04:49:46.407Z'],
        [
          '1957',
          '© 2026 Pollock-Krasner Foundation / Artists Rights Society (ARS), New York',
          '2026-10-01T04:59:29.693Z',
        ],
      ]);
      expect(contentText(called)).toContain(
        '**Rights:** © 2026 Pollock-Krasner Foundation / Artists Rights Society (ARS), New York',
      );
    });
  });

  describe('departmentId (#42)', () => {
    it('renders the resolved ID on the Department line', () => {
      expect(lineOf(renderText(sampleRecord), '**Department:**')).toBe(
        '**Department:** European Paintings | **departmentId:** 11 | **Object name:** Painting | **Classification:** Paintings',
      );
    });

    it('renders a placeholder when the department was not recognized', () => {
      expect(renderText(sparseRecord)).toContain('**departmentId:** —');
      expect(
        lineOf(
          renderText({ ...sampleRecord, department: 'Department of Unknowns', departmentId: null }),
          '**Department:**',
        ),
      ).toBe(
        '**Department:** Department of Unknowns | **departmentId:** — | **Object name:** Painting | **Classification:** Paintings',
      );
    });

    it('accepts an integer or null on the output schema, and nothing else', () => {
      const parses = (departmentId: unknown) =>
        metGetObject.output.safeParse({ objects: [{ ...sampleRecord, departmentId }], failed: [] })
          .success;
      const { departmentId: _id, ...withoutId } = sampleRecord;

      expect(parses(11)).toBe(true);
      expect(parses(null)).toBe(true);
      expect(parses(1.5)).toBe(false);
      expect(parses('11')).toBe(false);
      expect(metGetObject.output.safeParse({ objects: [withoutId], failed: [] }).success).toBe(
        false,
      );
    });

    it('carries the ID, or null, on both surfaces', async () => {
      mockRecords([sampleRecord, { ...sparseRecord, objectID: 2 }]);
      const called = await runToolContract(metGetObject, { objectIDs: [437980, 2] });

      const { objects } = called.structuredContent as { objects: RecordOutput[] };
      expect(objects.map((o) => o.departmentId)).toEqual([11, null]);
      const text = contentText(called);
      expect(text).toContain('**Department:** European Paintings | **departmentId:** 11 |');
      expect(text).toContain('**Department:** — | **departmentId:** — |');
    });
  });

  /**
   * `/v1.1/search` indexes IDs `/v1/objects/{id}` does not serve, so running the
   * search again hands back the same ID: a 404's guidance is to drop it.
   */
  describe('not-found guidance never sends the caller back to search', () => {
    it('tells an all_not_found caller to drop the IDs, on both surfaces', async () => {
      mockGetObject.mockResolvedValue(null);
      const called = await runToolContract(metGetObject, { objectIDs: [706047] });

      const { hint } = (
        called.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error.data.recovery;
      expect(hint).toBe(
        'The search index can carry IDs the object endpoint no longer serves, so searching again returns the same IDs. Drop these IDs rather than re-checking them with met_search_collections.',
      );
      expect(contentText(called)).toContain(`Recovery: ${hint}`);
    });

    it('words a per-ID 404 in failed[] the same way', async () => {
      const { result } = await run([sampleRecord], [437980, 706047]);

      expect(result.failed).toEqual([
        {
          objectID: 706047,
          error:
            'Object 706047 not found in the Met collection — the object endpoint does not serve it, though the search index can still list it. Drop this ID rather than searching for it again.',
        },
      ]);
    });

    it('does not tell an all_failed caller to verify an ID through search', async () => {
      mockGetObject.mockRejectedValue(new Error('network error'));
      const called = await runToolContract(metGetObject, { objectIDs: [999999] });

      const { reason, recovery } = (
        called.structuredContent as {
          error: { data: { reason: string; recovery: { hint: string } } };
        }
      ).error.data;
      expect(reason).toBe('all_failed');
      expect(recovery.hint).toBe(
        'Retry after a brief delay. If one ID keeps failing across retries, drop it from the batch.',
      );
    });
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
        message: 'Object 11207 was not found.',
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

  describe('format — artist dates with one or no bound (#29)', () => {
    const artistDatesLine = (artistBeginDate: string, artistEndDate: string) => {
      const text = (
        metGetObject.format!({
          objects: [{ ...sampleRecord, artistBeginDate, artistEndDate }],
          failed: [],
        })[0] as { text: string }
      ).text;
      return text.split('\n').find((line) => line.startsWith('**Artist dates:**'));
    };

    it('renders a genuine range with both bounds', () => {
      expect(artistDatesLine('1853', '1890')).toBe('**Artist dates:** 1853–1890');
    });

    it('renders a begin-only range open, with nothing after the dash', () => {
      expect(artistDatesLine('1837', '')).toBe('**Artist dates:** 1837–');
    });

    it('renders an end-only range open, with nothing before the dash', () => {
      expect(artistDatesLine('', '1890')).toBe('**Artist dates:** –1890');
    });

    it('renders a single placeholder when both bounds are empty', () => {
      expect(artistDatesLine('', '')).toBe('**Artist dates:** —');
    });

    it('still escapes a bound rendered on its own', () => {
      expect(artistDatesLine('[1837]', '')).toBe('**Artist dates:** \\[1837\\]–');
      expect(artistDatesLine('', '1890*')).toBe('**Artist dates:** –1890\\*');
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

  describe('opt-in images (#36)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Every image request fails the test unless a case stages its own answer.
      fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    /** A CC0 record whose web-large rendition sits on the Met image host. */
    const cc0Record = (objectID: number) => ({
      ...sparseRecord,
      objectID,
      isPublicDomain: true,
      hasCC0Image: true,
      primaryImage: `https://images.metmuseum.org/CRDImages/ep/original/DP${objectID}.jpg`,
      primaryImageSmall: `https://images.metmuseum.org/CRDImages/ep/web-large/DP${objectID}.jpg`,
    });

    describe('default off — the response before the input existed', () => {
      /** content[] for a CC0 record, a non-CC0 record, and a 404, captured before the input existed. */
      const DEFAULT_OFF_TEXT =
        '## (Untitled) — Object 437403\n**isPublicDomain:** Yes (CC0) | **hasCC0Image:** Yes | **isHighlight:** No | **isTimelineWork:** No\n**Artist:** — | **Artist role:** —\n**Nationality:** —\n**Artist dates:** —\n**Department:** — | **departmentId:** — | **Object name:** — | **Classification:** —\n**Date:** — (0–0)\n**Medium:** —\n**Dimensions:** —\n**Culture:** —\n**Period:** —\n**Dynasty:** —\n**Geography:** —\n**Measurements:** —\n**Accession:** — | **Accession year:** —\n**Credit:** —\n**Rights:** —\n**Metadata date:** —\n**Gallery:** —\n**URL:** —\n**Image (full):** https://images.metmuseum.org/CRDImages/ep/original/DP437403.jpg\n**Image (small):** https://images.metmuseum.org/CRDImages/ep/web-large/DP437403.jpg\n**Additional images:** —\n**Wikidata:** —\n**Tags:** —\n**Constituents:** —\n\n## (Untitled) — Object 488978\n**isPublicDomain:** No | **hasCC0Image:** No | **isHighlight:** No | **isTimelineWork:** No\n**Artist:** — | **Artist role:** —\n**Nationality:** —\n**Artist dates:** —\n**Department:** — | **departmentId:** — | **Object name:** — | **Classification:** —\n**Date:** — (0–0)\n**Medium:** —\n**Dimensions:** —\n**Culture:** —\n**Period:** —\n**Dynasty:** —\n**Geography:** —\n**Measurements:** —\n**Accession:** — | **Accession year:** —\n**Credit:** —\n**Rights:** —\n**Metadata date:** —\n**Gallery:** —\n**URL:** —\n**Image (full):** —\n**Image (small):** —\n**Additional images:** —\n**Wikidata:** —\n**Tags:** —\n**Constituents:** —\n\n## Failed Fetches\n- **999:** Object 999 not found in the Met collection — the object endpoint does not serve it, though the search index can still list it. Drop this ID rather than searching for it again.';

      /** The deferred notice for a 50,000 + 30,000-byte batch, captured before the input existed. */
      const DEFAULT_OFF_NOTICE =
        "Returned 1 of 2 fetched records — 50000 bytes of serialized structuredContent against a 60000-byte budget measured on that surface alone; content[] renders the same records again, so the delivered response is roughly twice that. The remaining 1 would exceed the budget. Re-call met_get_object with the deferred objectIDs to retrieve them; each record's listed size is on the same structuredContent scale, so sum them against the budget before requesting several.";

      it('fetches nothing and adds no field or block, on either surface', async () => {
        mockRecords([cc0Record(437403), { ...sparseRecord, objectID: 488978 }]);
        const called = await runToolContract(metGetObject, { objectIDs: [437403, 488978, 999] });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(Object.keys(called.structuredContent ?? {})).toEqual(['objects', 'failed']);
        expect(called.content).toHaveLength(1);
        expect(contentText(called)).toBe(DEFAULT_OFF_TEXT);
      });

      it('collects no content block from a direct handler call', async () => {
        mockRecords([cc0Record(437403)]);
        const ctx = createMockContext({ errors: metGetObject.errors });
        const result = await metGetObject.handler(
          metGetObject.input.parse({ objectIDs: [437403] }),
          ctx,
        );

        expect(getContentBlocks(ctx)).toEqual([]);
        expect('images' in metGetObject.output.parse(result)).toBe(false);
      });

      it('keeps the deferred notice and the keys of a deferring batch as they were', async () => {
        mockRecords([sizedRecord(1, 50_000), sizedRecord(2, 30_000)]);
        const called = await runToolContract(metGetObject, { objectIDs: [1, 2] });
        const structured = called.structuredContent as { notice?: string };

        expect(fetchMock).not.toHaveBeenCalled();
        expect(Object.keys(structured)).toEqual(['objects', 'failed', 'deferred', 'notice']);
        expect(structured.notice).toBe(DEFAULT_OFF_NOTICE);
        // The record text, then the notice as the enrichment trailer — no caption
        // or image block ahead of either.
        expect(called.content.map((block) => block.type)).toEqual(['text', 'text']);
        expect(called.content[1]).toEqual({ type: 'text', text: `\n\n> ${DEFAULT_OFF_NOTICE}` });
      });
    });

    /** The web-large URL `cc0Record` gives an object. */
    const webLarge = (objectID: number) =>
      `https://images.metmuseum.org/CRDImages/ep/web-large/DP${objectID}.jpg`;

    /** The bytes the image host serves for an object — distinct per object, so each block traces to its record. */
    const imageBytes = (objectID: number) => new TextEncoder().encode(`JPEG ${objectID}`);
    const base64Of = (objectID: number) => Buffer.from(imageBytes(objectID)).toString('base64');

    /**
     * The image host: each object's web-large path answers its bytes as
     * image/jpeg unless `answers` stages another exchange for that object. Any
     * other URL rejects, so a request off the pinned host fails the test.
     */
    function imageHost(answers: Record<number, () => Promise<Response>> = {}) {
      return (request: unknown) => {
        const url = new URL(String(request));
        const objectID = Number(/\/DP(\d+)\.jpg$/.exec(url.pathname)?.[1]);
        if (url.origin !== 'https://images.metmuseum.org' || !objectID) {
          return Promise.reject(new Error(`unrouted fetch ${url.href}`));
        }
        const staged = answers[objectID];
        return staged
          ? staged()
          : Promise.resolve(
              new Response(imageBytes(objectID), { headers: { 'content-type': 'image/jpeg' } }),
            );
      };
    }

    /** The URLs the call requested from the image host, in call order. */
    const imageRequests = () => fetchMock.mock.calls.map(([request]) => String(request));

    /** The caption and image blocks `content[]` opens with for each attached object. */
    const pairs = (...objectIDs: number[]) =>
      objectIDs.flatMap((objectID) => [
        { type: 'text', text: `Image of object ${objectID} (primaryImageSmall)` },
        { type: 'image', data: base64Of(objectID), mimeType: 'image/jpeg' },
      ]);

    type ImageEntry = { objectID: number; status: string };

    /** A CC0 record padded to roughly `bytes` of serialized structuredContent. */
    const heavyCc0 = (objectID: number, bytes: number) => {
      const base = cc0Record(objectID);
      return { ...base, creditLine: 'x'.repeat(bytes - utf8Bytes(base)) };
    };

    const imagesCall = (objectIDs: number[], context?: { signal: AbortSignal }) =>
      runToolContract(
        metGetObject,
        { objectIDs, includeImages: true },
        context ? { context } : undefined,
      );

    describe('attachment', () => {
      it('attaches the first 3 CC0 records in request order and reports the other two over_cap', async () => {
        const ids = [437403, 467642, 286850, 100153, 36033];
        mockRecords(ids.map(cc0Record));
        fetchMock.mockImplementation(imageHost());
        const called = await imagesCall(ids);

        expect(called.isError).toBeFalsy();
        expect(imageRequests()).toEqual([webLarge(437403), webLarge(467642), webLarge(286850)]);
        expect((called.structuredContent as { images: ImageEntry[] }).images).toEqual([
          { objectID: 437403, status: 'attached' },
          { objectID: 467642, status: 'attached' },
          { objectID: 286850, status: 'attached' },
          { objectID: 100153, status: 'over_cap' },
          { objectID: 36033, status: 'over_cap' },
        ]);
        // content[] opens with the caption/image pairs, then the format() text.
        expect(called.content.slice(0, 6)).toEqual(pairs(437403, 467642, 286850));
        expect(called.content.map((block) => block.type)).toEqual([
          'text',
          'image',
          'text',
          'image',
          'text',
          'image',
          'text',
        ]);
        expect((called.content[6] as { text: string }).text).toMatch(
          /^## \(Untitled\) — Object 437403/,
        );
        // The bytes ride content[] only.
        const structured = JSON.stringify(called.structuredContent);
        for (const objectID of ids.slice(0, 3)) {
          expect(structured).not.toContain(base64Of(objectID));
        }
        expect(contentText(called)).toContain(
          '## Images\n- **437403:** attached\n- **467642:** attached\n- **286850:** attached\n- **100153:** over_cap\n- **36033:** over_cap',
        );
      });

      it('collects the pairs through ctx.content and validates images against the output schema', async () => {
        const ids = [437403, 467642];
        mockRecords(ids.map(cc0Record));
        fetchMock.mockImplementation(imageHost());
        const ctx = createMockContext({ errors: metGetObject.errors });
        const result = await metGetObject.handler(
          metGetObject.input.parse({ objectIDs: ids, includeImages: true }),
          ctx,
        );

        expect(getContentBlocks(ctx)).toEqual(pairs(437403, 467642));
        expect(metGetObject.output.parse(result).images).toEqual([
          { objectID: 437403, status: 'attached' },
          { objectID: 467642, status: 'attached' },
        ]);
      });

      it('keeps request order when the image fetches complete in reverse', async () => {
        // The first image answers last; a completion-ordered attach would reverse the pairs.
        const ids = [437403, 467642, 286850];
        mockRecords(ids.map(cc0Record));
        const delayed = (objectID: number, ms: number) => () =>
          new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  new Response(imageBytes(objectID), { headers: { 'content-type': 'image/jpeg' } }),
                ),
              ms,
            ),
          );
        fetchMock.mockImplementation(
          imageHost({ 437403: delayed(437403, 30), 467642: delayed(467642, 15) }),
        );
        const ctx = createMockContext({ errors: metGetObject.errors });
        await metGetObject.handler(
          metGetObject.input.parse({ objectIDs: ids, includeImages: true }),
          ctx,
        );

        expect(getContentBlocks(ctx)).toEqual(pairs(437403, 467642, 286850));
      });

      it('attaches exactly 3 CC0 records with no over_cap entry when the batch holds no more', async () => {
        const ids = [437403, 488978, 467642, 286850];
        mockRecords([
          cc0Record(437403),
          { ...sparseRecord, objectID: 488978 },
          cc0Record(467642),
          cc0Record(286850),
        ]);
        fetchMock.mockImplementation(imageHost());
        const called = await imagesCall(ids);

        expect((called.structuredContent as { images: ImageEntry[] }).images).toEqual([
          { objectID: 437403, status: 'attached' },
          { objectID: 488978, status: 'no_cc0_image' },
          { objectID: 467642, status: 'attached' },
          { objectID: 286850, status: 'attached' },
        ]);
        expect(called.content.slice(0, 6)).toEqual(pairs(437403, 467642, 286850));
      });

      it('gives a non-CC0 record no_cc0_image, a deferred record and a failed ID no entry, and fetches only the returned CC0 image', async () => {
        // 437403 (40 KB) and 488978 fit; 999 is a 404; 467642 (30 KB) would cross
        // the 60,000-byte budget, so it is deferred.
        mockRecords([
          heavyCc0(437403, 40_000),
          { ...sparseRecord, objectID: 488978 },
          heavyCc0(467642, 30_000),
        ]);
        fetchMock.mockImplementation(imageHost());
        const called = await imagesCall([437403, 488978, 999, 467642]);
        const structured = called.structuredContent as {
          objects: { objectID: number }[];
          failed: { objectID: number }[];
          deferred: { objectID: number }[];
          images: ImageEntry[];
          notice: string;
        };

        expect(structured.objects.map((o) => o.objectID)).toEqual([437403, 488978]);
        expect(structured.failed.map((f) => f.objectID)).toEqual([999]);
        expect(structured.deferred.map((d) => d.objectID)).toEqual([467642]);
        expect(structured.images).toEqual([
          { objectID: 437403, status: 'attached' },
          { objectID: 488978, status: 'no_cc0_image' },
        ]);
        expect(imageRequests()).toEqual([webLarge(437403)]);
        expect(called.content.slice(0, 2)).toEqual(pairs(437403));

        const text = contentText(called);
        expect(text).toContain('## Images\n- **437403:** attached\n- **488978:** no_cc0_image');
        expect(text).not.toContain('- **467642:** attached');
        expect(text.indexOf('## Failed Fetches')).toBeLessThan(text.indexOf('## Deferred'));
        expect(text.indexOf('## Deferred')).toBeLessThan(text.indexOf('## Images'));
      });

      it('fetches nothing and returns the declared error when no record comes back', async () => {
        mockGetObject.mockResolvedValue(null);
        const called = await imagesCall([999998, 999999]);

        expect(called.isError).toBe(true);
        expect(
          (called.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
        ).toBe('all_not_found');
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('rejects an includeImages value that is not a boolean', async () => {
        const called = await runToolContract(metGetObject, {
          objectIDs: [437403],
          includeImages: 'yes',
        } as unknown as z.input<typeof metGetObject.input>);

        expect(called.isError).toBe(true);
        expect((called.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
        expect(mockGetObject).not.toHaveBeenCalled();
      });
    });

    describe('unavailable — the record stays, the call succeeds', () => {
      it('reports a 403, a non-image body, and a redirect unavailable, and still attaches the next image', async () => {
        const ids = [437403, 467642, 286850, 100153];
        mockRecords(ids.map(cc0Record));
        fetchMock.mockImplementation(
          imageHost({
            // The image host's 403 is one missing image, not the API firewall.
            437403: () => Promise.resolve(new Response('<html>Forbidden</html>', { status: 403 })),
            467642: () =>
              Promise.resolve(
                new Response('<html>not an image</html>', {
                  headers: { 'content-type': 'text/html' },
                }),
              ),
            // What fetch does with a 3xx under `redirect: 'error'`.
            286850: () => Promise.reject(new TypeError('fetch failed: unexpected redirect')),
          }),
        );
        const called = await imagesCall(ids);

        expect(called.isError).toBeFalsy();
        expect((called.structuredContent as { objects: unknown[] }).objects).toHaveLength(4);
        expect((called.structuredContent as { images: ImageEntry[] }).images).toEqual([
          { objectID: 437403, status: 'unavailable' },
          { objectID: 467642, status: 'unavailable' },
          { objectID: 286850, status: 'unavailable' },
          // A failed fetch still spends its slot: the cap counts attempts.
          { objectID: 100153, status: 'over_cap' },
        ]);
        expect(called.content.map((block) => block.type)).toEqual(['text']);
        expect(contentText(called)).not.toContain('upstream_blocked');
        for (const [, init] of fetchMock.mock.calls) {
          expect((init as RequestInit).redirect).toBe('error');
        }
      });

      it('never requests a look-alike host, an http URL, or an empty one, and gives each a slot', async () => {
        mockRecords([
          {
            ...cc0Record(1),
            primaryImageSmall: 'https://images.metmuseum.org.evil.example/DP1.jpg',
          },
          {
            ...cc0Record(2),
            primaryImageSmall: 'http://images.metmuseum.org/CRDImages/ep/web-large/DP2.jpg',
          },
          { ...cc0Record(3), primaryImageSmall: '' },
          cc0Record(4),
        ]);
        fetchMock.mockImplementation(imageHost());
        const called = await imagesCall([1, 2, 3, 4]);

        expect(fetchMock).not.toHaveBeenCalled();
        expect((called.structuredContent as { images: ImageEntry[] }).images).toEqual([
          { objectID: 1, status: 'unavailable' },
          { objectID: 2, status: 'unavailable' },
          { objectID: 3, status: 'unavailable' },
          { objectID: 4, status: 'over_cap' },
        ]);
      });

      it("reports unavailable without a request once the call's time budget is spent", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        // The record fetch outlasts the 30 s call budget before images start.
        mockGetObject.mockImplementation((objectID: number) => {
          vi.setSystemTime(Date.now() + 31_000);
          return cc0Record(objectID);
        });
        const called = await imagesCall([437403]);

        expect(called.isError).toBeFalsy();
        expect(fetchMock).not.toHaveBeenCalled();
        expect((called.structuredContent as { images: ImageEntry[] }).images).toEqual([
          { objectID: 437403, status: 'unavailable' },
        ]);
      });
    });

    it('ends the call as cancelled when the caller aborts during image fetches', async () => {
      const controller = new AbortController();
      mockRecords([cc0Record(437403), cc0Record(467642)]);
      // The first image request is in flight when the caller goes away. Like a
      // real fetch, a request made on an already-aborted signal rejects at once.
      fetchMock.mockImplementation(
        (_request: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason));
            controller.abort();
          }),
      );
      const called = await imagesCall([437403, 467642], { signal: controller.signal });

      expect(called.isError).toBe(true);
      expect((called.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      expect(called.content.some((block) => block.type === 'image')).toBe(false);
    });

    describe('the deferred notice', () => {
      it('adds the attached image blocks to the delivered size it states', async () => {
        mockRecords([heavyCc0(1, 50_000), heavyCc0(2, 30_000)]);
        fetchMock.mockImplementation(imageHost());
        const called = await imagesCall([1, 2]);
        const structured = called.structuredContent as { notice: string; images: ImageEntry[] };

        expect(structured.images).toEqual([{ objectID: 1, status: 'attached' }]);
        expect(structured.notice).toContain(
          `so the delivered response is roughly twice that, plus 1 attached image block (${base64Of(1).length} bytes of base64). The remaining 1 would exceed the budget.`,
        );
        expect(contentText(called)).toContain(
          `plus 1 attached image block (${base64Of(1).length} bytes of base64)`,
        );
      });

      it('keeps its wording when no image block was attached', async () => {
        mockRecords([{ ...heavyCc0(1, 50_000), hasCC0Image: false }, heavyCc0(2, 30_000)]);
        const called = await imagesCall([1, 2]);
        const notice = (called.structuredContent as { notice: string }).notice;

        expect(fetchMock).not.toHaveBeenCalled();
        expect(notice).toContain(
          'so the delivered response is roughly twice that. The remaining 1',
        );
        expect(notice).not.toContain('image block');
      });
    });

    describe('format and descriptions', () => {
      it('renders ## Images after the failed and deferred sections, one line per entry', () => {
        const text = (
          metGetObject.format!({
            objects: [sampleRecord],
            failed: [{ objectID: 99, error: 'Not found.' }],
            deferred: [{ objectID: 7, bytes: 30_000 }],
            images: [{ objectID: 437980, status: 'unavailable' }],
          })[0] as { text: string }
        ).text;

        expect(
          text.endsWith(
            '## Deferred — batch byte budget\n- **7:** 30000 bytes\n\n## Images\n- **437980:** unavailable',
          ),
        ).toBe(true);
      });

      it('tells the caller a structuredContent-only client will not show the images', () => {
        const description = metGetObject.input.shape.includeImages.description ?? '';
        expect(description).toContain('structuredContent');
        expect(description).toContain('will not show');
      });

      it('states the measured long edge of primaryImageSmall', () => {
        const description =
          metGetObject.output.shape.objects.element.shape.primaryImageSmall.description ?? '';
        expect(description).not.toContain('800');
        expect(description).toContain('600');
      });
    });
  });

  // --- inputAliases: `ids` reaches the declared `objectIDs` ---
  // The rewrite runs in parseToolArguments, above the handler, so the full tool
  // contract is the only seam that exercises it.

  describe('input aliases', () => {
    /**
     * An alias is an off-schema key by construction, so the runner's typed
     * argument parameter cannot express one — the cast is what lets the test
     * send the arguments a client actually sends.
     */
    const call = (args: Record<string, unknown>) =>
      runToolContract(metGetObject, args as unknown as z.input<typeof metGetObject.input>);

    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

    it('rewrites ids to objectIDs before validation', async () => {
      mockRecords([{ ...sampleRecord, objectID: 437980 }]);
      const result = await call({ ids: [437980] });

      expect(result.isError).toBeFalsy();
      expect(mockGetObject).toHaveBeenCalledWith(437980, expect.anything(), aDeadline());
      expect((result.structuredContent as { objects: unknown[] }).objects).toHaveLength(1);
      expect(textOf(result)).toContain('Object 437980');
    });

    it('resolves a case-style variant of the declared key with nothing declared', async () => {
      mockRecords([{ ...sampleRecord, objectID: 437980 }]);
      const result = await call({ object_ids: [437980] });

      expect(result.isError).toBeFalsy();
      expect(mockGetObject).toHaveBeenCalledWith(437980, expect.anything(), aDeadline());
    });

    it('still rejects an undeclared key that maps to no alias', async () => {
      const result = await call({ objectIDs: [437980], includeAdditionalImages: true });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('includeAdditionalImages');
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it('delivers all_not_found on both surfaces — the log severity moves, the envelope does not', async () => {
      mockGetObject.mockResolvedValue(null);
      const result = await call({ objectIDs: [999999] });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; data: { reason: string; recovery: { hint: string } } };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('all_not_found');
      expect(error.data.recovery.hint).toContain('Drop these IDs');
      expect(textOf(result)).toContain('Recovery: The search index can carry IDs');
      expect(textOf(result)).toContain('all_not_found');
    });
  });
});
