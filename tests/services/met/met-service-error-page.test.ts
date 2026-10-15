/**
 * @fileoverview No HTTP failure leaving `MetService` carries the upstream page
 * (#45). `fetchWithTimeout` attaches the response page to every non-2xx error as
 * `data.body` and `data.responseBody`; a 403 (`upstream_blocked`), an exhausted
 * 500/502/503/504 (`upstream_unavailable`), and a 429-ended ladder
 * (`upstream_rate_limited`) leave it behind, and this pins every other status to
 * the same rule — code, message, retry count, and the rest of `data` unchanged.
 * Runs the real service — `fetchWithTimeout`'s
 * status mapping, the retry ladder, its backoff, and `Retry-After` handling
 * included — over a faked global fetch and fake timers.
 * @module tests/services/met/met-service-error-page.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metGetObject } from '@/mcp-server/tools/definitions/met-get-object.tool.js';
import { metListDepartments } from '@/mcp-server/tools/definitions/met-list-departments.tool.js';
import { metListObjects } from '@/mcp-server/tools/definitions/met-list-objects.tool.js';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';
import { getMetService, initMetService } from '@/services/met/met-service.js';

/** How `fetchWithTimeout` names the departments URL in a message: by origin, path elided. */
const DEPARTMENTS_URL = 'https://collectionapi.metmuseum.org/…';

/** Text that appears only in the upstream error page, never in an envelope. */
const PAGE_MARKER = 'UPSTREAM-ERROR-PAGE';

/** An error page exchange with the given status, minted per attempt. */
const errorPage =
  (status: number, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(
      new Response(
        `<!DOCTYPE html><html><body><h1>Error</h1><p>Reference #${PAGE_MARKER}-${status}</p></body></html>`,
        {
          status,
          statusText: 'Upstream Error',
          headers: { 'content-type': 'text/html', ...headers },
        },
      ),
    );

/**
 * Each unclassified status the issue names, with the code `fetchWithTimeout`
 * maps it to and the attempts the ladder spends on it: 501 is permanent and 400
 * is not transient, so each sends one request; 505 is transient and runs the
 * full four-attempt ladder. A 429 runs the same ladder and is classified as
 * `upstream_rate_limited` (#49), pinned on its own below.
 */
const STATUSES = [
  { status: 501, code: JsonRpcErrorCode.ServiceUnavailable, attempts: 1 },
  { status: 505, code: JsonRpcErrorCode.ServiceUnavailable, attempts: 4 },
  { status: 400, code: JsonRpcErrorCode.InvalidParams, attempts: 1 },
] as const;

/** The message `fetchWithTimeout` writes, with the ladder's suffix when it ran out. */
const fetchFailedMessage = (url: string, status: number, attempts: number) =>
  `Fetch failed for ${url}. Status: ${status}${attempts > 1 ? ` (failed after ${attempts} attempts)` : ''}`;

/** The message an exhausted 429 ladder carries when the Met named no wait. */
const RATE_LIMITED_MESSAGE = 'The Met API is rate-limiting requests from this server (HTTP 429).';

/** A plain-deadline call bound for service-level cases. */
function call(ctx = createMockContext()) {
  return [ctx, { deadlineAt: Date.now() + 30_000, signal: ctx.signal }] as const;
}

/** Run `start` to completion under fake timers. */
async function settle<T>(start: () => Promise<T>): Promise<T> {
  const pending = start();
  await vi.runAllTimersAsync();
  return await pending;
}

type ServiceError = {
  cause?: { data?: Record<string, unknown> };
  code: number;
  data: Record<string, unknown>;
  message: string;
};

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

interface ErrorEnvelope {
  code: number;
  data: Record<string, unknown>;
  message: string;
}

function errorOf(result: ToolResult): ErrorEnvelope {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

/** Every text block of a tool result's `content[]`, joined. */
function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** No `body` or `responseBody` key, and no page text in `data` or the message. */
function expectPageFree(error: { data?: Record<string, unknown>; message: string }) {
  expect(error.data).not.toHaveProperty('body');
  expect(error.data).not.toHaveProperty('responseBody');
  expect(JSON.stringify(error.data)).not.toContain(PAGE_MARKER);
  expect(error.message).not.toContain(PAGE_MARKER);
}

describe('no HTTP failure leaving MetService carries the upstream page (#45)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initMetService({} as AppConfig, createInMemoryStorage());
    fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('MetService', () => {
    it.each(STATUSES)(
      'HTTP $status: same code, message, and attempts, with the status and no page',
      async ({ status, code, attempts }) => {
        fetchMock.mockImplementation(errorPage(status));

        const err = (await settle(() =>
          getMetService()
            .getDepartments(...call())
            .catch((e: unknown) => e),
        )) as ServiceError;

        expect(fetchMock).toHaveBeenCalledTimes(attempts);
        expect(err.code).toBe(code);
        expect(err.message).toBe(fetchFailedMessage(DEPARTMENTS_URL, status, attempts));
        expect(err.data).toMatchObject({
          status,
          statusCode: status,
          errorSource: 'FetchHttpError',
        });
        expect(err.data.reason).toBeUndefined();
        expectPageFree(err);
        // The page stays on the original error, which rides as the cause for the log.
        expect(JSON.stringify(err.cause?.data)).toContain(PAGE_MARKER);
      },
    );

    it('HTTP 429: four attempts, then upstream_rate_limited with the status and no page', async () => {
      fetchMock.mockImplementation(errorPage(429));

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.message).toBe(RATE_LIMITED_MESSAGE);
      expect(err.data).toEqual({ reason: 'upstream_rate_limited', status: 429 });
      expectPageFree(err);
      // The exhausted error, page included, rides as the cause for the log.
      expect(JSON.stringify(err.cause?.data)).toContain(PAGE_MARKER);
    });

    it('keeps data.retryable: false on a 501, and data.retryAttempts on an exhausted ladder', async () => {
      fetchMock.mockImplementation(errorPage(501));
      const permanent = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;
      expect(permanent.data.retryable).toBe(false);
      expect(permanent.data.retryAttempts).toBeUndefined();

      fetchMock.mockImplementation(errorPage(505));
      const exhausted = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;
      expect(exhausted.data).toMatchObject({
        retryAttempts: 4,
        operation: 'MetService.getDepartments',
      });
      expectPageFree(exhausted);
    });

    it('keeps an honored Retry-After on a 429 that outlasts the backoff cap, page dropped', async () => {
      fetchMock.mockImplementation(errorPage(429, { 'retry-after': '120' }));

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      // A Retry-After past the cap fails fast after one request.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.data).toEqual({ reason: 'upstream_rate_limited', status: 429, retryAfter: '120' });
      expectPageFree(err);
    });

    it('runs the ladder past its first rung: a 429 then a 400 ends on the 400, page-free', async () => {
      fetchMock.mockImplementationOnce(errorPage(429)).mockImplementationOnce(errorPage(400));

      const err = (await settle(() =>
        getMetService()
          .search({ q: 'horse', limit: 20 }, ...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data.status).toBe(400);
      expectPageFree(err);
    });

    it.each([
      ['search', () => getMetService().search({ q: 'horse', limit: 20 }, ...call())],
      [
        'listObjects',
        () => getMetService().listObjects({ departmentId: 10, limit: 20 }, ...call()),
      ],
      ['getObject', () => getMetService().getObject(436535, ...call())],
      ['getValidDepartmentIds', () => getMetService().getValidDepartmentIds(...call())],
    ])('%s drops the page from a 400 the same way', async (_name, run) => {
      fetchMock.mockImplementation(errorPage(400));

      const err = (await settle(() => run().catch((e: unknown) => e))) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expectPageFree(err);
    });

    it('drops the page when a caller abort races an HTTP failure on the keyword-only count', async () => {
      const controller = new AbortController();
      const page = new TextEncoder().encode(`<html>${PAGE_MARKER}</html>`);
      // The page is read in full, and the caller goes away as the read ends — so the
      // count's catch sees an HTTP error with its page while the signal is aborted.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(stream) {
                stream.enqueue(page);
                stream.close();
                controller.abort();
              },
            }),
            { status: 400 },
          ),
        ),
      );

      const err = (await getMetService()
        .countKeywordMatches('horse', ...call(createMockContext({ signal: controller.signal })))
        .catch((e: unknown) => e)) as ServiceError;

      expect(controller.signal.aborted).toBe(true);
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expectPageFree(err);
    });

    it('leaves upstream_blocked and upstream_unavailable exactly as they were', async () => {
      fetchMock.mockImplementation(errorPage(403));
      const blocked = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;
      expect(blocked.data).toEqual({ reason: 'upstream_blocked', retryable: false });

      fetchMock.mockImplementation(errorPage(503));
      const unavailable = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;
      expect(unavailable.data).toEqual({ reason: 'upstream_unavailable', status: 503 });
    });
  });

  describe('the caller sees no page on either surface', () => {
    it.each(STATUSES)('met_list_departments, HTTP $status', async ({ status, code, attempts }) => {
      fetchMock.mockImplementation(errorPage(status));

      const result = await settle(() => runToolContract(metListDepartments, {}));

      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data.status).toBe(status);
      expect(error.data).not.toHaveProperty('body');
      expect(error.data).not.toHaveProperty('responseBody');
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
      expect(textOf(result)).toContain(`Status: ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
    });

    it('met_list_departments, HTTP 429', async () => {
      fetchMock.mockImplementation(errorPage(429));

      const result = await settle(() => runToolContract(metListDepartments, {}));

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', status: 429 });
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
      expect(textOf(result)).toContain(RATE_LIMITED_MESSAGE);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_search_collections, HTTP 400 on the search', async () => {
      fetchMock.mockImplementation(errorPage(400));

      const result = await settle(() => runToolContract(metSearchCollections, { q: 'horse' }));

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
    });

    it('met_search_collections, HTTP 501 on the departmentId lookup', async () => {
      fetchMock.mockImplementation(errorPage(501));

      const result = await settle(() =>
        runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }),
      );

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_list_objects, HTTP 429 on the ID list', async () => {
      fetchMock.mockImplementation(errorPage(429));

      const result = await settle(() =>
        runToolContract(metListObjects, { updatedSince: '2026-09-01' }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', status: 429 });
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_get_object, HTTP 505 on every ID', async () => {
      fetchMock.mockImplementation(errorPage(505));

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [1001, 1002] }));

      expect(errorOf(result).data.reason).toBe('all_failed');
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
    });
  });
});
