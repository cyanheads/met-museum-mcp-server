/**
 * @fileoverview Tests for met_search_collections tool.
 * @module tests/tools/met-search-collections.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';

const mockSearch = vi.fn();
const mockGetValidDepartmentIds = vi.fn();
const mockCountKeywordMatches = vi.fn();
const mockKeepDepartmentMembers = vi.fn();

/**
 * The service is stubbed at its accessor; the module's constants (the search
 * window `format()` reads) stay real. The URL building, window arithmetic,
 * zero-match notice, and the 7/17 department filter over a real service are
 * covered in the service suites.
 */
vi.mock('@/services/met/met-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/met/met-service.js')>()),
  getMetService: () => ({
    search: mockSearch,
    getValidDepartmentIds: mockGetValidDepartmentIds,
    countKeywordMatches: mockCountKeywordMatches,
    keepDepartmentMembers: mockKeepDepartmentMembers,
  }),
}));

/** The per-call deadline every service call receives as its third argument. */
const aDeadline = () =>
  expect.objectContaining({ deadlineAt: expect.any(Number), signal: expect.any(AbortSignal) });

/** The live-verified Met department ID set (gaps at 2 and 20, nothing ≥ 22). */
const VALID_DEPARTMENT_IDS = new Set([
  1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21,
]);

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block of a tool result's `content[]`, joined — the enrichment trailer included. */
const contentText = (result: ToolResult) =>
  (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

/** The success-path fields of a tool result's `structuredContent`. */
const structuredOf = (result: ToolResult) => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown> & {
    effectiveQuery?: string;
    notice?: string;
  };
};

describe('metSearchCollections', () => {
  beforeEach(() => {
    /**
     * resetAllMocks, not clearAllMocks: clearing wipes call records but leaves
     * implementations in place, so a `mockResolvedValue` set by one test leaks into
     * the next and can make an unconfigured test pass on a neighbour's fixture.
     * Resetting drops the implementations too, so any test that forgets to stage
     * `mockSearch` fails loudly instead of quietly asserting the wrong data.
     */
    vi.resetAllMocks();
    // Default: a fully-populated department set. Individual tests exercising an
    // invalid ID simply pass one not in this set (2, 999).
    mockGetValidDepartmentIds.mockResolvedValue(VALID_DEPARTMENT_IDS);
  });

  it('returns search results', async () => {
    mockSearch.mockResolvedValue({
      total: 100,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: true,
      remaining: 97,
      nextOffset: 3,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'Van Gogh', limit: 3 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(result.total).toBe(100);
    expect(result.objectIDs).toEqual([1, 2, 3]);
    expect(result.returned).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(97);
    expect(result.nextOffset).toBe(3);
  });

  it('returns a total of 0 as an empty success carrying the keyword notice (#44)', async () => {
    mockSearch.mockResolvedValue({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });

    const result = await runToolContract(metSearchCollections, { q: 'zzznomatch', limit: 20 });

    const notice =
      'The keyword "zzznomatch" matches no object in the collection. Try a different, broader, or differently spelled keyword.';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
      notice,
      effectiveQuery: 'q="zzznomatch"',
    });
    const text = contentText(result);
    expect(text).toContain('**Total matches:** 0');
    expect(text).toContain('**Returned IDs:** 0 (complete)');
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('Query: q="zzznomatch"');
    expect(text).not.toContain('no_results');
    expect(mockCountKeywordMatches).not.toHaveBeenCalled();
  });

  it('keeps a multi-line q on one line inside the zero-match notice, the echo its own block', async () => {
    mockSearch.mockResolvedValue({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const q = 'a "b"\n\n# heading';

    const result = await runToolContract(metSearchCollections, { q });

    const notice =
      'The keyword "a \\"b\\"\\n\\n# heading" matches no object in the collection. Try a different, broader, or differently spelled keyword.';
    expect(structuredOf(result).notice).toBe(notice);
    expect(result.content?.[1]).toEqual({
      type: 'text',
      text: `\n\n> ${notice}\n\nQuery: q=${JSON.stringify(q)}`,
    });
  });

  it('no longer declares no_results in its error contract (#44)', () => {
    expect(metSearchCollections.errors?.map((entry) => entry.reason)).not.toContain('no_results');
  });

  /**
   * The error envelope a failing call returns. The declared recovery hint is
   * filled by the tool pipeline from the `errors[]` contract, not by the
   * handler's throw, so hint assertions run through `runToolContract` — the
   * seam that applies the fill, as production does.
   */
  const contractError = async (args: z.input<typeof metSearchCollections.input>) => {
    const result = await runToolContract(metSearchCollections, args);
    expect(result.isError).toBe(true);
    return (
      result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      }
    ).error;
  };

  // --- #6: invalid_date_range carries the declared recovery hint ---
  // The framework mirrors data.recovery.hint into the content[] "Recovery:" line,
  // so asserting the hint reaches data.recovery.hint covers both client surfaces.

  it('invalid_date_range (missing pair) carries the recovery hint on data.recovery.hint', async () => {
    const error = await contractError({ q: 'test', limit: 20, dateBegin: 1800 });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_date_range',
        recovery: {
          hint: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
        },
      },
    });
  });

  it('invalid_date_range (dateBegin > dateEnd) carries the recovery hint on data.recovery.hint', async () => {
    const error = await contractError({ q: 'test', limit: 20, dateBegin: 1900, dateEnd: 1800 });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_date_range',
        recovery: {
          hint: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
        },
      },
    });
  });

  // --- #7: departmentId validated before searching ---

  it('searches normally for a valid departmentId', async () => {
    mockSearch.mockResolvedValue({
      total: 42,
      objectIDs: [1, 2],
      returned: 2,
      truncated: true,
      remaining: 40,
      nextOffset: 2,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'painting', departmentId: 11, limit: 2 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockGetValidDepartmentIds).toHaveBeenCalledOnce();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: 11 }),
      ctx,
      aDeadline(),
    );
    // One budget: the lookup and the search share the deadline the handler started.
    expect(mockGetValidDepartmentIds.mock.calls[0]?.[1]).toBe(mockSearch.mock.calls[0]?.[2]);
    expect(result.total).toBe(42);
  });

  it('rejects a gap departmentId (2) with invalid_department and never searches', async () => {
    const error = await contractError({ q: 'painting', departmentId: 2, limit: 3 });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_department',
        recovery: { hint: expect.stringContaining('met_list_departments') },
      },
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects a high invalid departmentId (999) with invalid_department', async () => {
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'painting', departmentId: 999, limit: 3 });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_department' },
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('a valid department with zero matches is an empty success, not invalid_department', async () => {
    mockSearch.mockResolvedValue({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    mockCountKeywordMatches.mockResolvedValue(0);

    const structured = structuredOf(
      await runToolContract(metSearchCollections, { q: 'zzznomatch', departmentId: 11, limit: 20 }),
    );

    expect(structured.total).toBe(0);
    expect(structured.notice).toBe(
      'The keyword "zzznomatch" matches no object in the collection, even with no filter applied. Try a different, broader, or differently spelled keyword.',
    );
    expect(structured.effectiveQuery).toBe('q="zzznomatch", departmentId=11');
  });

  // --- #39: departments 7 and 17 share one search result set ---

  describe('departments 7 and 17 (#39)', () => {
    const combinedPage = {
      total: 165,
      objectIDs: [464100, 467638, 464101],
      returned: 3,
      truncated: true,
      remaining: 162,
      nextOffset: 3,
      offset: 0,
    };

    it('narrows the page through keepDepartmentMembers under the same call deadline as the search', async () => {
      mockSearch.mockResolvedValue(combinedPage);
      mockKeepDepartmentMembers.mockResolvedValue([467638]);
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const input = metSearchCollections.input.parse({ q: 'tapestry', departmentId: 7, limit: 3 });

      const result = await metSearchCollections.handler(input, ctx);

      expect(mockKeepDepartmentMembers).toHaveBeenCalledExactlyOnceWith(
        [464100, 467638, 464101],
        7,
        ctx,
        aDeadline(),
      );
      expect(mockKeepDepartmentMembers.mock.calls[0]?.[3]).toBe(mockSearch.mock.calls[0]?.[2]);
      expect(result).toEqual({ ...combinedPage, objectIDs: [467638], returned: 1 });
      expect(getEnrichment(ctx).notice).toContain(
        'departments 7 (The Cloisters) and 17 (Medieval Art)',
      );
    });

    it('returns the combined page unchanged, with the not-applied notice, when the list is unavailable', async () => {
      mockSearch.mockResolvedValue(combinedPage);
      mockKeepDepartmentMembers.mockResolvedValue(null);
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const input = metSearchCollections.input.parse({ q: 'tapestry', departmentId: 17, limit: 3 });

      const result = await metSearchCollections.handler(input, ctx);

      expect(result).toEqual(combinedPage);
      expect(getEnrichment(ctx).notice).toContain(
        "Department 17's object list could not be loaded, so the department filter was not applied",
      );
    });

    it('carries the not-applied notice and the query echo on both surfaces when the list is unavailable', async () => {
      mockSearch.mockResolvedValue(combinedPage);
      mockKeepDepartmentMembers.mockResolvedValue(null);

      const result = await runToolContract(metSearchCollections, {
        q: 'tapestry',
        departmentId: 17,
        limit: 3,
      });

      const structured = structuredOf(result);
      expect(structured.objectIDs).toEqual(combinedPage.objectIDs);
      expect(structured.notice).toContain("Department 17's object list could not be loaded");
      expect(structured.effectiveQuery).toBe('q="tapestry", departmentId=17');
      const text = contentText(result);
      expect(text).toContain("> The Met's search returns departments 7 (The Cloisters) and 17");
      expect(text).toContain('Query: q="tapestry", departmentId=17');
    });

    it('never narrows another department', async () => {
      mockSearch.mockResolvedValue(combinedPage);
      const ctx = createMockContext({ errors: metSearchCollections.errors });

      for (const departmentId of [1, 6, 8, 11, 16, 18, 21]) {
        const input = metSearchCollections.input.parse({ q: 'tapestry', departmentId, limit: 3 });
        expect(await metSearchCollections.handler(input, ctx)).toEqual(combinedPage);
      }
      expect(mockKeepDepartmentMembers).not.toHaveBeenCalled();
    });

    it('states the combined set in the departmentId description', () => {
      const { description } = metSearchCollections.input.shape.departmentId;
      expect(description).toContain('7 (The Cloisters) and 17 (Medieval Art)');
      expect(description).toContain('one combined result set');
      expect(description).toContain('total and paging count both');
      expect(description).toContain('fewer than limit IDs while more remain');
    });

    it('defines truncated, remaining, and nextOffset by the positions read, equal to returned elsewhere', () => {
      const { objectIDs, truncated, remaining, nextOffset } = metSearchCollections.output.shape;
      expect(objectIDs.description).toContain('For departmentId 7 or 17');
      expect(truncated.description).toContain(
        'offset + the positions this page read < the smaller of total and 10,000',
      );
      expect(truncated.description).toContain(
        'The positions read equal returned, except for departmentId 7 or 17',
      );
      expect(remaining.description).toContain('minus (offset + the positions this page read)');
      expect(nextOffset.description).toContain('for departmentId 7 or 17 can exceed returned');
    });

    it('says in the truncated and remaining descriptions that an empty page ends paging (#46)', () => {
      const { truncated, remaining } = metSearchCollections.output.shape;
      expect(truncated.description).toContain('An empty page reports false');
      expect(remaining.description).toContain('An empty page reports 0');
    });

    it('names the 7/17 case in the notice description', () => {
      const { description } = metSearchCollections.enrichment?.notice ?? {};
      expect(description).toContain('when departmentId is 7 or 17');
      expect(description).toContain('several apply as one string');
    });
  });

  // --- #9: offset paging plumbed through the handler ---

  it('passes offset through to the service and returns pagination fields', async () => {
    mockSearch.mockResolvedValue({
      total: 100,
      objectIDs: [51, 52],
      returned: 2,
      truncated: true,
      remaining: 48,
      nextOffset: 52,
      offset: 50,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'cat', limit: 2, offset: 50 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 50, limit: 2 }),
      ctx,
      aDeadline(),
    );
    expect(result.nextOffset).toBe(52);
    expect(result.remaining).toBe(48);
  });

  it('defaults offset to 0 when omitted', async () => {
    mockSearch.mockResolvedValue({
      total: 5,
      objectIDs: [1, 2, 3, 4, 5],
      returned: 5,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'rare', limit: 20 });
    await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 }),
      ctx,
      aDeadline(),
    );
  });

  it('passes a one-location geoLocation array to the service', async () => {
    mockSearch.mockResolvedValue({
      total: 12,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({
      q: 'painting',
      geoLocation: ['France'],
      limit: 5,
    });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ geoLocation: ['France'] }),
      ctx,
      aDeadline(),
    );
    expect(result.total).toBe(12);
  });

  // --- #35: matchField restricts the keyword match to titles or tags ---

  it.each(['title', 'tags'] as const)(
    'passes matchField %s through to the service',
    async (matchField) => {
      mockSearch.mockResolvedValue({
        total: 36,
        objectIDs: [1, 2],
        returned: 2,
        truncated: true,
        remaining: 34,
        nextOffset: 2,
        offset: 0,
      });
      const ctx = createMockContext({ errors: metSearchCollections.errors });
      const input = metSearchCollections.input.parse({ q: 'sunflower', matchField, limit: 2 });
      await metSearchCollections.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'sunflower', matchField }),
        ctx,
        aDeadline(),
      );
    },
  );

  it('accepts only title and tags for matchField at the input schema', () => {
    for (const value of ['artistOrCulture', true, false, 'TITLE', '']) {
      expect(() =>
        metSearchCollections.input.parse({ q: 'sunflower', matchField: value }),
      ).toThrow();
    }
    expect(metSearchCollections.input.parse({ q: 'sunflower' }).matchField).toBeUndefined();
  });

  it('says in the matchField description that it has no effect when q is "*"', () => {
    const { description } = metSearchCollections.input.shape.matchField;
    expect(description).not.toContain('upstream');
    expect(description).toContain('"title" matches object titles only');
    expect(description).toContain('"tags" matches subject tags only');
    expect(description).toContain('no effect when q is "*"');
  });

  it('names matchField in the q description as the way to narrow the match', () => {
    const { description } = metSearchCollections.input.shape.q;
    expect(description).toContain('matched across title, artist name');
    expect(description).toContain('matchField');
  });

  // --- #43: the q description carries the "*" match-all and accession-number notes ---

  it('documents "*" as match-all for a filter-only search, still within the 10,000 window', () => {
    const { description } = metSearchCollections.input.shape.q;
    expect(description).toContain('"*" matches every object');
    expect(description).toContain('narrowed by filters alone');
    expect(description).toContain('first 10,000 matches');
  });

  it('documents an accession number as ranking its object first, to confirm on met_get_object', () => {
    const { description } = metSearchCollections.input.shape.q;
    expect(description).toContain('accession number');
    expect(description).toContain('near-numbered objects after it');
    expect(description).toContain('accessionNumber on met_get_object');
  });

  it('keeps q required and non-empty — the notes change no schema', () => {
    expect(() => metSearchCollections.input.parse({})).toThrow();
    expect(() => metSearchCollections.input.parse({ q: '' })).toThrow();
    expect(metSearchCollections.input.parse({ q: '*' }).q).toBe('*');
  });

  it('rejects a second geoLocation value at the input schema, naming the remedy', () => {
    // The Met search applies only the first repeated value, so a second one would
    // be silently ignored — the schema refuses it instead.
    expect(() =>
      metSearchCollections.input.parse({ q: 'painting', geoLocation: ['France', 'Spain'] }),
    ).toThrow(/geoLocation takes one location/);
  });

  it('passes isOnView to service', async () => {
    mockSearch.mockResolvedValue({
      total: 117,
      objectIDs: [437392, 437389, 436929],
      returned: 3,
      truncated: true,
      remaining: 114,
      nextOffset: 3,
      offset: 0,
    });

    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'Rembrandt', isOnView: true, limit: 3 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ isOnView: true }),
      ctx,
      aDeadline(),
    );
    expect(result.objectIDs).toEqual([437392, 437389, 436929]);
  });

  it('format renders total, pagination fields, and object IDs', () => {
    const blocks = metSearchCollections.format!({
      total: 500,
      objectIDs: [1001, 1002],
      returned: 2,
      truncated: true,
      remaining: 498,
      nextOffset: 2,
      offset: 0,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('500');
    expect(text).toContain('1001');
    expect(text).toContain('1002');
    expect(text).toContain('truncated');
    expect(text).toContain('Remaining:** 498');
    expect(text).toContain('Next offset:** 2');
  });

  // --- #44: a zero result is (complete) at offset 0, past the end only at a nonzero offset ---

  it('format marks a zero result read from offset 0 (complete), not beyond the result set', () => {
    const blocks = metSearchCollections.format!({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Returned IDs:** 0 (complete)');
    expect(text).not.toContain('offset beyond result set');
  });

  it('format marks a zero result read from a nonzero offset (offset beyond result set)', () => {
    const blocks = metSearchCollections.format!({
      total: 0,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 40,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Returned IDs:** 0 (offset beyond result set)');
    expect(text).not.toContain('(complete)');
  });

  it('format shows completion markers on the final page (not truncated, nextOffset none)', () => {
    const blocks = metSearchCollections.format!({
      total: 2,
      objectIDs: [1001, 1002],
      returned: 2,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const text = (blocks[0] as { text: string }).text;
    // truncated: false must render an explicit marker rather than silently vanishing.
    expect(text).toContain('(complete)');
    expect(text).toContain('Next offset:** none');
    expect(text).toContain('Remaining:** 0');
  });

  // --- #12: isHighlight is a true-only opt-in ---
  // The search ignores `isHighlight=false`. Narrowing at the schema is what puts
  // the constraint in `tools/list`, so a model never builds the dead call.

  it('rejects isHighlight: false at the input schema, naming the remedy', () => {
    // The schema rejection surfaces as a bare -32602 with no recovery hint, so the
    // Zod message is the only guidance the caller gets — it has to say what to do.
    expect(() => metSearchCollections.input.parse({ q: 'sunflower', isHighlight: false })).toThrow(
      /isHighlight accepts true only — omit the filter/,
    );
  });

  it('still accepts isHighlight: true and forwards it to the service', async () => {
    mockSearch.mockResolvedValue({
      total: 3,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'vase', isHighlight: true, limit: 20 });
    await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ isHighlight: true }),
      ctx,
      aDeadline(),
    );
  });

  it('leaves hasImages and isOnView as plain two-valued booleans', () => {
    // The search honors both arms of each.
    expect(() =>
      metSearchCollections.input.parse({ q: 'vase', hasImages: false, isOnView: false }),
    ).not.toThrow();
  });

  // --- #13: blank filter values are rejected in the handler ---
  // The Met search ignores a blank parameter, silently widening the search, so
  // there is no safe blank to forward.

  const expectInvalidFilter = async (
    args: z.input<typeof metSearchCollections.input>,
    field: string,
  ) => {
    const err = await contractError(args);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_filter',
        recovery: {
          hint: 'Supply a non-blank value for the named field, or omit the optional filter entirely.',
        },
      },
    });
    expect(err.message).toContain(field);
    expect(mockSearch).not.toHaveBeenCalled();
  };

  it('rejects a whitespace-only q with invalid_filter naming the field', async () => {
    await expectInvalidFilter({ q: '   ', limit: 3 }, 'q');
  });

  it('rejects a blank medium with invalid_filter naming the field', async () => {
    await expectInvalidFilter({ q: 'sunflower', medium: '', limit: 3 }, 'medium');
  });

  it('rejects a whitespace-only medium with invalid_filter', async () => {
    await expectInvalidFilter({ q: 'sunflower', medium: '   ', limit: 3 }, 'medium');
  });

  it('rejects an empty geoLocation array with invalid_filter', async () => {
    await expectInvalidFilter({ q: 'sunflower', geoLocation: [], limit: 3 }, 'geoLocation');
  });

  it('rejects a geoLocation array whose only element is blank', async () => {
    await expectInvalidFilter({ q: 'sunflower', geoLocation: [''], limit: 3 }, 'geoLocation');
  });

  it('rejects a geoLocation array mixing a valid element with a blank one at the schema', () => {
    // geoLocation takes one element, so a blank hiding behind a valid sibling never
    // reaches the handler's blank check — the one-element cap refuses it first.
    expect(() =>
      metSearchCollections.input.parse({ q: 'sunflower', geoLocation: ['France', ''], limit: 3 }),
    ).toThrow(/geoLocation takes one location/);
  });

  it('accepts a q with meaningful content and incidental surrounding whitespace', async () => {
    mockSearch.mockResolvedValue({
      total: 97,
      objectIDs: [1],
      returned: 1,
      truncated: true,
      remaining: 96,
      nextOffset: 1,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: '  sunflower  ', limit: 1 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ q: '  sunflower  ' }),
      ctx,
      aDeadline(),
    );
    expect(result.total).toBe(97);
  });

  it('leaves an omitted medium and geoLocation unaffected', async () => {
    mockSearch.mockResolvedValue({
      total: 5,
      objectIDs: [1, 2, 3, 4, 5],
      returned: 5,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'sunflower', limit: 20 });
    await metSearchCollections.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ medium: undefined, geoLocation: undefined }),
      ctx,
      aDeadline(),
    );
  });

  it('keeps invalid_date_range ahead of the blank-filter check', async () => {
    // Ordering pin: a request invalid on both counts must still report the
    // date-range fault it reports today.
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: '   ', dateBegin: 1800, limit: 3 });
    await expect(Promise.resolve(metSearchCollections.handler(input, ctx))).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
  });

  // --- #17: an exhausted offset page is distinguishable from a real final page ---

  it('echoes the resolved offset through the handler output', async () => {
    mockSearch.mockResolvedValue({
      total: 97,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 999999,
    });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'sunflower', limit: 3, offset: 999999 });
    const result = await metSearchCollections.handler(input, ctx);
    expect(result.offset).toBe(999999);
  });

  it('format marks an offset past the end distinctly, never as (complete)', () => {
    const blocks = metSearchCollections.format!({
      total: 97,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 999999,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('(complete)');
    expect(text).toContain('offset beyond result set');
    expect(text).toContain('Offset:** 999999');
  });

  it('format marks the exact offset === total boundary as past the end', () => {
    // The boundary, not merely a far-past offset: offset 97 of 97 is already exhausted.
    const blocks = metSearchCollections.format!({
      total: 97,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 97,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('(complete)');
    expect(text).toContain('offset beyond result set');
  });

  it('format still renders (truncated) on a mid-result page', () => {
    const blocks = metSearchCollections.format!({
      total: 100,
      objectIDs: [51, 52],
      returned: 2,
      truncated: true,
      remaining: 48,
      nextOffset: 52,
      offset: 50,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(truncated)');
    expect(text).not.toContain('offset beyond result set');
    expect(text).toContain('Offset:** 50');
  });

  // --- #27: the 10,000 window adds a fourth format state ---

  it('format marks a last page that stops at the window short of total as (window end)', () => {
    const blocks = metSearchCollections.format!({
      total: 14_398,
      objectIDs: [9999, 10_000],
      returned: 2,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 9998,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(window end)');
    expect(text).not.toContain('(complete)');
    expect(text).not.toContain('offset beyond result set');
  });

  it('format marks an offset at the window, short of total, as past the end', () => {
    const blocks = metSearchCollections.format!({
      total: 14_398,
      objectIDs: [],
      returned: 0,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 10_000,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('offset beyond result set');
    expect(text).not.toContain('(window end)');
  });

  it('format marks the final page of a total of exactly 10,000 as (complete)', () => {
    const blocks = metSearchCollections.format!({
      total: 10_000,
      objectIDs: [10_000],
      returned: 1,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 9999,
    });
    expect((blocks[0] as { text: string }).text).toContain('(complete)');
  });

  // --- #25: the keyword-only count is issued only for a filtered miss ---

  const emptyPage = {
    total: 0,
    objectIDs: [],
    returned: 0,
    truncated: false,
    remaining: 0,
    nextOffset: null,
    offset: 0,
  };

  it('an unfiltered miss does not ask for the keyword-only count', async () => {
    mockSearch.mockResolvedValue(emptyPage);
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'zzznomatch', limit: 20 });
    const result = await metSearchCollections.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('"zzznomatch" matches no object');
    expect(mockCountKeywordMatches).not.toHaveBeenCalled();
  });

  it('a filtered miss asks for the keyword-only count once, with the keyword', async () => {
    mockSearch.mockResolvedValue(emptyPage);
    mockCountKeywordMatches.mockResolvedValue(1);
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'sunflower', hasImages: false });
    await metSearchCollections.handler(input, ctx);
    const notice = String(getEnrichment(ctx).notice);

    expect(mockCountKeywordMatches).toHaveBeenCalledExactlyOnceWith('sunflower', ctx, aDeadline());
    expect(mockCountKeywordMatches.mock.calls[0]?.[2]).toBe(mockSearch.mock.calls[0]?.[2]);
    expect(notice).toContain('matches 1 object on its own');
    expect(notice).toContain('removed every match: hasImages.');
    // No medium correction when medium was not set.
    expect(notice).not.toContain('classification');
  });

  it('keys the zero-match notice on total 0 alone: an empty page of a nonzero total gets none', async () => {
    mockSearch.mockResolvedValue({ ...emptyPage, total: 178, offset: 178 });
    const result = await runToolContract(metSearchCollections, {
      q: 'sunflower',
      medium: 'Paintings',
      offset: 178,
    });

    const structured = structuredOf(result);
    expect(structured.notice).toBeUndefined();
    expect(contentText(result)).toContain('**Returned IDs:** 0 (offset beyond result set)');
    expect(mockCountKeywordMatches).not.toHaveBeenCalled();
  });

  it('keeps the zero-match notice on a zero result read from a nonzero offset', async () => {
    mockSearch.mockResolvedValue({ ...emptyPage, offset: 40 });
    const result = await runToolContract(metSearchCollections, { q: 'zzznomatch', offset: 40 });

    expect(structuredOf(result).notice).toContain('"zzznomatch" matches no object');
    const text = contentText(result);
    expect(text).toContain('**Returned IDs:** 0 (offset beyond result set)');
    expect(text).toContain('> The keyword "zzznomatch" matches no object');
  });

  it('delivers one notice string per response — the window disclosure alone, with no separator', async () => {
    mockSearch.mockResolvedValue({
      total: 14_398,
      objectIDs: [1, 2],
      returned: 2,
      truncated: true,
      remaining: 9998,
      nextOffset: 2,
      offset: 0,
    });
    const structured = structuredOf(
      await runToolContract(metSearchCollections, { q: 'horse', limit: 2 }),
    );

    expect(structured.notice).toBe(
      'Only the first 10,000 of 14,398 matches are reachable by paging. Narrow the search with filters or a more specific keyword to reach the rest.',
    );
  });

  // --- #44: every success echoes the applied query as effectiveQuery ---

  describe('effectiveQuery', () => {
    const page = {
      total: 3,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    };

    it('echoes q and the filters set, in schema order, on both surfaces', async () => {
      mockSearch.mockResolvedValue(page);
      const result = await runToolContract(metSearchCollections, {
        departmentId: 11,
        q: 'sunflower',
        medium: 'Paintings',
      });

      const echo = 'q="sunflower", medium="Paintings", departmentId=11';
      expect(structuredOf(result).effectiveQuery).toBe(echo);
      expect(contentText(result)).toContain(`Query: ${echo}`);
    });

    it('echoes every filter, JSON-encoded, and never limit or offset', async () => {
      mockSearch.mockResolvedValue({ ...page, offset: 40, truncated: false });
      const result = await runToolContract(metSearchCollections, {
        dateEnd: 1800,
        q: 'vase',
        hasImages: true,
        isHighlight: true,
        isOnView: false,
        medium: 'Ceramics',
        departmentId: 11,
        geoLocation: ['France'],
        dateBegin: -500,
        matchField: 'title',
        limit: 7,
        offset: 40,
      });

      const echo =
        'q="vase", matchField="title", hasImages=true, isHighlight=true, isOnView=false, medium="Ceramics", departmentId=11, geoLocation=["France"], dateBegin=-500, dateEnd=1800';
      expect(structuredOf(result).effectiveQuery).toBe(echo);
      expect(contentText(result)).toContain(`Query: ${echo}`);
      expect(contentText(result)).not.toContain('limit=');
      expect(contentText(result)).not.toContain('offset=');
    });

    it('echoes q as sent: surrounding whitespace kept, quotes escaped, one line', async () => {
      mockSearch.mockResolvedValue(page);
      const result = await runToolContract(metSearchCollections, { q: ' Van "Gogh"\nletters ' });

      const echo = 'q=" Van \\"Gogh\\"\\nletters "';
      expect(structuredOf(result).effectiveQuery).toBe(echo);
      expect(contentText(result)).toContain(`Query: ${echo}`);
    });

    it('echoes on the zero, window, and offset-beyond paths alike', async () => {
      mockSearch.mockResolvedValueOnce(emptyPage);
      mockSearch.mockResolvedValueOnce({
        ...page,
        total: 14_398,
        truncated: true,
        remaining: 9997,
      });
      mockSearch.mockResolvedValueOnce({ ...emptyPage, total: 97, offset: 97 });

      for (const args of [{ q: 'zzznomatch' }, { q: 'horse' }, { q: 'sunflower', offset: 97 }]) {
        const result = await runToolContract(metSearchCollections, args);
        expect(structuredOf(result).effectiveQuery).toBe(`q="${args.q}"`);
        expect(contentText(result)).toContain(`Query: q="${args.q}"`);
      }
    });

    it('is declared optional in the enrichment block', () => {
      const field = metSearchCollections.enrichment?.effectiveQuery;
      expect(field?.safeParse(undefined).success).toBe(true);
    });
  });

  it('a non-empty filtered page never asks for the keyword-only count', async () => {
    mockSearch.mockResolvedValue({ ...emptyPage, total: 3, objectIDs: [1, 2, 3], returned: 3 });
    const ctx = createMockContext({ errors: metSearchCollections.errors });
    const input = metSearchCollections.input.parse({ q: 'vase', medium: 'Ceramics' });
    await metSearchCollections.handler(input, ctx);

    expect(mockCountKeywordMatches).not.toHaveBeenCalled();
  });

  // --- inputAliases: `query` and `keyword` reach the declared `q` ---
  // The rewrite happens in parseToolArguments, above the handler, so the only
  // seam that exercises it is the full tool contract.

  describe('input aliases', () => {
    const page = {
      total: 3,
      objectIDs: [1, 2, 3],
      returned: 3,
      truncated: false,
      remaining: 0,
      nextOffset: null,
      offset: 0,
    };

    /**
     * An alias is an off-schema key by construction, so the runner's typed
     * argument parameter cannot express one — the cast is what lets the test
     * send the arguments a client actually sends.
     */
    const call = (args: Record<string, unknown>) =>
      runToolContract(
        metSearchCollections,
        args as unknown as z.input<typeof metSearchCollections.input>,
      );

    const textOf = contentText;

    it.each(['query', 'keyword'])('rewrites %s to q before validation', async (alias) => {
      mockSearch.mockResolvedValue(page);
      const result = await call({ [alias]: 'sunflower', limit: 3 });

      expect(result.isError).toBeFalsy();
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'sunflower' }),
        expect.anything(),
        aDeadline(),
      );
      // Both consumption surfaces carry the page, not just structuredContent.
      expect((result.structuredContent as { total: number }).total).toBe(3);
      expect(textOf(result)).toContain('**Total matches:** 3');
    });

    it('leaves a declared q alone when an alias is sent alongside it', async () => {
      mockSearch.mockResolvedValue(page);
      const result = await call({ q: 'sunflower', query: 'tulip', limit: 3 });

      // A rewrite applies only when the target is absent, so `query` stays an
      // unrecognized key and the call is rejected rather than silently choosing.
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('query');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('still rejects an undeclared key that maps to no alias', async () => {
      const result = await call({ q: 'sunflower', sortBy: 'relevance', limit: 3 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('sortBy');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('rejects a missing q as an InvalidParams envelope naming the field', async () => {
      const result = await call({ limit: 3 });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number } }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(textOf(result)).toContain('q');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('delivers a zero result through an alias as a success on both surfaces (#44)', async () => {
      mockSearch.mockResolvedValue({
        total: 0,
        objectIDs: [],
        returned: 0,
        truncated: false,
        remaining: 0,
        nextOffset: null,
        offset: 0,
      });
      const result = await call({ keyword: 'zzznomatch', limit: 3 });

      const structured = structuredOf(result);
      expect(structured.total).toBe(0);
      expect(structured.notice).not.toContain('met_list_departments');
      expect(structured.effectiveQuery).toBe('q="zzznomatch"');
      expect(textOf(result)).toContain('> The keyword "zzznomatch" matches no object');
      expect(textOf(result)).not.toContain('no_results');
    });
  });
});
