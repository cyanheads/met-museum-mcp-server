/**
 * @fileoverview Tool: met_get_object — fetch full records for one or more Met object IDs.
 * @module mcp-server/tools/definitions/met-get-object
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getMetService } from '@/services/met/met-service.js';

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
      .describe(
        'Earliest date as an integer year (negative = BCE). Use for date range comparisons.',
      ),
    objectEndDate: z.number().int().describe('Latest date as an integer year (negative = BCE).'),
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

export const metGetObject = tool('met_get_object', {
  title: 'Get Met Objects',
  description:
    'Fetch full records for one or more Met Museum object IDs. Accepts up to 20 IDs per call, fetches in parallel (concurrency-limited), and returns partial-success — a single 404 does not fail the whole batch. ' +
    'Object IDs come from met_search_collections. Non-public-domain objects return empty image URLs. ' +
    'The constituents array is null for anonymous or unattributed works; tags is null for untagged objects.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    objectIDs: z
      .array(z.number().int().positive().describe('A Met object ID from met_search_collections.'))
      .min(1)
      .max(20)
      .describe(
        'One or more Met object IDs to fetch. Maximum 20 per call. IDs come from met_search_collections. ' +
          'Fetches run in parallel (concurrency-limited); partial failures are reported per ID rather than failing the whole batch.',
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
  }),
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

    ctx.log.info('Met batch object fetch', { count: input.objectIDs.length });

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
    const results = new Array<SuccessItem | FailItem>(input.objectIDs.length);
    let nextIndex = 0;

    const processNext = async (): Promise<void> => {
      while (nextIndex < input.objectIDs.length) {
        const index = nextIndex++;
        const objectID = input.objectIDs[index];
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
    const workers = Array.from({ length: Math.min(batchConcurrency, input.objectIDs.length) }, () =>
      processNext(),
    );
    await Promise.all(workers);

    const objects = results.filter((r): r is SuccessItem => r.ok).map((r) => r.record);
    const failItems = results.filter((r): r is FailItem => !r.ok);
    const failed = failItems.map((r) => ({ objectID: r.objectID, error: r.error }));

    if (objects.length === 0) {
      const allNotFound = failItems.every((f) => f.kind === 'not_found');
      if (allNotFound) {
        throw ctx.fail(
          'all_not_found',
          `All ${input.objectIDs.length} requested object ${input.objectIDs.length === 1 ? 'ID' : 'IDs'} not found.`,
          ctx.recoveryFor('all_not_found'),
        );
      }
      throw ctx.fail(
        'all_failed',
        `All ${input.objectIDs.length} object fetches failed.`,
        ctx.recoveryFor('all_failed'),
      );
    }

    ctx.log.info('Met batch complete', { succeeded: objects.length, failed: failed.length });
    return { objects, failed };
  },

  format: (result) => {
    const lines: string[] = [];

    for (const obj of result.objects) {
      lines.push(`## ${obj.title || '(Untitled)'} — Object ${obj.objectID}`);
      lines.push(
        `**isPublicDomain:** ${obj.isPublicDomain ? 'Yes (CC0)' : 'No'} | **hasCC0Image:** ${obj.hasCC0Image ? 'Yes' : 'No'} | **isHighlight:** ${obj.isHighlight ? 'Yes' : 'No'} | **isTimelineWork:** ${obj.isTimelineWork ? 'Yes' : 'No'}`,
      );
      if (obj.artistDisplayName) {
        lines.push(
          `**Artist:** ${obj.artistDisplayName}${obj.artistDisplayBio ? ` (${obj.artistDisplayBio})` : ''}`,
        );
      }
      if (obj.artistNationality) lines.push(`**Nationality:** ${obj.artistNationality}`);
      if (obj.artistBeginDate || obj.artistEndDate) {
        lines.push(`**Artist dates:** ${obj.artistBeginDate}–${obj.artistEndDate}`);
      }
      lines.push(
        `**Department:** ${obj.department} | **Object name:** ${obj.objectName} | **Classification:** ${obj.classification}`,
      );
      lines.push(`**Date:** ${obj.objectDate} (${obj.objectBeginDate}–${obj.objectEndDate})`);
      if (obj.medium) lines.push(`**Medium:** ${obj.medium}`);
      if (obj.dimensions) lines.push(`**Dimensions:** ${obj.dimensions}`);
      if (obj.culture) lines.push(`**Culture:** ${obj.culture}`);
      if (obj.period) lines.push(`**Period:** ${obj.period}`);
      if (obj.dynasty) lines.push(`**Dynasty:** ${obj.dynasty}`);
      if (obj.country || obj.region) {
        lines.push(`**Geography:** ${[obj.country, obj.region].filter(Boolean).join(', ')}`);
      }
      lines.push(`**Accession:** ${obj.accessionNumber}`);
      if (obj.creditLine) lines.push(`**Credit:** ${obj.creditLine}`);
      if (obj.GalleryNumber) lines.push(`**Gallery:** ${obj.GalleryNumber}`);
      if (obj.objectURL) lines.push(`**URL:** ${obj.objectURL}`);
      if (obj.primaryImage) lines.push(`**Image (full):** ${obj.primaryImage}`);
      if (obj.primaryImageSmall) lines.push(`**Image (small):** ${obj.primaryImageSmall}`);
      if (obj.additionalImages.length > 0) {
        lines.push(
          `**Additional images (${obj.additionalImages.length}):** ${obj.additionalImages.join(', ')}`,
        );
      }
      if (obj.objectWikidata_URL) lines.push(`**Wikidata:** ${obj.objectWikidata_URL}`);
      if (obj.tags?.length) {
        lines.push(
          `**Tags:** ${obj.tags.map((t) => `${t.term}${t.AAT_URL ? ` [AAT](${t.AAT_URL})` : ''}${t.Wikidata_URL ? ` [WD](${t.Wikidata_URL})` : ''}`).join(', ')}`,
        );
      }
      if (obj.constituents?.length) {
        const parts = obj.constituents.map(
          (c) =>
            `constituentID:${c.constituentID} ${c.name} (${c.role}${c.gender ? `, ${c.gender}` : ''}${c.constituentWikidata_URL ? `, [WD](${c.constituentWikidata_URL})` : ''}${c.constituentULAN_URL ? `, [ULAN](${c.constituentULAN_URL})` : ''})`,
        );
        lines.push(`**Constituents:** ${parts.join('; ')}`);
      }
      lines.push('');
    }

    if (result.failed.length > 0) {
      lines.push('## Failed Fetches');
      for (const f of result.failed) {
        lines.push(`- **${f.objectID}:** ${f.error}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
