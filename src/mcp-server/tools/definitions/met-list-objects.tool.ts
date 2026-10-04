/**
 * @fileoverview Tool: met_list_objects — browse Met object IDs by department and update date, without a keyword.
 * @module mcp-server/tools/definitions/met-list-objects
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getMetService,
  METADATA_DATE_FLOOR,
  startCallDeadline,
} from '@/services/met/met-service.js';

/** A blank from a form client is "unset", never a value to validate. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

/** True when a `YYYY-MM-DD` string names a real calendar day — `2026-02-30` does not. */
function isCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  // setUTCFullYear, not Date.UTC, which reads years 0–99 as 1900–1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * The notice for an empty list: which filters matched nothing, and how to widen
 * it. `updatedSince` is the caller's date, before any clamp to the floor — a date
 * at or before the floor already covers every record, so it is never the filter
 * to widen.
 */
function emptyListNotice(departmentId: number | undefined, updatedSince: string | undefined) {
  const filters = [
    ...(departmentId != null ? [`departmentId ${departmentId}`] : []),
    ...(updatedSince != null ? [`updatedSince ${updatedSince}`] : []),
  ];
  if (filters.length === 0) return 'The Met returned no object IDs for the unfiltered collection.';
  const lead = `No objects match ${filters.join(' and ')}.`;
  if (updatedSince != null && updatedSince <= METADATA_DATE_FLOOR) {
    return departmentId != null
      ? `${lead} ${updatedSince} already covers every record, so the empty list comes from departmentId ${departmentId}; pass another departmentId.`
      : `${lead} ${updatedSince} already covers every record, and the Met returned no object IDs for the collection.`;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (updatedSince != null && updatedSince > today) {
    return `${lead} ${updatedSince} is after today's date (UTC), so no record has been created or revised since then; pass an earlier updatedSince.`;
  }
  const widen = updatedSince != null ? 'Pass an earlier updatedSince' : 'Pass another departmentId';
  return `${lead} ${widen}${filters.length > 1 ? ' or drop a filter' : ''} to widen the list.`;
}

/**
 * The `effectiveQuery` echo: the filters as sent, `updatedSince` after its clamp
 * to the floor, each as `name=` and its JSON-encoded value in schema order.
 */
function describeFilters(departmentId: number | undefined, updatedSince: string | undefined) {
  const applied = [
    ...(departmentId != null ? [`departmentId=${JSON.stringify(departmentId)}`] : []),
    ...(updatedSince != null ? [`updatedSince=${JSON.stringify(updatedSince)}`] : []),
  ];
  return applied.length > 0 ? applied.join(', ') : 'no filter (whole collection)';
}

export const metListObjects = tool('met_list_objects', {
  title: 'List Met Objects',
  description:
    'Browse the Metropolitan Museum of Art collection without a keyword: every object ID in one curatorial department, every object whose record was created or revised on or after a date, or both together. Returns the total count and one page of IDs in ascending order, which met_get_object resolves to full records. With no filter the list is the whole collection (over 500,000 IDs). departmentId takes an ID from met_list_departments; updatedSince takes a YYYY-MM-DD date and answers "what has the Met added or revised since this day". Paging has no depth limit — pass nextOffset to continue. For keyword, classification, place, or object-date filters use met_search_collections instead. A list is cached for up to an hour, so a record revised within the last hour may not appear yet.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  /** `metadataDate` is the Met API's own name for the same single date filter. */
  inputAliases: { metadataDate: 'updatedSince' },
  input: z.object({
    departmentId: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Restrict the list to one curatorial department. Valid IDs come from met_list_departments — the Met exposes a sparse set (roughly 1–21, with gaps); an unrecognized ID is rejected with an invalid_department error rather than answered with an empty list.',
      ),
    updatedSince: blankAsUnset(
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, {
          error: 'updatedSince takes a date as YYYY-MM-DD, with no time part.',
        })
        .optional(),
    ).describe(
      'List only objects whose record was created or revised on or after this date, the day itself included, as YYYY-MM-DD (e.g., "2026-09-01") — no time part and no other date format. It compares the UTC date of each record\'s metadataDate, which met_get_object returns. A date later than the newest update returns an empty list, not an error.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe('Maximum number of object IDs to return in this page.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first ID to return (default 0); pass the nextOffset from a previous response to continue paging. IDs are in ascending order and every one is reachable; an offset at or past total returns an empty page rather than an error.',
      ),
  }),
  output: z.object({
    total: z
      .number()
      .int()
      .describe(
        'Total number of objects matching the filters. Paging reaches every one of them — there is no 10,000 window here.',
      ),
    objectIDs: z
      .array(z.number().int().describe('A Met object ID.'))
      .describe('Object IDs for this page in ascending order, up to `limit` results.'),
    returned: z.number().int().describe('Count of object IDs in this page.'),
    offset: z
      .number()
      .int()
      .describe(
        'The resolved offset this page was read from — the offset input after its default of 0. When it is at or beyond a nonzero total, the page is empty because the offset ran past the list, not because nothing matched.',
      ),
    remaining: z
      .number()
      .int()
      .describe(
        'Count of IDs after this page: total minus (offset + returned), floored at 0. 0 means no further page exists.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when IDs remain after this page (offset + returned < total); false when this page ends the list.',
      ),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe(
        'The offset to pass on the next call to continue paging, or null when this page ends the list (truncated is false).',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present only when total is 0: names the filters that matched nothing and how to widen the list.',
      ),
    effectiveQuery: z
      .string()
      .optional()
      .describe(
        'The filters as applied, as name=value pairs with JSON-encoded values — an updatedSince before 1753-01-01 shows as 1753-01-01, the date sent — or "no filter (whole collection)". limit and offset are left out.',
      ),
  },
  /**
   * Severity separates the modeled outcomes from the incidents: a filter value
   * the caller got wrong is an ordinary answer, not an error-level event.
   */
  errors: [
    {
      reason: 'invalid_department',
      code: JsonRpcErrorCode.ValidationError,
      when: 'departmentId is provided but is not one of the Met department IDs.',
      recovery:
        'Call met_list_departments to get valid department IDs, then retry with one of the returned IDs.',
      severity: 'warning',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'updatedSince has the YYYY-MM-DD shape but names no calendar day, such as 2026-02-30.',
      recovery: 'Pass updatedSince as a real calendar date in YYYY-MM-DD form, such as 2026-09-01.',
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
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'The Met API answered HTTP 500, 502, 503, or 504 to the department lookup or the ID list until the retry ladder ran out — an outage on its side.',
      recovery:
        'The Met API is failing on its side, so changing the request will not help. Wait a few minutes before retrying.',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: "The call's time budget ran out, retries and backoff included, before the Met API returned a successful response to the department lookup or the ID list.",
      recovery:
        "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
    },
  ],

  async handler(input, ctx) {
    const { departmentId, updatedSince } = input;
    if (updatedSince != null && !isCalendarDate(updatedSince)) {
      throw ctx.fail('invalid_date', `updatedSince ${updatedSince} is not a calendar date.`);
    }

    /**
     * The date sent as `metadataDate`, and so the list's cache key. Upstream
     * answers any date before the floor with nothing, though such a date asks
     * for every record — which the floor itself lists — so it is sent as the floor.
     */
    const appliedUpdatedSince =
      updatedSince != null && updatedSince < METADATA_DATE_FLOOR
        ? METADATA_DATE_FLOOR
        : updatedSince;

    // One budget for every request below: the department lookup and the ID list.
    const deadline = startCallDeadline(ctx.signal);

    /**
     * Checked before any `/v1/objects` request: upstream answers an unknown
     * department with an empty list, indistinguishable from a real department
     * with nothing to show.
     */
    if (departmentId != null) {
      const validDepartmentIds = await getMetService().getValidDepartmentIds(ctx, deadline);
      if (!validDepartmentIds.has(departmentId)) {
        throw ctx.fail(
          'invalid_department',
          `departmentId ${departmentId} is not a valid Met department.`,
        );
      }
    }

    ctx.log.info('Met object list', {
      departmentId,
      updatedSince,
      appliedUpdatedSince,
      limit: input.limit,
      offset: input.offset,
    });

    const result = await getMetService().listObjects(
      { ...input, updatedSince: appliedUpdatedSince },
      ctx,
      deadline,
    );

    if (result.total === 0) ctx.enrich.notice(emptyListNotice(departmentId, updatedSince));
    ctx.enrich.echo(describeFilters(departmentId, appliedUpdatedSince));
    return result;
  },

  format: (result) => {
    /**
     * `(offset beyond result set)` needs a nonzero offset, not a nonzero total:
     * an empty list read from offset 0 is complete, and its notice says why it
     * is empty, while one read from offset 50 is still an offset past the end.
     */
    const marker = result.truncated
      ? ' (truncated)'
      : result.offset > 0 && result.offset >= result.total
        ? ' (offset beyond result set)'
        : ' (complete)';
    const lines: string[] = [
      `**Total objects:** ${result.total}`,
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
