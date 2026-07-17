/**
 * @fileoverview Met Collection API service — search, object fetch, and departments.
 * @module services/met/met-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { RawDepartmentsResponse, RawObjectRecord, RawSearchResponse } from './types.js';

/** Input for the search method. */
export interface SearchInput {
  dateBegin?: number | undefined;
  dateEnd?: number | undefined;
  departmentId?: number | undefined;
  geoLocation?: string[] | undefined;
  hasImages?: boolean | undefined;
  isHighlight?: boolean | undefined;
  isOnView?: boolean | undefined;
  isPublicDomain?: boolean | undefined;
  limit: number;
  medium?: string | undefined;
  offset?: number | undefined;
  q: string;
}

/** Normalized search result. */
export interface SearchResult {
  /** The next `offset` to pass to continue paging, or `null` when the result set is exhausted. */
  nextOffset: number | null;
  objectIDs: number[];
  /** Matching IDs after this page (`total - (offset + returned)`), floored at 0. */
  remaining: number;
  returned: number;
  total: number;
  truncated: boolean;
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
  hasCC0Image: boolean;
  isHighlight: boolean;
  isPublicDomain: boolean;
  isTimelineWork: boolean;
  medium: string;
  objectBeginDate: number;
  objectDate: string;
  objectEndDate: number;
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

/** Cast handler Context to the RequestContext shape expected by utils. */
function asRequestContext(ctx: Context): RequestContext {
  return ctx as unknown as RequestContext;
}

/** Simple fetch with an AbortSignal-based timeout. */
async function fetchWithManualTimeout(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Chain outer signal
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * True when a thrown value is a fetch abort (deadline or cancellation). Matched by
 * `name` rather than instanceof to tolerate the DOMException/Error variance across
 * runtimes (Node, Bun, workerd).
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * How long a resolved department-ID set stays cached before a refetch. The Met's
 * department roster is highly stable, so `departmentId` validation reads the cache
 * after the first lookup instead of adding an upstream round-trip to every
 * filtered search.
 */
const DEPARTMENT_IDS_CACHE_TTL_MS = 60 * 60 * 1000;

export class MetService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private validDepartmentIdsCache?: { ids: Set<number>; expiresAt: number };

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.baseUrl;
    this.timeoutMs = serverConfig.requestTimeoutMs;
  }

  /**
   * Search the Met collection. Returns a normalized result: an offset-sliced page
   * of IDs plus continuation metadata (`nextOffset`, `remaining`).
   *
   * The upstream `/search` returns the complete ID array in one response, so paging
   * is a local slice — no extra upstream capability needed. A broad, unfiltered
   * query can deterministically exceed the request timeout while that array
   * downloads; because the same query times out identically on every attempt, the
   * timeout is surfaced as a non-retryable `search_timeout` (fail-fast) instead of
   * being retried through the full timeout three more times.
   */
  search(input: SearchInput, ctx: Context): Promise<SearchResult> {
    const offset = input.offset ?? 0;
    return withRetry(
      async () => {
        const url = this.buildSearchUrl(input);
        ctx.log.debug('Met search request', { url: url.toString() });
        let response: Response;
        try {
          response = await fetchWithManualTimeout(url.toString(), this.timeoutMs, ctx.signal);
        } catch (error) {
          // Our own deadline fired (the timer aborted the request) while the caller's
          // signal is still live — a deterministic oversized-response timeout. Fail fast
          // with `retryable: false` so withRetry does not burn the full timeout three more
          // times, and carry the narrow-the-query recovery hint. A caller cancellation
          // (ctx.signal aborted) is not ours to reclassify — let it bubble unchanged.
          if (!ctx.signal.aborted && isAbortError(error)) {
            throw timeout(
              `Met search for "${input.q}" exceeded the ${this.timeoutMs}ms request timeout — the result set is too large to download in time.`,
              { reason: 'search_timeout', retryable: false, ...ctx.recoveryFor('search_timeout') },
              { cause: error },
            );
          }
          throw error;
        }
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Met API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const raw = (await response.json()) as RawSearchResponse;
        const allIds = raw.objectIDs ?? [];
        const sliced = allIds.slice(offset, offset + input.limit);
        const consumed = offset + sliced.length;
        const remaining = Math.max(0, raw.total - consumed);
        const truncated = remaining > 0;
        return {
          total: raw.total,
          objectIDs: sliced,
          returned: sliced.length,
          truncated,
          remaining,
          nextOffset: truncated ? consumed : null,
        };
      },
      {
        operation: 'MetService.search',
        context: asRequestContext(ctx),
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch a single object by ID. Returns null on 404 (object not found),
   * throws for other HTTP errors.
   */
  getObject(objectID: number, ctx: Context): Promise<ObjectRecord | null> {
    return withRetry(
      async () => {
        const url = `${this.baseUrl}/objects/${objectID}`;
        ctx.log.debug('Met object fetch', { objectID });
        const response = await fetchWithManualTimeout(url, this.timeoutMs, ctx.signal);
        if (response.status === 404) return null;
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Met API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const raw = (await response.json()) as RawObjectRecord;
        return this.normalizeObject(raw);
      },
      {
        operation: 'MetService.getObject',
        context: asRequestContext(ctx),
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch all departments. */
  getDepartments(ctx: Context): Promise<Department[]> {
    return withRetry(
      async () => {
        const url = `${this.baseUrl}/departments`;
        ctx.log.debug('Met departments fetch');
        const response = await fetchWithManualTimeout(url, this.timeoutMs, ctx.signal);
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Met API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const raw = (await response.json()) as RawDepartmentsResponse;
        return raw.departments.map((d) => ({
          departmentId: d.departmentId,
          displayName: d.displayName,
        }));
      },
      {
        operation: 'MetService.getDepartments',
        context: asRequestContext(ctx),
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

  private buildSearchUrl(input: SearchInput): URL {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('q', input.q);
    if (input.hasImages != null) url.searchParams.set('hasImages', String(input.hasImages));
    if (input.isPublicDomain != null)
      url.searchParams.set('isPublicDomain', String(input.isPublicDomain));
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
      objectBeginDate: raw.objectBeginDate ?? 0,
      objectEndDate: raw.objectEndDate ?? 0,
      medium: raw.medium ?? '',
      dimensions: raw.dimensions ?? '',
      culture: raw.culture ?? '',
      period: raw.period ?? '',
      dynasty: raw.dynasty ?? '',
      accessionNumber: raw.accessionNumber ?? '',
      creditLine: raw.creditLine ?? '',
      country: raw.country ?? '',
      region: raw.region ?? '',
      tags: raw.tags ?? null,
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
