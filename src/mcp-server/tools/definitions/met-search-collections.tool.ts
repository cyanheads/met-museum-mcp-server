/**
 * @fileoverview Tool: met_search_collections — search the Met collection by keyword and filters.
 * @module mcp-server/tools/definitions/met-search-collections
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMetService } from '@/services/met/met-service.js';

export const metSearchCollections = tool('met_search_collections', {
  title: 'Search Met Collection',
  description:
    'Search the Metropolitan Museum of Art collection by keyword and optional filters; returns total match count and a page of object IDs. ' +
    'Always chain the returned IDs to met_get_object (up to 20 at a time) to retrieve full records. ' +
    'Search relevance is keyword-based, not semantic — use concise terms and apply departmentId or geoLocation filters to sharpen results. ' +
    'The medium parameter maps to the classification field (pass "Paintings", "Drawings", etc., not material descriptions like "Oil on canvas"). ' +
    'isPublicDomain guarantees CC0-licensed images; hasImages also includes copyrighted works. ' +
    'isOnView restricts results to works currently on display in a Met gallery.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    q: z
      .string()
      .min(1)
      .describe(
        'Keyword query. Searched across title, artist name, culture, medium, tags, and other text fields. ' +
          'Use concise, specific terms — broad queries return large ID sets. ' +
          'Tip: departmentId and geoLocation sharpen results far more than a longer query string.',
      ),
    hasImages: z
      .boolean()
      .optional()
      .describe(
        'When true, restricts results to objects that have at least one associated image. ' +
          'For freely reusable CC0 images, use isPublicDomain instead — hasImages includes copyrighted works whose images cannot be reproduced.',
      ),
    isPublicDomain: z
      .boolean()
      .optional()
      .describe(
        'When true, restricts results to objects released under CC0 open access — free to use without permission or attribution. ' +
          'These objects return direct high-resolution image URLs in met_get_object. ' +
          'Can be combined with departmentId but severely restricts results (the search index only indexes a subset of public-domain objects per department); ' +
          'prefer using isPublicDomain alone and filtering by department from the returned object records.',
      ),
    isHighlight: z
      .boolean()
      .optional()
      .describe(
        'When true, restricts to objects the Met has designated as highlights — major works central to the collection. ' +
          'Use to surface iconic pieces rather than browsing the full corpus.',
      ),
    isOnView: z
      .boolean()
      .optional()
      .describe(
        'When true, restricts results to objects currently on display in a Met gallery. ' +
          'The GalleryNumber field on the met_get_object record identifies the specific gallery. ' +
          'Combine with a keyword to answer "what is on display right now?" — pairs well with isHighlight for must-see works.',
      ),
    medium: z
      .string()
      .optional()
      .describe(
        'Filter by object classification (e.g., "Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles"). ' +
          'Maps to the classification field on the object, not the materials/medium text field — pass a classification category name, not a material description like "Oil on canvas".',
      ),
    departmentId: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Restrict results to one curatorial department. Call met_list_departments to get valid IDs — the Met exposes a sparse set (roughly 1–21, with gaps), and an unrecognized ID is rejected with an invalid_department error rather than silently returning no matches. ' +
          'Can be combined with other filters; combining with isPublicDomain works but returns far fewer results than expected — ' +
          'use isPublicDomain alone when CC0 coverage is the goal.',
      ),
    geoLocation: z
      .array(
        z.string().describe('A country, region, or city (e.g., "France", "Egypt", "New York").'),
      )
      .optional()
      .describe(
        'Filter by geographic origin. Each value is matched broadly against geography fields and artist nationality. ' +
          'Multiple values are AND-combined — ["France", "Egypt"] returns objects associated with both, not either; use a single value for broader results. ' +
          'Works best with the Egyptian Art, Greek and Roman Art, and similar departments that have well-populated geography fields.',
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
        'Maximum number of object IDs to return from the full result set. ' +
          'The API returns all matches (up to tens of thousands) — this caps what is handed back. ' +
          'Chain the returned IDs to met_get_object in batches of up to 20.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index into the full result set to start from (default 0). ' +
          'Paginate by passing the nextOffset returned by a previous call; each page re-runs the upstream search and applies the offset locally, so a broad query carries the same timeout risk on every page — narrow it with filters if paging times out. ' +
          'An offset at or beyond total returns an empty page, not an error.',
      ),
  }),
  output: z.object({
    total: z
      .number()
      .int()
      .describe(
        'Total number of matching objects in the Met collection (may far exceed the returned IDs).',
      ),
    objectIDs: z
      .array(
        z
          .number()
          .int()
          .describe('A Met object ID. Pass to met_get_object to retrieve the full record.'),
      )
      .describe(
        'Object IDs for the first `limit` results. Pass to met_get_object (up to 20 at a time) to retrieve full records.',
      ),
    returned: z
      .number()
      .int()
      .describe(
        'Count of object IDs in this response — may be less than `total` when the full result set was truncated by `limit`.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when matching IDs remain beyond this page (offset + returned < total). Pass nextOffset as offset to fetch the next page, increase limit, or refine filters to narrow results.',
      ),
    remaining: z
      .number()
      .int()
      .describe(
        'Count of matching object IDs after this page: total − (offset + returned), floored at 0. 0 means this is the last page.',
      ),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe(
        'The offset to pass on the next call to continue paging, or null when the result set is exhausted (truncated is false).',
      ),
  }),
  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'total is 0 — the API returned null objectIDs for this query+filter combination.',
      recovery:
        'Broaden the query, remove filters, or call met_list_departments and set a valid departmentId.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dateBegin or dateEnd is provided without the other, or dateBegin > dateEnd.',
      recovery: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
    },
    {
      reason: 'invalid_department',
      code: JsonRpcErrorCode.ValidationError,
      when: 'departmentId is provided but is not one of the Met department IDs.',
      recovery:
        'Call met_list_departments to get valid department IDs, then retry with one of the returned IDs.',
    },
    {
      reason: 'search_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The result set is too large to download within the request timeout — a broad, unfiltered query.',
      recovery:
        'Narrow the query or add filters (departmentId, geoLocation, medium, or dateBegin plus dateEnd) to shrink the result set, then retry.',
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
        ctx.recoveryFor('invalid_date_range'),
      );
    }
    if (hasBegin && hasEnd && (input.dateBegin ?? 0) > (input.dateEnd ?? 0)) {
      throw ctx.fail(
        'invalid_date_range',
        `dateBegin (${input.dateBegin}) must be ≤ dateEnd (${input.dateEnd}).`,
        ctx.recoveryFor('invalid_date_range'),
      );
    }

    // Validate departmentId against the live (cached) Met department set so an
    // unknown ID fails fast with actionable guidance instead of falling through to
    // an ambiguous no_results.
    if (input.departmentId != null) {
      const validDepartmentIds = await getMetService().getValidDepartmentIds(ctx);
      if (!validDepartmentIds.has(input.departmentId)) {
        throw ctx.fail(
          'invalid_department',
          `departmentId ${input.departmentId} is not a valid Met department.`,
          ctx.recoveryFor('invalid_department'),
        );
      }
    }

    ctx.log.info('Met search', {
      q: input.q,
      hasImages: input.hasImages,
      isPublicDomain: input.isPublicDomain,
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
        isPublicDomain: input.isPublicDomain,
        isHighlight: input.isHighlight,
        isOnView: input.isOnView,
        medium: input.medium,
        departmentId: input.departmentId,
        geoLocation: input.geoLocation,
        dateBegin: input.dateBegin,
        dateEnd: input.dateEnd,
      },
      ctx,
    );

    if (result.total === 0) {
      throw ctx.fail(
        'no_results',
        `No objects matched the query "${input.q}" with the specified filters.`,
        ctx.recoveryFor('no_results'),
      );
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `**Total matches:** ${result.total}`,
      `**Returned IDs:** ${result.returned}${result.truncated ? ' (truncated)' : ''}`,
      `**Remaining:** ${result.remaining}`,
      `**Next offset:** ${result.nextOffset ?? 'none'}`,
      '',
      '**Object IDs:**',
      result.objectIDs.join(', '),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
