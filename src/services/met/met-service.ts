/**
 * @fileoverview Met Collection API service — search, object ID lists, object fetch, and departments.
 * @module services/met/met-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  type FetchWithTimeoutOptions,
  fetchWithTimeout,
  type RetryAttempt,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { decodeHtmlEntities } from '@/utils/html-entities.js';
import type {
  RawDepartmentsResponse,
  RawObjectRecord,
  RawObjectsResponse,
  RawSearchResponse,
} from './types.js';

/**
 * How deep `/v1.1/search` pages. No request reaches past `offset + limit =
 * 10,000` — upstream clips a page that crosses it and answers `objectIDs: null`
 * at or beyond it — while `total` still reports the full match count.
 */
export const SEARCH_RESULT_WINDOW = 10_000;

/**
 * One tool call's wall-clock budget (`MET_CALL_DEADLINE_MS`), shared by every
 * Met API request the call makes. Fixed once per call rather than per ladder: a
 * per-ladder budget stacks, and `met_get_object` runs its ladders in waves.
 */
export interface CallDeadline {
  /** Epoch milliseconds at which the call's budget runs out. */
  deadlineAt: number;
  /** Aborts every request the call makes — the caller's cancellation. */
  signal: AbortSignal;
}

/** Start a tool call's budget now; `signal` cancels every request made under it. */
export function startCallDeadline(signal: AbortSignal): CallDeadline {
  return { deadlineAt: Date.now() + getServerConfig().callDeadlineMs, signal };
}

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

/** Input for the listObjects method. */
export interface ListObjectsInput {
  departmentId?: number | undefined;
  limit: number;
  offset?: number | undefined;
  /**
   * `YYYY-MM-DD`, sent as `metadataDate`: records created or revised on or after
   * that day, the day itself included.
   */
  updatedSince?: string | undefined;
}

/** The filters that select one `/v1/objects` ID list — and key its cache entry. */
type ObjectListFilters = Pick<ListObjectsInput, 'departmentId' | 'updatedSince'>;

/** One page of a sorted `/v1/objects` ID list. */
export interface ListObjectsResult {
  /** The next `offset` to pass to continue paging, or `null` when this page ends the list. */
  nextOffset: number | null;
  /** This page's IDs, ascending. */
  objectIDs: number[];
  /** The resolved offset this page was read from (the caller's `offset` after its default of 0). */
  offset: number;
  /** IDs after this page: `total - (offset + returned)`, floored at 0. */
  remaining: number;
  returned: number;
  /** Every ID the filters match. Paging reaches all of them — there is no window. */
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
 * How long a sorted `/v1/objects` ID list stays cached. `/v1/objects` answers
 * every matching ID in one response — 3.4 MB of JSON for the whole collection —
 * so each page is sliced from a cached copy instead of refetching the list.
 */
const OBJECT_IDS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Ceiling on the bytes the cached ID lists retain together, measured as each
 * list's `Int32Array.byteLength`. The whole collection is about 2 MB, so the
 * bound holds several filter sets at once.
 */
export const OBJECT_IDS_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * One caller's wait on a load other callers may share. Settles with the load, or
 * rejects when this caller's signal aborts (with its reason, as `fetch` does) or
 * its call deadline passes (as the same `retry_deadline_exceeded` expiry a retry
 * ladder raises) — leaving the load, and everyone else waiting on it, untouched.
 */
function waitForShared<T>(load: Promise<T>, deadline: CallDeadline): Promise<T> {
  const { signal } = deadline;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            timeout(
              "This call's time budget ran out while waiting for the Met API's object ID list.",
              { reason: 'retry_deadline_exceeded' },
            ),
          ),
        ),
      Math.max(0, deadline.deadlineAt - Date.now()),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    load.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

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

/**
 * Resolve `artistEndDate`, mapping a placeholder year to the field's empty value.
 *
 * The Met writes `9999` for a maker still living or active (object `20121`,
 * Tiffany & Co., "1837–present") and occasionally another future year (object
 * `79199`, Gucci, `2112`). No death or closing year lies in the future, so any
 * bare integer later than the current UTC year is a placeholder, whatever its
 * digits. A year up to the current one and a full date (`2005-08-01`) pass
 * through as sent.
 */
function resolveArtistEndDate(artistEndDate: string): string {
  const isFutureYear =
    /^\d+$/.test(artistEndDate) && Number(artistEndDate) > new Date().getUTCFullYear();
  return isFutureYear ? '' : artistEndDate;
}

/** The exact `<i>` and `</i>` tokens, in either case — no attributes, no whitespace. */
const ITALIC_TAG = /<\/?i>/gi;

/**
 * Remove the raw `<i>`/`</i>` tokens the Met uses to mark foreign terms in
 * free-text fields (object `21814`: `Sword guard (<i>Tsuba</i>) …`).
 *
 * Presentation cleanup, not sanitization: both surfaces are plain text and
 * Markdown, never HTML, so the tags could only show as literal characters. Any
 * other `<` text stays literal and is escaped at the `content[]` render
 * boundary, and a value with no token comes back unchanged.
 */
function stripItalicTags(value: string): string {
  return value.replace(ITALIC_TAG, '');
}

export class MetService {
  /** The collection root; each endpoint appends its own API version. */
  private readonly collectionRoot: string;
  private readonly timeoutMs: number;
  private validDepartmentIdsCache?: { ids: Set<number>; expiresAt: number };
  /**
   * Sorted `/v1/objects` ID lists by filter set, in least- to most-recently-used
   * order: a hit is re-inserted at the end, so eviction takes from the front.
   */
  private readonly objectIdCache = new Map<string, { ids: Int32Array; expiresAt: number }>();
  /** Sum of `byteLength` over `objectIdCache`, held at or under `OBJECT_IDS_CACHE_MAX_BYTES`. */
  private objectIdCacheBytes = 0;
  /** The load in flight per filter set, shared by every caller that asks for it meanwhile. */
  private readonly objectIdLoads = new Map<string, Promise<Int32Array>>();

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
  search(input: SearchInput, ctx: Context, deadline: CallDeadline): Promise<SearchResult> {
    const offset = input.offset ?? 0;
    return this.retry('MetService.search', ctx, deadline, async (attempt) => {
      const url = this.buildSearchUrl({ ...input, offset });
      ctx.log.debug('Met search request', { url: url.toString() });
      const raw = await this.fetchSearch(url, ctx, attempt);
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
    });
  }

  /**
   * One page of every object ID `/v1/objects` holds for the filters, ascending.
   * The upstream answers the whole ID set in one response, in a different order
   * on every call, so the list is sorted once and each page is sliced from it —
   * which gives a stable order across pages and no paging depth limit.
   */
  async listObjects(
    input: ListObjectsInput,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<ListObjectsResult> {
    const offset = input.offset ?? 0;
    const ids = await this.getSortedObjectIds(input, ctx, deadline);
    const objectIDs = Array.from(ids.subarray(offset, offset + input.limit));
    const consumed = offset + objectIDs.length;
    const remaining = Math.max(0, ids.length - consumed);
    const truncated = remaining > 0;
    return {
      total: ids.length,
      objectIDs,
      returned: objectIDs.length,
      offset,
      remaining,
      truncated,
      nextOffset: truncated ? consumed : null,
    };
  }

  /**
   * The sorted ID list for one filter set: the cached copy while it is fresh,
   * else the load already in flight for it, else a new load. This caller waits
   * on a load only as long as its own signal and deadline allow; the load itself
   * belongs to no caller (see `loadSortedObjectIds`).
   *
   * A caller already aborted starts no load: `waitForShared` would not attach
   * it to one, so a load it started would run with no one waiting and could
   * reject unobserved. Every load therefore has its starter attached.
   */
  private async getSortedObjectIds(
    filters: ObjectListFilters,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<Int32Array> {
    // The cache and in-flight key; an unset filter serializes as `null`.
    const key = JSON.stringify([filters.departmentId, filters.updatedSince]);
    const cached = this.objectIdCache.get(key);
    if (cached) {
      this.objectIdCache.delete(key);
      if (cached.expiresAt > Date.now()) {
        this.objectIdCache.set(key, cached);
        return cached.ids;
      }
      this.objectIdCacheBytes -= cached.ids.byteLength;
    }
    let load = this.objectIdLoads.get(key);
    if (!load) {
      deadline.signal.throwIfAborted();
      load = this.loadSortedObjectIds(filters, ctx)
        .then((ids) => {
          this.cacheObjectIds(key, ids);
          return ids;
        })
        .finally(() => this.objectIdLoads.delete(key));
      this.objectIdLoads.set(key, load);
    }
    return await waitForShared(load, deadline);
  }

  /**
   * One `/v1/objects` request, sorted ascending into an `Int32Array` (Met object
   * IDs are positive and far below 2^31). Concurrent callers share the load, so
   * it runs under its own call deadline and a signal no caller owns: one caller
   * cancelling, or running out of budget, never fails it for the rest. `ctx`
   * — the caller that started it — lends only its log bindings.
   */
  private loadSortedObjectIds(filters: ObjectListFilters, ctx: Context): Promise<Int32Array> {
    const ownDeadline = startCallDeadline(new AbortController().signal);
    return this.retry('MetService.listObjects', ctx, ownDeadline, async (attempt) => {
      const url = this.buildObjectsUrl(filters);
      ctx.log.debug('Met object list request', { url: url.toString() });
      const response = await this.request(url, ctx, attempt);
      const raw = (await response.json()) as RawObjectsResponse;
      return Int32Array.from(raw.objectIDs ?? []).sort();
    });
  }

  /**
   * Retain a loaded list, first evicting least-recently-used lists until the
   * retained total fits `OBJECT_IDS_CACHE_MAX_BYTES`. A list larger than the
   * whole bound reaches its callers but is not retained.
   */
  private cacheObjectIds(key: string, ids: Int32Array): void {
    if (ids.byteLength > OBJECT_IDS_CACHE_MAX_BYTES) return;
    for (const [lruKey, entry] of this.objectIdCache) {
      if (this.objectIdCacheBytes + ids.byteLength <= OBJECT_IDS_CACHE_MAX_BYTES) break;
      this.objectIdCache.delete(lruKey);
      this.objectIdCacheBytes -= entry.ids.byteLength;
    }
    this.objectIdCache.set(key, { ids, expiresAt: Date.now() + OBJECT_IDS_CACHE_TTL_MS });
    this.objectIdCacheBytes += ids.byteLength;
  }

  /**
   * How many objects the keyword matches with no filter applied, or `null` when
   * the request failed or the call's budget is already spent. One `limit=1`
   * request, one attempt, its timeout capped by the budget left: the caller uses
   * it to word a recovery hint, so a failure degrades the hint rather than the
   * call, and a retry ladder would only delay an answer that is already a miss. A
   * caller abort is not such a failure — it propagates, so the call ends as
   * cancelled.
   */
  async countKeywordMatches(
    q: string,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<number | null> {
    const remainingMs = deadline.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      ctx.log.warning('Met keyword-only count skipped: the call deadline has passed', { q });
      return null;
    }
    const url = this.buildSearchUrl({ q, offset: 0, limit: 1 });
    try {
      return (await this.fetchSearch(url, ctx, { signal: deadline.signal, remainingMs })).total;
    } catch (error) {
      if (deadline.signal.aborted) throw error;
      ctx.log.warning('Met keyword-only count failed', {
        q,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** One `/v1.1/search` round-trip, decoded. */
  private async fetchSearch(
    url: URL,
    ctx: Context,
    attempt: RetryAttempt,
  ): Promise<RawSearchResponse> {
    const response = await this.request(url, ctx, attempt);
    return (await response.json()) as RawSearchResponse;
  }

  /**
   * Fetch a single object by ID. Returns null on 404 (object not found),
   * throws for other HTTP errors.
   */
  getObject(objectID: number, ctx: Context, deadline: CallDeadline): Promise<ObjectRecord | null> {
    return this.retry('MetService.getObject', ctx, deadline, async (attempt) => {
      const url = `${this.collectionRoot}/v1/objects/${objectID}`;
      ctx.log.debug('Met object fetch', { objectID });
      let response: Response;
      try {
        response = await this.request(url, ctx, attempt, { expectedStatuses: [404] });
      } catch (error) {
        if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) return null;
        throw error;
      }
      const raw = (await response.json()) as RawObjectRecord;
      return this.normalizeObject(raw);
    });
  }

  /** Fetch all departments. */
  getDepartments(ctx: Context, deadline: CallDeadline): Promise<Department[]> {
    return this.retry('MetService.getDepartments', ctx, deadline, async (attempt) => {
      const url = `${this.collectionRoot}/v1/departments`;
      ctx.log.debug('Met departments fetch');
      const response = await this.request(url, ctx, attempt);
      const raw = (await response.json()) as RawDepartmentsResponse;
      return raw.departments.map((d) => ({
        departmentId: d.departmentId,
        displayName: d.displayName,
      }));
    });
  }

  /**
   * Valid department IDs as a set, for fast membership checks when validating a
   * `departmentId` search filter. Derived from the live department list and cached
   * with a TTL, so only the first check per window hits the upstream — filtered
   * searches validate near-instantly without a fetch on every call.
   */
  async getValidDepartmentIds(ctx: Context, deadline: CallDeadline): Promise<Set<number>> {
    const cached = this.validDepartmentIdsCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.ids;
    }
    const departments = await this.getDepartments(ctx, deadline);
    const ids = new Set(departments.map((d) => d.departmentId));
    this.validDepartmentIdsCache = { ids, expiresAt: Date.now() + DEPARTMENT_IDS_CACHE_TTL_MS };
    return ids;
  }

  /**
   * `withRetry` bounded by what is left of the call's budget. A ladder that
   * starts with none left fails as the same `retry_deadline_exceeded` expiry
   * `withRetry` raises, without sending a request.
   */
  private async retry<T>(
    operation: string,
    ctx: Context,
    deadline: CallDeadline,
    fn: (attempt: RetryAttempt) => Promise<T>,
  ): Promise<T> {
    const deadlineMs = deadline.deadlineAt - Date.now();
    if (deadlineMs <= 0) {
      throw timeout(
        "The Met API request was not sent: this call's time budget had already run out.",
        { reason: 'retry_deadline_exceeded', retryAttempts: 0 },
      );
    }
    return await withRetry(fn, {
      operation,
      context: ctx,
      baseDelayMs: 1000,
      deadlineMs,
      signal: deadline.signal,
    });
  }

  /**
   * One Met API request, its timeout capped by the budget left and aborted by
   * the attempt's signal. The API takes no credentials, so a 403 is its firewall
   * refusing this server's address — for every endpoint, for minutes at a time —
   * and is classified as `upstream_blocked` with the block page kept out of the
   * error. Non-retryable: an immediate retry cannot succeed and adds traffic.
   */
  private async request(
    url: string | URL,
    ctx: Context,
    { signal, remainingMs }: RetryAttempt,
    options?: Omit<FetchWithTimeoutOptions, 'signal'>,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, Math.min(this.timeoutMs, remainingMs), ctx, {
        ...options,
        signal,
      });
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === JsonRpcErrorCode.Forbidden &&
        error.data?.status === 403
      ) {
        throw serviceUnavailable(
          "The Met API's firewall is refusing requests from this server (HTTP 403).",
          { reason: 'upstream_blocked', retryable: false },
          { cause: error },
        );
      }
      throw error;
    }
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

  /**
   * `/v1/objects` carrying only the filters the caller set: `departmentIds` takes
   * the one department, `metadataDate` the `YYYY-MM-DD` date as given. With
   * neither, upstream answers every public object ID.
   */
  private buildObjectsUrl({ departmentId, updatedSince }: ObjectListFilters): URL {
    const url = new URL(`${this.collectionRoot}/v1/objects`);
    if (departmentId != null) url.searchParams.set('departmentIds', String(departmentId));
    if (updatedSince != null) url.searchParams.set('metadataDate', updatedSince);
    return url;
  }

  /**
   * Every free-text field passes through `stripItalicTags`; URL-shaped fields,
   * identifiers, and the artist date bounds do not.
   */
  private normalizeObject(raw: RawObjectRecord): ObjectRecord {
    /** A free-text field that may be absent: `''` when it is, cleaned when it is not. */
    const text = (value: string | null | undefined) => stripItalicTags(value ?? '');
    return {
      objectID: raw.objectID,
      title: text(raw.title),
      isPublicDomain: raw.isPublicDomain ?? false,
      primaryImage: raw.primaryImage ?? '',
      primaryImageSmall: raw.primaryImageSmall ?? '',
      additionalImages: raw.additionalImages ?? [],
      objectURL: raw.objectURL ?? '',
      department: text(raw.department),
      objectName: text(raw.objectName),
      classification: text(raw.classification),
      hasCC0Image: Boolean(raw.primaryImage),
      isHighlight: raw.isHighlight ?? false,
      isTimelineWork: raw.isTimelineWork ?? false,
      artistDisplayName: text(raw.artistDisplayName),
      artistDisplayBio: text(raw.artistDisplayBio),
      artistNationality: text(raw.artistNationality),
      artistBeginDate: raw.artistBeginDate ?? '',
      artistEndDate: resolveArtistEndDate(raw.artistEndDate ?? ''),
      // Per item: `name` alone arrives entity-encoded, markup included — the
      // `<i>` pair other fields carry raw reaches it as `&lt;i&gt;`. The decode
      // runs first to expose that pair, then the italic strip removes it.
      constituents:
        raw.constituents?.map((constituent) => ({
          ...constituent,
          role: stripItalicTags(constituent.role),
          name: stripItalicTags(decodeHtmlEntities(constituent.name)),
          gender: stripItalicTags(constituent.gender),
        })) ?? null,
      objectDate: text(raw.objectDate),
      ...resolveDateRange(raw),
      medium: text(raw.medium),
      dimensions: text(raw.dimensions),
      culture: text(raw.culture),
      period: text(raw.period),
      dynasty: text(raw.dynasty),
      accessionNumber: raw.accessionNumber ?? '',
      creditLine: text(raw.creditLine),
      country: text(raw.country),
      region: text(raw.region),
      geography: {
        geographyType: text(raw.geographyType),
        city: text(raw.city),
        state: text(raw.state),
        county: text(raw.county),
        subregion: text(raw.subregion),
        locale: text(raw.locale),
        locus: text(raw.locus),
        excavation: text(raw.excavation),
        river: text(raw.river),
      },
      // Per element, like tags below: `elementDescription` is null on the wire for
      // an unqualified element, and the array-level guard never descends into it.
      measurements:
        raw.measurements?.map((element) => ({
          elementName: text(element.elementName),
          elementDescription: text(element.elementDescription),
          elementMeasurements: element.elementMeasurements ?? {},
        })) ?? null,
      // Per item, not per array: the Met sends a null AAT_URL/Wikidata_URL for a
      // term with no Getty/Wikidata record, and the array-level guard above never
      // descends into it.
      tags:
        raw.tags?.map((tag) => ({
          term: stripItalicTags(tag.term),
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
