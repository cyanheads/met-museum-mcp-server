/**
 * @fileoverview Tool: met_get_object — fetch full records for one or more Met object IDs.
 * @module mcp-server/tools/definitions/met-get-object
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getMetService } from '@/services/met/met-service.js';
import { escapeMarkdown, isHttpUrl } from '@/utils/markdown.js';

const ConstituentSchema = z
  .object({
    constituentID: z.number().int().describe('Constituent identifier for cross-referencing.'),
    role: z
      .string()
      .describe('Role in relation to the object (e.g., "Artist", "Maker", "Designer").'),
    name: z.string().describe('Constituent display name.'),
    constituentULAN_URL: z
      .string()
      .describe(
        'Getty ULAN (Union List of Artist Names) URL for the constituent. Empty when no ULAN record exists.',
      ),
    constituentWikidata_URL: z
      .string()
      .describe(
        'Wikidata entity URL for the constituent. Useful for enrichment via wikidata-mcp-server. Empty when no Wikidata record exists.',
      ),
    gender: z
      .string()
      .describe(
        'Gender of the constituent. Usually empty string — sparsely populated in the Met catalogue.',
      ),
  })
  .describe('A person associated with the object.');

const TagSchema = z
  .object({
    term: z.string().describe('Tag label (e.g., "Men", "Self-portraits", "Flowers").'),
    AAT_URL: z.string().describe('Getty Art & Architecture Thesaurus URL for the term.'),
    Wikidata_URL: z.string().describe('Wikidata entity URL for the term. Useful for enrichment.'),
  })
  .describe('A controlled vocabulary tag applied to the object.');

const GeographySchema = z
  .object({
    geographyType: z
      .string()
      .describe(
        'How the object relates to the place (e.g., "From", "Original", "Probably originally from"). Empty when the Met records no findspot.',
      ),
    city: z
      .string()
      .describe(
        'City of origin or findspot (e.g., "Damascus", "Constantinople (?)", "Springfield"). The most widely populated field of this block outside the archaeological departments; empty when the Met records no city.',
      ),
    state: z
      .string()
      .describe(
        'State or province of origin (e.g., "Massachusetts"). Sparse, and concentrated in departments that catalogue a manufacturing place. Empty when the Met records none.',
      ),
    county: z.string().describe('County of origin. Empty on nearly every record.'),
    subregion: z
      .string()
      .describe(
        'Sub-region or site within the region (e.g., "Saqqara", "Deir el-Bahri"). Commonly populated for archaeological departments, empty elsewhere.',
      ),
    locale: z
      .string()
      .describe(
        'Named place within the site (e.g., "Late Period cemetery, Tomb of Harkhebit"). Excavated objects only.',
      ),
    locus: z
      .string()
      .describe(
        'Specific findspot within the locale (e.g., "burial chamber"). Excavated objects only.',
      ),
    excavation: z
      .string()
      .describe(
        'Excavation that recovered the object (e.g., "MMA excavations, 1928-29"). Excavated objects only.',
      ),
    river: z.string().describe('Associated river. Empty on nearly every record.'),
  })
  .describe(
    'Findspot detail beyond the top-level country and region, which are not repeated here. Every field is an empty string when the Met records nothing; population concentrates in the archaeological departments.',
  );

const MeasurementSchema = z
  .object({
    elementName: z
      .string()
      .describe('Which part of the object was measured (e.g., "Overall", "Other", "Length").'),
    elementDescription: z
      .string()
      .describe(
        'Qualifier distinguishing this element from a sibling with the same name (e.g., "Print" vs "Negativ"). Empty when the Met records none.',
      ),
    elementMeasurements: z
      .record(
        z.string().describe('Measurement axis (e.g., "Height", "Width", "Depth", "Length").'),
        z.number().describe('Measured value — centimeters for spatial axes, kilograms for weight.'),
      )
      .describe(
        'Measured axes for this element. Which keys are present varies element to element, so read the keys rather than assuming a fixed set. Empty object when the Met records no values.',
      ),
  })
  .describe('One measured element of the object.');

const ObjectSchema = z
  .object({
    objectID: z.number().int().describe('Unique Met object identifier.'),
    title: z.string().describe('Object title as catalogued.'),
    isPublicDomain: z
      .boolean()
      .describe(
        'True when the object is released under CC0 open access. Only true objects return usable image URLs.',
      ),
    hasCC0Image: z
      .boolean()
      .describe(
        "True when a CC0 open-access image URL is available (primaryImage is non-empty). Distinct from met_search_collections's hasImages filter, which matches objects that have any image including copyrighted works.",
      ),
    primaryImage: z
      .string()
      .describe(
        'Full-resolution image URL (CC0 objects only; empty string for non-public-domain works).',
      ),
    primaryImageSmall: z
      .string()
      .describe(
        'Web-display image URL (~800px; CC0 objects only; empty string for non-public-domain works).',
      ),
    additionalImages: z
      .array(z.string().describe('An additional image URL (detail shot or alternate view).'))
      .describe('Additional image URLs (detail shots, alternate views). CC0 objects only.'),
    objectURL: z.string().describe('Canonical metmuseum.org page URL for human follow-up.'),
    department: z
      .string()
      .describe('Curatorial department (e.g., "European Paintings", "Egyptian Art").'),
    objectName: z
      .string()
      .describe('Object type or classification name (e.g., "Painting", "Statuette").'),
    classification: z
      .string()
      .describe('Broad classification category (e.g., "Paintings", "Ceramics").'),
    isHighlight: z.boolean().describe('True when the Met designates this a collection highlight.'),
    isTimelineWork: z.boolean().describe("True when the work appears in the Met's art timeline."),
    artistDisplayName: z
      .string()
      .describe(
        'Primary artist name as displayed (e.g., "Vincent van Gogh"). Empty for anonymous or unknown works.',
      ),
    artistDisplayBio: z
      .string()
      .describe(
        'Artist biographical summary including nationality, birth/death place and year (e.g., "Dutch, Zundert 1853–1890 Auvers-sur-Oise"). Empty for anonymous works.',
      ),
    artistNationality: z
      .string()
      .describe('Artist\'s nationality (e.g., "Dutch", "French"). Empty for anonymous works.'),
    artistBeginDate: z
      .string()
      .describe('Artist birth year as a string (e.g., "1853"). Empty for anonymous works.'),
    artistEndDate: z
      .string()
      .describe('Artist death year as a string. Empty for living or anonymous.'),
    constituents: z
      .array(ConstituentSchema)
      .nullable()
      .describe(
        'All persons associated with the object. Null for anonymous or unknown attribution.',
      ),
    objectDate: z
      .string()
      .describe('Human-readable date string (e.g., "1887", "ca. 1295–1294 B.C.", "1700–1800").'),
    objectBeginDate: z
      .number()
      .int()
      .nullable()
      .describe(
        'Earliest date as an integer year (negative = BCE). Null when the Met has no machine-readable date for the work — read objectDate for what is known instead, and do not treat null as year zero or substitute a default.',
      ),
    objectEndDate: z
      .number()
      .int()
      .nullable()
      .describe(
        'Latest date as an integer year (negative = BCE). Null under the same condition as objectBeginDate — the two are null together.',
      ),
    medium: z
      .string()
      .describe('Materials and techniques (e.g., "Oil on canvas", "Bronze", "Limestone").'),
    dimensions: z
      .string()
      .describe('Dimensions as a formatted string (e.g., "16 x 12 1/2 in. (40.6 x 31.8 cm)").'),
    culture: z
      .string()
      .describe(
        'Cultural origin when not attributed to an individual (e.g., "Japanese", "Roman"). Often empty for Western art with named artists.',
      ),
    period: z
      .string()
      .describe('Historical period (e.g., "New Kingdom, Ramesside", "Meiji period"). Often empty.'),
    dynasty: z
      .string()
      .describe('Dynasty for applicable cultures (e.g., "Dynasty 19"). Often empty.'),
    accessionNumber: z.string().describe("The Met's accession number for the object."),
    creditLine: z.string().describe('Provenance and gift/bequest attribution.'),
    country: z.string().describe('Country of origin. Often empty.'),
    region: z.string().describe('Geographic region of origin. Often empty.'),
    geography: GeographySchema,
    measurements: z
      .array(MeasurementSchema)
      .nullable()
      .describe(
        'Structured element measurements — the numeric counterpart to the formatted dimensions string. Null when the Met records none.',
      ),
    tags: z
      .array(TagSchema)
      .nullable()
      .describe('Controlled vocabulary tags applied to the object. Null when no tags assigned.'),
    objectWikidata_URL: z
      .string()
      .describe(
        'Wikidata entity URL for the object itself. Enables enrichment via wikidata-mcp-server.',
      ),
    GalleryNumber: z
      .string()
      .describe(
        'Gallery room number at the museum. Empty string for objects not currently on display.',
      ),
  })
  .describe('A fully fetched Met Museum object record.');

/**
 * Cumulative serialized-byte ceiling for the records one call returns.
 *
 * Measured on `structuredContent`, the surface that dominates, and only on it.
 * `content[]` renders the same admitted records as markdown, so what reaches the
 * wire is roughly twice this number — the disclosure says so rather than letting
 * a caller read the budget as a response-size cap.
 *
 * The axis is the sum, not the record: no single Met record approaches an
 * overflow (the heaviest measured normalizes to under 4 KB), while twenty of
 * them together are what produces a six-figure response. So this is not the
 * framework's per-document `outlineOnOverflow` budget applied per object —
 * that would never fire here — but the same idea moved to the batch.
 *
 * The number is where the advertised 20-ID cap meets the measured record size:
 * 60,000 / 20 = 3,000 bytes per record, which sits between a typical normalized
 * record and the heaviest sampled one. A full 20-ID batch of ordinary records
 * therefore comes back whole and unchanged, and only a batch whose records run
 * heavy — the case this bound exists for — spends the budget early.
 *
 * A helper constant, deliberately not an env var: a deploy-tunable threshold
 * would drift the tool's response shape between environments.
 */
const BATCH_BUDGET_BYTES = 60_000;

const utf8 = new TextEncoder();

/**
 * Serialized size of a record in bytes, not UTF-16 code units. Met catalog text
 * is full of multi-byte characters (en dashes in date spans, accented artist
 * names), so a `.length` measurement understates the real payload.
 */
function serializedBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

export const metGetObject = tool('met_get_object', {
  title: 'Get Met Objects',
  description:
    'Fetch full records for one or more Met Museum object IDs. Accepts up to 20 IDs per call and returns partial success — a single 404 does not fail the whole batch; per-ID failures are reported separately. ' +
    'Object IDs come from met_search_collections. Non-public-domain objects return empty image URLs. ' +
    'The constituents array is null for anonymous or unattributed works; tags and measurements are null when the Met records none. ' +
    'Records are returned whole and never truncated, so a batch of unusually large records may return fewer than requested — any that did not fit are listed in deferred[] with their sizes, to be re-requested in a follow-up call.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    objectIDs: z
      .array(z.number().int().positive().describe('A Met object ID from met_search_collections.'))
      .min(1)
      .max(20)
      .describe(
        'One or more Met object IDs to fetch. Maximum 20 per call. IDs come from met_search_collections. ' +
          'A repeated ID is fetched and returned once, at its first position. ' +
          'Partial failures are reported per ID rather than failing the whole batch.',
      ),
  }),
  output: z.object({
    objects: z.array(ObjectSchema).describe('Successfully fetched objects.'),
    failed: z
      .array(
        z
          .object({
            objectID: z.number().int().describe('Object ID that could not be fetched.'),
            error: z.string().describe('Error detail and suggested recovery action.'),
          })
          .describe('A per-ID fetch failure.'),
      )
      .describe('Object IDs that failed to fetch with per-ID error context.'),
    deferred: z
      .array(
        z
          .object({
            objectID: z
              .number()
              .int()
              .describe('Object ID whose record was fetched but withheld from this response.'),
            bytes: z
              .number()
              .int()
              .nonnegative()
              .describe(
                'Serialized structuredContent size of the withheld record — the same scale the budget is measured on — so a follow-up batch can be sized before it is requested.',
              ),
          })
          .describe('A record fetched successfully but withheld to keep the response bounded.'),
      )
      .optional()
      .describe(
        'Records that were fetched but did not fit the call’s cumulative budget on serialized structuredContent bytes, in request order. Re-call met_get_object with these IDs to retrieve them. Absent when every fetched record fit.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'How to retrieve the deferred records, with the budget applied. Present only when the batch byte budget deferred a record.',
      ),
  },
  errors: [
    {
      reason: 'all_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every requested objectID returned a 404 — all IDs are stale or invalid.',
      recovery:
        'Verify the IDs with met_search_collections — they may be stale search-index entries.',
    },
    {
      reason: 'all_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every requested objectID failed due to network errors or API downtime.',
      recovery:
        'Retry after a brief delay. If one ID fails repeatedly, verify it with met_search_collections.',
    },
  ],

  async handler(input, ctx) {
    const { batchConcurrency } = getServerConfig();
    const service = getMetService();

    // De-duplicated up front, first occurrence winning its position. A repeated
    // ID would otherwise be fetched twice, charged to the byte budget twice —
    // displacing a distinct record that would have fit — and, once the budget
    // was spent, land in both objects[] and deferred[], telling the caller to
    // re-request a record it had already received.
    const objectIDs = [...new Set(input.objectIDs)];

    ctx.log.info('Met batch object fetch', { count: objectIDs.length });

    type SuccessItem = {
      ok: true;
      objectID: number;
      record: NonNullable<Awaited<ReturnType<typeof service.getObject>>>;
    };
    type FailItem = { ok: false; objectID: number; error: string; kind: 'not_found' | 'error' };
    // Index-addressed, not push-ordered: each result is written at its input position so
    // objects[] and failed[] follow the caller's objectIDs order regardless of the order
    // fetches complete in under concurrency. A shared cursor claims positions; `nextIndex++`
    // is atomic between awaits, so each index is taken by exactly one worker.
    const results = new Array<SuccessItem | FailItem>(objectIDs.length);
    let nextIndex = 0;

    const processNext = async (): Promise<void> => {
      while (nextIndex < objectIDs.length) {
        const index = nextIndex++;
        const objectID = objectIDs[index];
        if (objectID == null) break;
        try {
          const record = await service.getObject(objectID, ctx);
          if (record == null) {
            results[index] = {
              ok: false,
              objectID,
              kind: 'not_found',
              error: `Object ${objectID} not found in the Met collection. Verify the ID with met_search_collections.`,
            };
          } else {
            results[index] = { ok: true, objectID, record };
          }
        } catch (err) {
          results[index] = {
            ok: false,
            objectID,
            kind: 'error',
            error: `Failed to fetch object ${objectID}: ${err instanceof Error ? err.message : String(err)}. Retry after a brief delay.`,
          };
        }
      }
    };

    // Drain the input list with a fixed concurrency limit.
    const workers = Array.from({ length: Math.min(batchConcurrency, objectIDs.length) }, () =>
      processNext(),
    );
    await Promise.all(workers);

    const succeeded = results.filter((r): r is SuccessItem => r.ok);
    const failItems = results.filter((r): r is FailItem => !r.ok);
    const failed = failItems.map((r) => ({ objectID: r.objectID, error: r.error }));

    // Admit whole records in request order while the cumulative budget lasts, and
    // stop at the first that does not fit — the returned set is a prefix of the
    // successes, so a re-call with the deferred IDs continues where this left off.
    const sized = succeeded.map((item) => ({ ...item, bytes: serializedBytes(item.record) }));
    let admitted = 0;
    let usedBytes = 0;
    for (const item of sized) {
      // The first success is admitted unconditionally: a record larger than the
      // whole budget must still be reachable, or its ID never comes back at all.
      if (admitted > 0 && usedBytes + item.bytes > BATCH_BUDGET_BYTES) break;
      usedBytes += item.bytes;
      admitted++;
    }
    const objects = sized.slice(0, admitted).map((item) => item.record);
    const deferred = sized
      .slice(admitted)
      .map((item) => ({ objectID: item.objectID, bytes: item.bytes }));

    if (objects.length === 0) {
      const allNotFound = failItems.every((f) => f.kind === 'not_found');
      if (allNotFound) {
        throw ctx.fail(
          'all_not_found',
          `All ${objectIDs.length} requested object ${objectIDs.length === 1 ? 'ID' : 'IDs'} not found.`,
          ctx.recoveryFor('all_not_found'),
        );
      }
      throw ctx.fail(
        'all_failed',
        `All ${objectIDs.length} object fetches failed.`,
        ctx.recoveryFor('all_failed'),
      );
    }

    ctx.log.info('Met batch complete', {
      fetched: succeeded.length,
      returned: objects.length,
      failed: failed.length,
      deferred: deferred.length,
    });
    if (deferred.length === 0) return { objects, failed };

    ctx.enrich.notice(
      `Returned ${objects.length} of ${succeeded.length} fetched records — ${usedBytes} bytes of serialized structuredContent against a ${BATCH_BUDGET_BYTES}-byte budget measured on that surface alone; content[] renders the same records again, so the delivered response is roughly twice that. ` +
        `The remaining ${deferred.length} would exceed the budget. Re-call met_get_object with the deferred objectIDs to retrieve them; each record's listed size is on the same structuredContent scale, so sum them against the budget before requesting several.`,
    );
    return { objects, failed, deferred };
  },

  format: (result) => {
    const lines: string[] = [];
    /** Placeholder for an absent value. */
    const orDash = (v: string) => v || '—';
    /**
     * Upstream catalog prose. Escaped at this boundary so a title, credit line,
     * or tag carrying Markdown syntax cannot restructure `content[]` or hide
     * itself from a client that reads only that surface.
     */
    const prose = (v: string) => orDash(escapeMarkdown(v));
    /**
     * A URL-shaped upstream field rendered on its own. Validated rather than
     * escaped — a backslash inside a destination breaks the link — and anything
     * that is not an http URL is catalog text, so it renders as prose.
     */
    const destination = (v: string) => (isHttpUrl(v) ? v : escapeMarkdown(v));
    /**
     * The same field inside the server's own `[label](…)` wrapper. A value that
     * cannot be a destination keeps its label and renders as visible text, so
     * `(not assigned)` reads honestly instead of as a dead link.
     */
    const labeledLink = (label: string, v: string) =>
      isHttpUrl(v) ? `[${label}](${v})` : `${label}: ${escapeMarkdown(v)}`;

    for (const obj of result.objects) {
      lines.push(`## ${escapeMarkdown(obj.title) || '(Untitled)'} — Object ${obj.objectID}`);
      lines.push(
        `**isPublicDomain:** ${obj.isPublicDomain ? 'Yes (CC0)' : 'No'} | **hasCC0Image:** ${obj.hasCC0Image ? 'Yes' : 'No'} | **isHighlight:** ${obj.isHighlight ? 'Yes' : 'No'} | **isTimelineWork:** ${obj.isTimelineWork ? 'Yes' : 'No'}`,
      );
      lines.push(
        `**Artist:** ${prose(obj.artistDisplayName)}${obj.artistDisplayBio ? ` (${escapeMarkdown(obj.artistDisplayBio)})` : ''}`,
      );
      lines.push(`**Nationality:** ${prose(obj.artistNationality)}`);
      lines.push(
        `**Artist dates:** ${obj.artistBeginDate || obj.artistEndDate ? `${prose(obj.artistBeginDate)}–${prose(obj.artistEndDate)}` : '—'}`,
      );
      lines.push(
        `**Department:** ${prose(obj.department)} | **Object name:** ${prose(obj.objectName)} | **Classification:** ${prose(obj.classification)}`,
      );
      // A null range means the Met has no machine-readable date — render the
      // human-readable field alone rather than a fabricated or empty span.
      const dateRange =
        obj.objectBeginDate != null && obj.objectEndDate != null
          ? ` (${obj.objectBeginDate}–${obj.objectEndDate})`
          : '';
      lines.push(`**Date:** ${prose(obj.objectDate)}${dateRange}`);
      lines.push(`**Medium:** ${prose(obj.medium)}`);
      lines.push(`**Dimensions:** ${prose(obj.dimensions)}`);
      lines.push(`**Culture:** ${prose(obj.culture)}`);
      lines.push(`**Period:** ${prose(obj.period)}`);
      lines.push(`**Dynasty:** ${prose(obj.dynasty)}`);
      // Findspot detail joins the existing country/region line, each sub-field
      // omitted when empty — nine dashes on a record with no findspot would bury
      // the two fields that are usually populated.
      const findspot = (
        [
          ['Type', obj.geography.geographyType],
          ['City', obj.geography.city],
          ['State', obj.geography.state],
          ['County', obj.geography.county],
          ['Subregion', obj.geography.subregion],
          ['Locale', obj.geography.locale],
          ['Locus', obj.geography.locus],
          ['Excavation', obj.geography.excavation],
          ['River', obj.geography.river],
        ] as const
      )
        .filter(([, value]) => value)
        .map(([label, value]) => `${label}: ${escapeMarkdown(value)}`)
        .join('; ');
      lines.push(
        `**Geography:** ${orDash([obj.country, obj.region].filter(Boolean).map(escapeMarkdown).join(', '))}${findspot ? ` (${findspot})` : ''}`,
      );
      const measurements = obj.measurements?.length
        ? obj.measurements
            .map((m) => {
              const axes = Object.entries(m.elementMeasurements)
                .map(([axis, value]) => `${escapeMarkdown(axis)} ${value}`)
                .join(', ');
              return `${escapeMarkdown(m.elementName)}${m.elementDescription ? ` (${escapeMarkdown(m.elementDescription)})` : ''}${axes ? `: ${axes}` : ''}`;
            })
            .join('; ')
        : '—';
      lines.push(`**Measurements:** ${measurements}`);
      lines.push(`**Accession:** ${prose(obj.accessionNumber)}`);
      lines.push(`**Credit:** ${prose(obj.creditLine)}`);
      lines.push(`**Gallery:** ${prose(obj.GalleryNumber)}`);
      lines.push(`**URL:** ${orDash(destination(obj.objectURL))}`);
      lines.push(`**Image (full):** ${orDash(destination(obj.primaryImage))}`);
      lines.push(`**Image (small):** ${orDash(destination(obj.primaryImageSmall))}`);
      lines.push(
        `**Additional images${obj.additionalImages.length > 0 ? ` (${obj.additionalImages.length})` : ''}:** ${obj.additionalImages.length > 0 ? obj.additionalImages.map(destination).join(', ') : '—'}`,
      );
      lines.push(`**Wikidata:** ${orDash(destination(obj.objectWikidata_URL))}`);
      lines.push(
        `**Tags:** ${obj.tags?.length ? obj.tags.map((t) => `${escapeMarkdown(t.term)}${t.AAT_URL ? ` ${labeledLink('AAT', t.AAT_URL)}` : ''}${t.Wikidata_URL ? ` ${labeledLink('WD', t.Wikidata_URL)}` : ''}`).join(', ') : '—'}`,
      );
      const constituents = obj.constituents?.length
        ? obj.constituents
            .map(
              (c) =>
                `constituentID:${c.constituentID} ${escapeMarkdown(c.name)} (${escapeMarkdown(c.role)}${c.gender ? `, ${escapeMarkdown(c.gender)}` : ''}${c.constituentWikidata_URL ? `, ${labeledLink('WD', c.constituentWikidata_URL)}` : ''}${c.constituentULAN_URL ? `, ${labeledLink('ULAN', c.constituentULAN_URL)}` : ''})`,
            )
            .join('; ')
        : '—';
      lines.push(`**Constituents:** ${constituents}`);
      lines.push('');
    }

    if (result.failed.length > 0) {
      lines.push('## Failed Fetches');
      for (const f of result.failed) {
        lines.push(`- **${f.objectID}:** ${f.error}`);
      }
    } else {
      lines.push('**Failed fetches:** none');
    }

    // Rendered on field presence: a batch that fit the budget carries no
    // deferred[] and `content[]` gains nothing, matching `structuredContent`.
    // The accompanying re-call guidance rides the enrichment trailer, which the
    // framework mirrors onto both surfaces without a render here.
    if (result.deferred?.length) {
      lines.push('', '## Deferred — batch byte budget');
      for (const d of result.deferred) {
        lines.push(`- **${d.objectID}:** ${d.bytes} bytes`);
      }
    }

    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
