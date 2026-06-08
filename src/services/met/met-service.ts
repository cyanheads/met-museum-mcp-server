/**
 * @fileoverview Met Collection API service — search, object fetch, and departments.
 * @module services/met/met-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
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
  q: string;
}

/** Normalized search result. */
export interface SearchResult {
  objectIDs: number[];
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

export class MetService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.baseUrl;
    this.timeoutMs = serverConfig.requestTimeoutMs;
  }

  /** Search the Met collection. Returns normalized result with sliced IDs. */
  search(input: SearchInput, ctx: Context): Promise<SearchResult> {
    return withRetry(
      async () => {
        const url = this.buildSearchUrl(input);
        ctx.log.debug('Met search request', { url: url.toString() });
        const response = await fetchWithManualTimeout(url.toString(), this.timeoutMs, ctx.signal);
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Met API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const raw = (await response.json()) as RawSearchResponse;
        const allIds = raw.objectIDs ?? [];
        const sliced = allIds.slice(0, input.limit);
        return {
          total: raw.total,
          objectIDs: sliced,
          returned: sliced.length,
          truncated: allIds.length > sliced.length || raw.total > allIds.length,
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
