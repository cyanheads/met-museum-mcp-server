/**
 * @fileoverview Tests for met_get_object tool.
 * @module tests/tools/met-get-object.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
