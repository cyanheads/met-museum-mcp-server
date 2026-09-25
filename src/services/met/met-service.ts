/**
 * @fileoverview Met Collection API service — search, object fetch, and departments.
 * @module services/met/met-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { RawDepartmentsResponse, RawObjectRecord, RawSearchResponse } from './types.js';

/**
 * How deep `/v1.1/search` pages. No request reaches past `offset + limit =
 * 10,000` — upstream clips a page that crosses it and answers `objectIDs: null`
 * at or beyond it — while `total` still reports the full match count.
 */
export const SEARCH_RESULT_WINDOW = 10_000;

/** Input for the search method. */
export interface SearchInput {
  dateBegin?: number | undefined;
  dateEnd?: number | undefined;
  departmentId?: number | undefined;
  /** `/v1.1/search` applies only the first repeated value, so callers send one. */
  geoLocation?: string[] | undefined;
  hasImages?: boolean | undefined;
  /** Opt-in only: the search index ignores `isHighlight=false`, so the type admits `true` alone. */
  isHighlight?: true | undefined;
  isOnView?: boolean | undefined;
  limit: number;
  medium?: string | undefined;
  offset?: number | undefined;
  q: string;
}

/** Normalized search result. */
export interface SearchResult {
  /**
   * The next `offset` to pass to continue paging, or `null` when the page reaches
   * the end of the reachable result set (`min(total, SEARCH_RESULT_WINDOW)`).
   */
  nextOffset: number | null;
  objectIDs: number[];
  /**
   * The resolved offset this page was read from (the caller's `offset` after its
   * default of 0). Echoed so a caller can tell an empty page caused by an offset
   * past the reachable result set from a genuine final page.
   */
  offset: number;
  /**
   * Reachable IDs after this page: `min(total, SEARCH_RESULT_WINDOW) - (offset +
   * returned)`, floored at 0.
   */
  remaining: number;
  returned: number;
  /** The full upstream match count, which can exceed what paging reaches. */
  total: number;
  truncated: boolean;
}

/**
 * Resolve `MET_BASE_URL` to the collection root the per-endpoint version paths
 * hang off. A value ending in `/v1` — the shape the variable had when it named
 * the `v1` API directly — is reduced to its root, so an existing override keeps
 * resolving every endpoint where it did. `/v1.1` is reduced the same way: kept,
 * it would put every endpoint under it (`/v1.1/v1/objects/{id}`, a 404 that
 * reads as "object not found").
 */
function toCollectionRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1(?:\.1)?$/, '');
}

/** Normalized object record — subset of the full API record. */
export interface ObjectRecord {
  accessionNumber: string;
  additionalImages: string[];
  artistBeginDate: string;
  artistDisplayBio: string;
  artistDisplayName: string;
  artistEndDate: string;
  artistNationality: string;
  classification: string;
  constituents:
    | {
        constituentID: number;
        role: string;
        name: string;
        constituentULAN_URL: string;
        constituentWikidata_URL: string;
        gender: string;
      }[]
    | null;
  country: string;
  creditLine: string;
  culture: string;
  department: string;
  dimensions: string;
  dynasty: string;
  GalleryNumber: string;
  /**
   * The nine findspot fields the top-level `country`/`region` pair leaves out.
   * Nested rather than flattened so the nine sparse fields read as one block;
   * `country` and `region` stay where they are and are not duplicated here.
   */
  geography: {
    geographyType: string;
    city: string;
    state: string;
    county: string;
    subregion: string;
    locale: string;
    locus: string;
    excavation: string;
    river: string;
  };
  hasCC0Image: boolean;
  isHighlight: boolean;
  isPublicDomain: boolean;
  isTimelineWork: boolean;
  /**
   * Structured element measurements — the numeric counterpart to the formatted
   * `dimensions` string. Null when the Met records none; an element's map is
   * open because which keys it carries varies element to element.
   */
  measurements:
    | {
        elementName: string;
        elementDescription: string;
        elementMeasurements: Record<string, number>;
      }[]
    | null;
  medium: string;
  /** Null when the Met has no machine-readable date for the work. */
  objectBeginDate: number | null;
  objectDate: string;
  /** Null when the Met has no machine-readable date for the work. */
  objectEndDate: number | null;
  objectID: number;
  objectName: string;
  objectURL: string;
  objectWikidata_URL: string;
  period: string;
  primaryImage: string;
  primaryImageSmall: string;
  region: string;
  tags:
    | {
        term: string;
        AAT_URL: string;
        Wikidata_URL: string;
      }[]
    | null;
  title: string;
}

/** Normalized department entry. */
export interface Department {
  departmentId: number;
  displayName: string;
}

/**
 * How long a resolved department-ID set stays cached before a refetch. The Met's
 * department roster is highly stable, so `departmentId` validation reads the cache
 * after the first lookup instead of adding an upstream round-trip to every
 * filtered search.
 */
const DEPARTMENT_IDS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Resolve the machine-readable date range, mapping "unknown" to null.
 *
 * The Met sends `0`/`0` when a work has no machine-readable date. Its date model
 * skips year zero the way historical year numbering requires — object `250240`
 * encodes "1st century BCE" as `-100` to `-1`, not `-100` to `0` — so zero is
 * never a real year and is free to carry the sentinel. Only the `0`/`0` pair is
 * the unknown marker; a single zero bound is left as sent.
 *
 * This is the one numeric field pair that departs from the server's `''`/`0`
 * absence convention, because an unbounded signed year has no safe sentinel.
 */
function resolveDateRange(raw: RawObjectRecord): {
  objectBeginDate: number | null;
  objectEndDate: number | null;
} {
  const objectBeginDate = raw.objectBeginDate ?? null;
  const objectEndDate = raw.objectEndDate ?? null;
  if (objectBeginDate === 0 && objectEndDate === 0) {
    return { objectBeginDate: null, objectEndDate: null };
  }
  return { objectBeginDate, objectEndDate };
}

export class MetService {
  /** The collection root; each endpoint appends its own API version. */
  private readonly collectionRoot: string;
  private readonly timeoutMs: number;
  private validDepartmentIdsCache?: { ids: Set<number>; expiresAt: number };

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.collectionRoot = toCollectionRoot(serverConfig.baseUrl);
    this.timeoutMs = serverConfig.requestTimeoutMs;
  }

  /**
   * Search the Met collection: one `/v1.1/search` request per page, with the
   * caller's `offset` and `limit` passed straight through. `total` is the full
   * upstream match count; the continuation fields (`remaining`, `truncated`,
   * `nextOffset`) are computed against the reachable window,
   * `min(total, SEARCH_RESULT_WINDOW)`, because no page reaches past it.
   *
   * Every failure, a Timeout-coded one included (an upstream 504/408/425 or the
   * request timer), takes the ordinary `withRetry` ladder: a page is at most 500
   * IDs, so a timeout says nothing about the size of the result set.
   */
  search(input: SearchInput, ctx: Context): Promise<SearchResult> {
    const offset = input.offset ?? 0;
    return withRetry(
      async () => {
        const url = this.buildSearchUrl({ ...input, offset });
        ctx.log.debug('Met search request', { url: url.toString() });
        const raw = await this.fetchSearch(url, ctx);
        const objectIDs = raw.objectIDs ?? [];
        const reachable = Math.min(raw.total, SEARCH_RESULT_WINDOW);
        const consumed = offset + objectIDs.length;
        const remaining = Math.max(0, reachable - consumed);
        const truncated = remaining > 0;
        return {
          total: raw.total,
          objectIDs,
          returned: objectIDs.length,
          truncated,
          remaining,
          nextOffset: truncated ? consumed : null,
          offset,
        };
      },
      {
        operation: 'MetService.search',
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * How many objects the keyword matches with no filter applied, or `null` when
   * the request failed. One `limit=1` request, one attempt: the caller uses it to
   * word a recovery hint, so a failure degrades the hint rather than the call, and
   * a retry ladder would only delay an answer that is already a miss. A caller
   * abort is not such a failure — it propagates, so the call ends as cancelled.
   */
  async countKeywordMatches(q: string, ctx: Context): Promise<number | null> {
    const url = this.buildSearchUrl({ q, offset: 0, limit: 1 });
    try {
      return (await this.fetchSearch(url, ctx)).total;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('Met keyword-only count failed', {
        q,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** One `/v1.1/search` round-trip, decoded. */
  private async fetchSearch(url: URL, ctx: Context): Promise<RawSearchResponse> {
    const response = await fetchWithTimeout(url, this.timeoutMs, ctx, { signal: ctx.signal });
    return (await response.json()) as RawSearchResponse;
  }

  /**
   * Fetch a single object by ID. Returns null on 404 (object not found),
   * throws for other HTTP errors.
   */
  getObject(objectID: number, ctx: Context): Promise<ObjectRecord | null> {
    return withRetry(
      async () => {
        const url = `${this.collectionRoot}/v1/objects/${objectID}`;
        ctx.log.debug('Met object fetch', { objectID });
        let response: Response;
        try {
          response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
            expectedStatuses: [404],
            signal: ctx.signal,
          });
        } catch (error) {
          if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) return null;
          throw error;
        }
        const raw = (await response.json()) as RawObjectRecord;
        return this.normalizeObject(raw);
      },
      {
        operation: 'MetService.getObject',
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch all departments. */
  getDepartments(ctx: Context): Promise<Department[]> {
    return withRetry(
      async () => {
        const url = `${this.collectionRoot}/v1/departments`;
        ctx.log.debug('Met departments fetch');
        const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
          signal: ctx.signal,
        });
        const raw = (await response.json()) as RawDepartmentsResponse;
        return raw.departments.map((d) => ({
          departmentId: d.departmentId,
          displayName: d.displayName,
        }));
      },
      {
        operation: 'MetService.getDepartments',
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Valid department IDs as a set, for fast membership checks when validating a
   * `departmentId` search filter. Derived from the live department list and cached
   * with a TTL, so only the first check per window hits the upstream — filtered
   * searches validate near-instantly without a fetch on every call.
   */
  async getValidDepartmentIds(ctx: Context): Promise<Set<number>> {
    const cached = this.validDepartmentIdsCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.ids;
    }
    const departments = await this.getDepartments(ctx);
    const ids = new Set(departments.map((d) => d.departmentId));
    this.validDepartmentIdsCache = { ids, expiresAt: Date.now() + DEPARTMENT_IDS_CACHE_TTL_MS };
    return ids;
  }

  /**
   * `offset` and `limit` are always sent: upstream defaults an absent `limit` to
   * 100, so leaving it off would page by a size the caller never asked for.
   */
  private buildSearchUrl(input: SearchInput & { offset: number }): URL {
    const url = new URL(`${this.collectionRoot}/v1.1/search`);
    url.searchParams.set('q', input.q);
    url.searchParams.set('offset', String(input.offset));
    url.searchParams.set('limit', String(input.limit));
    if (input.hasImages != null) url.searchParams.set('hasImages', String(input.hasImages));
    if (input.isHighlight != null) url.searchParams.set('isHighlight', String(input.isHighlight));
    if (input.isOnView != null) url.searchParams.set('isOnView', String(input.isOnView));
    if (input.medium) url.searchParams.set('medium', input.medium);
    if (input.departmentId != null)
      url.searchParams.set('departmentId', String(input.departmentId));
    if (input.geoLocation?.length) {
      for (const geo of input.geoLocation) {
        url.searchParams.append('geoLocation', geo);
      }
    }
    if (input.dateBegin != null) url.searchParams.set('dateBegin', String(input.dateBegin));
    if (input.dateEnd != null) url.searchParams.set('dateEnd', String(input.dateEnd));
    return url;
  }

  private normalizeObject(raw: RawObjectRecord): ObjectRecord {
    return {
      objectID: raw.objectID,
      title: raw.title ?? '',
      isPublicDomain: raw.isPublicDomain ?? false,
      primaryImage: raw.primaryImage ?? '',
      primaryImageSmall: raw.primaryImageSmall ?? '',
      additionalImages: raw.additionalImages ?? [],
      objectURL: raw.objectURL ?? '',
      department: raw.department ?? '',
      objectName: raw.objectName ?? '',
      classification: raw.classification ?? '',
      hasCC0Image: Boolean(raw.primaryImage),
      isHighlight: raw.isHighlight ?? false,
      isTimelineWork: raw.isTimelineWork ?? false,
      artistDisplayName: raw.artistDisplayName ?? '',
      artistDisplayBio: raw.artistDisplayBio ?? '',
      artistNationality: raw.artistNationality ?? '',
      artistBeginDate: raw.artistBeginDate ?? '',
      artistEndDate: raw.artistEndDate ?? '',
      constituents: raw.constituents ?? null,
      objectDate: raw.objectDate ?? '',
      ...resolveDateRange(raw),
      medium: raw.medium ?? '',
      dimensions: raw.dimensions ?? '',
      culture: raw.culture ?? '',
      period: raw.period ?? '',
      dynasty: raw.dynasty ?? '',
      accessionNumber: raw.accessionNumber ?? '',
      creditLine: raw.creditLine ?? '',
      country: raw.country ?? '',
      region: raw.region ?? '',
      geography: {
        geographyType: raw.geographyType ?? '',
        city: raw.city ?? '',
        state: raw.state ?? '',
        county: raw.county ?? '',
        subregion: raw.subregion ?? '',
        locale: raw.locale ?? '',
        locus: raw.locus ?? '',
        excavation: raw.excavation ?? '',
        river: raw.river ?? '',
      },
      // Per element, like tags below: `elementDescription` is null on the wire for
      // an unqualified element, and the array-level guard never descends into it.
      measurements:
        raw.measurements?.map((element) => ({
          elementName: element.elementName ?? '',
          elementDescription: element.elementDescription ?? '',
          elementMeasurements: element.elementMeasurements ?? {},
        })) ?? null,
      // Per item, not per array: the Met sends a null AAT_URL/Wikidata_URL for a
      // term with no Getty/Wikidata record, and the array-level guard above never
      // descends into it.
      tags:
        raw.tags?.map((tag) => ({
          term: tag.term,
          AAT_URL: tag.AAT_URL ?? '',
          Wikidata_URL: tag.Wikidata_URL ?? '',
        })) ?? null,
      objectWikidata_URL: raw.objectWikidata_URL ?? '',
      GalleryNumber: raw.GalleryNumber ?? '',
    };
  }
}

// --- Init/accessor pattern ---

let _service: MetService | undefined;

export function initMetService(config: AppConfig, storage: StorageService): void {
  _service = new MetService(config, storage);
}

export function getMetService(): MetService {
  if (!_service) {
    throw new Error('MetService not initialized — call initMetService() in setup()');
  }
  return _service;
}
