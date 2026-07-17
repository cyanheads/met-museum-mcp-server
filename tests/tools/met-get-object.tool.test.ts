/**
 * @fileoverview Tests for met_get_object tool.
 * @module tests/tools/met-get-object.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metGetObject } from '@/mcp-server/tools/definitions/met-get-object.tool.js';

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

    const ctx = createMockContext();
    const input = metGetObject.input.parse({ objectIDs: [437980] });
    const result = await metGetObject.handler(input, ctx);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].objectID).toBe(437980);
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

    const ctx = createMockContext();
    const input = metGetObject.input.parse({ objectIDs: [437980, 999999] });
    const result = await metGetObject.handler(input, ctx);
    expect(result.objects).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].objectID).toBe(999999);
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

    const ctx = createMockContext();
    const input = metGetObject.input.parse({ objectIDs: [437980, 999999] });
    const result = await metGetObject.handler(input, ctx);
    expect(result.objects).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].objectID).toBe(999999);
  });

  it('returns objects[] in input order when fetches complete out of order', async () => {
    // Non-monotonic IDs so the assertion locks to INPUT order, not a numeric sort.
    const ids = [104, 100, 106, 102];
    mockCompletionInReverseOrder(ids);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
    const text = blocks[0].text as string;
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
    const text = blocks[0].text as string;
    expect(text).toContain('Failed Fetches');
    expect(text).toContain('99');
  });
});
