/**
 * @fileoverview Tool: met_search_collections — search the Met collection by keyword and filters.
 * @module mcp-server/tools/definitions/met-search-collections
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getMetService,
  SEARCH_RESULT_WINDOW,
  type SearchInput,
  startCallDeadline,
} from '@/services/met/met-service.js';

/** Thousands-separated, so the window and a large total read alike in prose. */
const count = (n: number) => n.toLocaleString('en-US');

/** The filter parameters a search input set, by the names a caller passes them under. */
function filtersUsed(input: Omit<SearchInput, 'q' | 'limit' | 'offset'>): string[] {
  const names: string[] = [];
  if (input.hasImages != null) names.push('hasImages');
  if (input.isHighlight != null) names.push('isHighlight');
  if (input.isOnView != null) names.push('isOnView');
  if (input.medium != null) names.push('medium');
  if (input.departmentId != null) names.push('departmentId');
  if (input.geoLocation != null) names.push('geoLocation');
  if (input.dateBegin != null) names.push('dateBegin/dateEnd');
  return names;
}

/**
 * The `no_results` recovery, composed from the levers the call used so one retry
 * clears it. `keywordMatches` is the keyword's match count with no filter
 * applied: `0` means the keyword is the problem and no filter is named; a
 * positive count means the filters removed every match; `null` means that check
 * failed, so every filter is named because the caller did set them.
 */
function noResultsHint(q: string, filters: string[], keywordMatches: number | null): string {
  if (keywordMatches === 0) {
    const scope = filters.length > 0 ? ', even with no filter applied' : '';
    return `The keyword "${q}" matches no object in the collection${scope}. Try a different, broader, or differently spelled keyword.`;
  }
  const one = filters.length === 1;
  const noun = one ? 'filter' : 'filters';
  const list = filters.join(', ');
  const lead =
    keywordMatches === null
      ? `The ${noun} may have removed every match: ${list} — whether "${q}" matches on its own could not be checked.`
      : `The keyword "${q}" matches ${count(keywordMatches)} object${keywordMatches === 1 ? '' : 's'} on its own, so the ${noun} removed every match: ${list}.`;
  const medium = filters.includes('medium')
    ? ' medium takes an object classification, case-sensitive and spelled as the Met spells it ("Paintings", "Prints", "Sculpture"), not a material description; met_get_object returns an object’s classification.'
    : '';
  return `${lead} Correct or drop ${one ? 'it' : 'them'}, then retry.${medium}`;
}

/** `" with the filter medium"` / `" with the filters medium, departmentId"`, or nothing. */
function filterScope(filters: string[]): string {
  if (filters.length === 0) return '';
  return ` with the ${filters.length === 1 ? 'filter' : 'filters'} ${filters.join(', ')}`;
}

export const metSearchCollections = tool('met_search_collections', {
  title: 'Search Met Collection',
  description:
    'Search the Metropolitan Museum of Art collection by keyword and optional filters. Returns the total match count and one page of matching object IDs, which met_get_object resolves to full records. Relevance is keyword-based, not semantic; department and geographic filters narrow results more than a longer query. Paging reaches only the first 10,000 matches of any search, so narrow a larger one with filters. The medium parameter takes an object classification as the Met spells it ("Paintings", "Sculpture"), not a material like "Oil on canvas". hasImages also includes copyrighted works; CC0 status is per object, from the isPublicDomain and hasCC0Image fields on met_get_object. isHighlight accepts true only. isOnView restricts results to works currently on display in a Met gallery.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  /**
   * `q` is the Met API's own parameter name, kept so the tool reads like the
   * upstream it wraps. It is also a single letter, which is the spelling a
   * caller is least likely to reach for first — both aliases name the same
   * single text input this tool accepts, so neither is ambiguous.
   */
  inputAliases: { query: 'q', keyword: 'q' },
  input: z.object({
    q: z
      .string()
      .min(1)
      .describe(
        'Keyword query, matched across title, artist name, culture, medium, tags, and other text fields. Broad terms return large ID sets.',
      ),
    hasImages: z
      .boolean()
      .optional()
      .describe(
        'When true, restricts results to objects that have at least one associated image, including copyrighted works whose images cannot be reproduced; false restricts them to objects with none. For freely reusable CC0 images, confirm per object from the isPublicDomain and hasCC0Image fields on met_get_object.',
      ),
    isHighlight: z
      .literal(true, {
        error: 'isHighlight accepts true only — omit the filter instead of passing false.',
      })
      .optional()
      .describe(
        'Opt-in filter, true only — omit it rather than passing false, which the search ignores. Selects objects the Met has designated as highlights — major works central to the collection.',
      ),
    isOnView: z
      .boolean()
      .optional()
      .describe(
        'When true, restricts results to objects currently on display in a Met gallery; false restricts them to objects not on view. The GalleryNumber field on the met_get_object record identifies the specific gallery.',
      ),
    medium: z
      .string()
      .optional()
      .describe(
        'Filter by object classification, case-sensitive and spelled as the Met spells it (e.g., "Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles") — "paintings" or "Painting" matches nothing. Maps to the classification field on the object, not the materials text, so a material description like "Oil on canvas" matches nothing either; met_get_object returns an object’s classification.',
      ),
    departmentId: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Restrict results to one curatorial department. Valid IDs come from met_list_departments — the Met exposes a sparse set (roughly 1–21, with gaps); an unrecognized ID is rejected with an invalid_department error rather than silently widening the search. Can be combined with other filters.',
      ),
    geoLocation: z
      .array(
        z.string().describe('A country, region, or city (e.g., "France", "Egypt", "New York").'),
      )
      .max(1, {
        error:
          'geoLocation takes one location — the Met search applies only the first value, so pass a single location.',
      })
      .optional()
      .describe(
        'Filter by geographic origin: one country, region, or city, as a one-element array (e.g., ["France"]). The value is matched broadly against geography fields and artist nationality. Works best with the Egyptian Art, Greek and Roman Art, and similar departments that have well-populated geography fields.',
      ),
    dateBegin: z
      .number()
      .int()
      .optional()
      .describe(
        'Earliest object date (year, inclusive). Negative integers for BCE (e.g., -500 for 500 BCE). Requires dateEnd.',
      ),
    dateEnd: z
      .number()
      .int()
      .optional()
      .describe(
        'Latest object date (year, inclusive). Negative integers for BCE. Requires dateBegin.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe(
        'Maximum number of object IDs to return in this page. Paging reaches only the first 10,000 matches, so a page that would cross 10,000 is cut short there.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first match to return (default 0); pass the nextOffset from a previous response to continue paging. Only the first 10,000 matches are reachable, so an offset at or beyond 10,000, or at or beyond a nonzero total, returns an empty page rather than an error. Matches with tied relevance can change order between requests, so an ID can occasionally repeat or be skipped at a page boundary.',
      ),
  }),
  output: z.object({
    total: z
      .number()
      .int()
      .describe(
        'Total number of objects in the Met collection matching the search. Can exceed 10,000, the most that paging reaches.',
      ),
    objectIDs: z
      .array(z.number().int().describe('A Met object ID.'))
      .describe('Object IDs for this page, up to `limit` results.'),
    returned: z.number().int().describe('Count of object IDs in this page.'),
    truncated: z
      .boolean()
      .describe(
        'True when reachable matches remain after this page (offset + returned < the smaller of total and 10,000); false when this page is the last one paging reaches.',
      ),
    remaining: z
      .number()
      .int()
      .describe(
        'Count of reachable matches after this page: the smaller of total and 10,000, minus (offset + returned), floored at 0. 0 means no further page exists.',
      ),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe(
        'The offset to pass on the next call to continue paging, or null when no further page is reachable (truncated is false).',
      ),
    offset: z
      .number()
      .int()
      .describe(
        'The resolved offset this page was read from — the offset input after its default of 0. When it is at or beyond the smaller of total and 10,000, the page is empty because the offset ran past what paging reaches, not because the search found nothing.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present only when total exceeds 10,000: states that only the first 10,000 matches are reachable by paging, and that filters or a more specific keyword bring the rest into reach.',
      ),
  },
  /**
   * Severity separates the modeled outcomes from the incidents. A query that
   * matches nothing and a filter the caller spelled wrong are ordinary answers
   * this tool is built to give, and logging them at `error` beside a genuine
   * upstream fault is what makes an error stream unreadable.
   */
  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'total is 0 — no object matches the keyword, or none of its matches survives the filters.',
      recovery: 'Try a different or broader keyword, or correct or drop the filters, then retry.',
      severity: 'notice',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dateBegin or dateEnd is provided without the other, or dateBegin > dateEnd.',
      recovery: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
      severity: 'warning',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'q is whitespace-only, or medium or geoLocation was supplied blank — an empty array, or an entry with no non-whitespace characters.',
      recovery:
        'Supply a non-blank value for the named field, or omit the optional filter entirely.',
      severity: 'warning',
    },
    {
      reason: 'invalid_department',
      code: JsonRpcErrorCode.ValidationError,
      when: 'departmentId is provided but is not one of the Met department IDs.',
      recovery:
        'Call met_list_departments to get valid department IDs, then retry with one of the returned IDs.',
      severity: 'warning',
    },
    {
      reason: 'upstream_blocked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      thrownBy: 'service',
      when: "The Met API's firewall refused the request with HTTP 403 — it blocks this server's address, not one endpoint.",
      recovery: 'Wait several minutes before retrying, and send fewer requests.',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: "The call's time budget ran out, retries and backoff included, before the Met API returned a successful response to the department lookup or the search.",
      recovery:
        "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
    },
  ],

  async handler(input, ctx) {
    // Validate date range
    const hasBegin = input.dateBegin != null;
    const hasEnd = input.dateEnd != null;
    if (hasBegin !== hasEnd) {
      throw ctx.fail(
        'invalid_date_range',
        'dateBegin and dateEnd must both be provided or both omitted.',
      );
    }
    if (hasBegin && hasEnd && (input.dateBegin ?? 0) > (input.dateEnd ?? 0)) {
      throw ctx.fail(
        'invalid_date_range',
        `dateBegin (${input.dateBegin}) must be ≤ dateEnd (${input.dateEnd}).`,
      );
    }

    /**
     * Reject blank filter values before any upstream call. The Met search ignores
     * a blank parameter, and a blank the URL builder drops is skipped the same way,
     * so either path silently widens the search to unfiltered — indistinguishable
     * from a correct answer at the call site. The only safe handling is to refuse.
     * Ordered after the date-range checks so a request invalid on both counts
     * reports the same fault it reports today.
     */
    if (input.q.trim() === '') {
      throw ctx.fail(
        'invalid_filter',
        'q is whitespace-only — it must contain at least one non-whitespace character.',
      );
    }
    if (input.medium?.trim() === '') {
      throw ctx.fail(
        'invalid_filter',
        'medium is blank — supply a classification name such as "Paintings", or omit the filter.',
      );
    }
    if (input.geoLocation?.length === 0) {
      throw ctx.fail(
        'invalid_filter',
        'geoLocation is an empty array — supply at least one location, or omit the filter.',
      );
    }
    if (input.geoLocation?.some((location) => location.trim() === '')) {
      throw ctx.fail(
        'invalid_filter',
        'geoLocation contains a blank entry — every value must be a non-blank location name.',
      );
    }

    // One budget for every request below: the department lookup, the search, and the keyword count.
    const deadline = startCallDeadline(ctx.signal);

    /**
     * Validate departmentId against the live (cached) Met department set. The Met
     * search ignores an unknown ID and answers unfiltered, so an unchecked typo
     * would quietly widen the search instead of failing.
     */
    if (input.departmentId != null) {
      const validDepartmentIds = await getMetService().getValidDepartmentIds(ctx, deadline);
      if (!validDepartmentIds.has(input.departmentId)) {
        throw ctx.fail(
          'invalid_department',
          `departmentId ${input.departmentId} is not a valid Met department.`,
        );
      }
    }

    ctx.log.info('Met search', {
      q: input.q,
      hasImages: input.hasImages,
      departmentId: input.departmentId,
      limit: input.limit,
      offset: input.offset,
    });

    const result = await getMetService().search(
      {
        q: input.q,
        limit: input.limit,
        offset: input.offset,
        hasImages: input.hasImages,
        isHighlight: input.isHighlight,
        isOnView: input.isOnView,
        medium: input.medium,
        departmentId: input.departmentId,
        geoLocation: input.geoLocation,
        dateBegin: input.dateBegin,
        dateEnd: input.dateEnd,
      },
      ctx,
      deadline,
    );

    if (result.total === 0) {
      /**
       * The hint has to be built here rather than declared: the declared
       * recovery is a static string keyed only by the reason. Whether the keyword
       * matches on its own is the one fact that tells a bad keyword from filters
       * that removed every match, and it costs a request only on this path — an
       * unfiltered zero already answers it.
       */
      const filters = filtersUsed(input);
      const keywordMatches =
        filters.length > 0 ? await getMetService().countKeywordMatches(input.q, ctx, deadline) : 0;
      throw ctx.fail(
        'no_results',
        `No objects matched the query "${input.q}"${filterScope(filters)}.`,
        {
          recovery: { hint: noResultsHint(input.q, filters, keywordMatches) },
        },
      );
    }

    if (result.total > SEARCH_RESULT_WINDOW) {
      ctx.enrich.notice(
        `Only the first ${count(SEARCH_RESULT_WINDOW)} of ${count(result.total)} matches are reachable by paging. Narrow the search with filters or a more specific keyword to reach the rest.`,
      );
    }

    return result;
  },

  format: (result) => {
    /**
     * Four states. `(complete)` claims a page finished the result set, which is
     * wrong for a page that is empty because the offset ran past what paging
     * reaches, and for a last page that stops at the 10,000 window short of
     * `total`. The markers are gated on the resolved `offset` against the
     * reachable count — the condition itself — rather than on `returned === 0`,
     * which is also true of a page the upstream answered with a null ID array.
     */
    const reachable = Math.min(result.total, SEARCH_RESULT_WINDOW);
    const marker = result.truncated
      ? ' (truncated)'
      : result.offset >= reachable
        ? ' (offset beyond result set)'
        : reachable < result.total
          ? ' (window end)'
          : ' (complete)';
    const lines: string[] = [
      `**Total matches:** ${result.total}`,
      `**Returned IDs:** ${result.returned}${marker}`,
      `**Offset:** ${result.offset}`,
      `**Remaining:** ${result.remaining}`,
      `**Next offset:** ${result.nextOffset ?? 'none'}`,
      '',
      '**Object IDs:**',
      result.objectIDs.join(', '),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
