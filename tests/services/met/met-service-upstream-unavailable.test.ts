/**
 * @fileoverview A Met API 5xx outage (#33). A retry ladder that ends on HTTP 500,
 * 502, 503, or 504 is classified as `upstream_unavailable` with no upstream page
 * in the error, every tool surfaces that reason and its wait recovery on both
 * client surfaces, and `met_get_object` stops sending the IDs queued behind an
 * outage while the Met has answered no ID in the call. Runs the real service —
 * `fetchWithTimeout`'s status mapping, the retry ladder, and its backoff
 * included — over a faked global fetch and fake timers.
 * @module tests/services/met/met-service-upstream-unavailable.test
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

const OBJECTS_PATH = '/public/collection/v1/objects/';

/** The declared `upstream_unavailable` recovery, the same on every tool. */
const OUTAGE_RECOVERY =
  'The Met API is failing on its side, so changing the request will not help. Wait a few minutes before retrying.';

/** Text that appears only in the upstream error page, never in an envelope. */
const PAGE_MARKER = 'UPSTREAM-ERROR-PAGE';

/** An HTML error page exchange with the given status, minted per attempt. */
const serverError = (status: number) => () =>
  Promise.resolve(
    new Response(
      `<!DOCTYPE html><html><body><h1>Service Unavailable</h1><p>Reference #${PAGE_MARKER}-${status}</p></body></html>`,
      { status, statusText: 'Server Error', headers: { 'content-type': 'text/html' } },
    ),
  );

const unavailable = serverError(503);

const notFoundResponse = () => new Response('{"message":"ObjectID not found"}', { status: 404 });

const notFound = () => Promise.resolve(notFoundResponse());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** A minimal object record for `id`. */
const record = (id: number) =>
  Promise.resolve(jsonResponse({ objectID: id, title: `Object ${id}` }));

/** The object ID a `/v1/objects/{id}` request names. */
const objectIdOf = (request: unknown) =>
  Number(new URL(String(request)).pathname.slice(OBJECTS_PATH.length));

/** A plain-deadline call bound for service-level cases. */
function call() {
  const ctx = createMockContext();
  return [ctx, { deadlineAt: Date.now() + 30_000, signal: ctx.signal }] as const;
}

/** Run `start` to completion under fake timers. */
async function settle<T>(start: () => Promise<T>): Promise<T> {
  const pending = start();
  await vi.runAllTimersAsync();
  return await pending;
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

interface ErrorEnvelope {
  code: number;
  data: Record<string, unknown> & { recovery?: { hint: string } };
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

/** `failed[]` of a partial success. */
function failedOf(result: ToolResult): { objectID: number; error: string }[] {
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { failed: { objectID: number; error: string }[] }).failed;
}

/** The message every exhausted outage ladder carries. */
const outageMessage = (status: number) =>
  `The Met API answered with a server error (HTTP ${status}).`;

/**
 * The upstream_unavailable envelope, on both surfaces: -32000, the reason and
 * status and nothing else from the service, the recovery, and no page text.
 */
function expectUnavailable(result: ToolResult, status: number, message: string): ErrorEnvelope {
  const error = errorOf(result);
  expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect(error.message).toBe(message);
  expect(error.data).toEqual({
    reason: 'upstream_unavailable',
    status,
    recovery: { hint: OUTAGE_RECOVERY },
  });
  expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);

  const text = textOf(result);
  expect(text).toContain(`Error: ${message}`);
  expect(text).toContain(`Recovery: ${OUTAGE_RECOVERY}`);
  expect(text).toContain('(reason upstream_unavailable)');
  expect(text).not.toContain('brief delay');
  return error;
}

describe('a Met API 5xx outage (#33)', () => {
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

  describe('MetService classifies an exhausted 500/502/503/504 ladder', () => {
    it.each([500, 502, 503, 504])(
      'HTTP %i: four attempts, then upstream_unavailable carrying reason and status only',
      async (status) => {
        fetchMock.mockImplementation(serverError(status));

        const err = (await settle(() =>
          getMetService()
            .getDepartments(...call())
            .catch((e: unknown) => e),
        )) as { code: number; message: string; data: unknown; cause: unknown };

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.message).toBe(outageMessage(status));
        expect(err.data).toEqual({ reason: 'upstream_unavailable', status });
        // The exhausted ladder's own error rides as the cause, for the log only.
        expect(err.cause).toMatchObject({
          data: { status, retryAttempts: 4, errorSource: 'FetchHttpError' },
        });
      },
    );

    it.each([
      ['getObject', () => getMetService().getObject(436535, ...call())],
      ['search', () => getMetService().search({ q: 'horse', limit: 20 }, ...call())],
      [
        'listObjects',
        () => getMetService().listObjects({ departmentId: 10, limit: 20 }, ...call()),
      ],
      ['getValidDepartmentIds', () => getMetService().getValidDepartmentIds(...call())],
    ])('%s', async (_name, run) => {
      fetchMock.mockImplementation(unavailable);

      const err = await settle(() => run().catch((e: unknown) => e));

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: outageMessage(503),
        data: { reason: 'upstream_unavailable', status: 503 },
      });
    });

    it('classifies a 503 whose Retry-After outlasts the backoff cap, after its one request', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(`<html>${PAGE_MARKER}</html>`, {
            status: 503,
            headers: { 'retry-after': '120' },
          }),
        ),
      );

      const err = await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((err as { data: unknown }).data).toEqual({
        reason: 'upstream_unavailable',
        status: 503,
        retryAfter: '120',
      });
    });

    it('keeps the wait a Retry-After names on the envelope, and the page off it', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(`<html>${PAGE_MARKER}</html>`, {
            status: 503,
            headers: { 'retry-after': '120' },
          }),
        ),
      );

      const result = await settle(() => runToolContract(metListDepartments, {}));

      const error = errorOf(result);
      expect(error.data).toEqual({
        reason: 'upstream_unavailable',
        status: 503,
        retryAfter: '120',
        recovery: { hint: OUTAGE_RECOVERY },
      });
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
    });

    it('returns the result when a 5xx inside the ladder is followed by a 200', async () => {
      fetchMock.mockImplementationOnce(unavailable).mockImplementationOnce(() => record(436535));

      const result = await settle(() => getMetService().getObject(436535, ...call()));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result?.objectID).toBe(436535);
    });

    it('leaves 501 as it was: one request, no reason', async () => {
      fetchMock.mockImplementation(serverError(501));

      const err = await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect((err as { data: { reason?: unknown } }).data.reason).toBeUndefined();
    });

    it('leaves 505 as it was: four attempts, no reason', async () => {
      fetchMock.mockImplementation(serverError(505));

      const err = await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      );

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect((err as { data: { reason?: unknown } }).data.reason).toBeUndefined();
    });
  });

  describe('every tool surfaces the reason on both client surfaces', () => {
    it.each([500, 502, 503, 504])(
      'met_list_departments, HTTP %i: four requests, -32000',
      async (status) => {
        fetchMock.mockImplementation(serverError(status));

        const result = await settle(() => runToolContract(metListDepartments, {}));

        expectUnavailable(result, status, outageMessage(status));
        expect(fetchMock).toHaveBeenCalledTimes(4);
      },
    );

    it('met_search_collections', async () => {
      fetchMock.mockImplementation(unavailable);

      const result = await settle(() => runToolContract(metSearchCollections, { q: 'horse' }));

      expectUnavailable(result, 503, outageMessage(503));
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_search_collections when the failing request is the departmentId lookup', async () => {
      fetchMock.mockImplementation(unavailable);

      const result = await settle(() =>
        runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }),
      );

      expectUnavailable(result, 503, outageMessage(503));
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_list_objects', async () => {
      fetchMock.mockImplementation(unavailable);

      const result = await settle(() =>
        runToolContract(metListObjects, { updatedSince: '2026-09-01' }),
      );

      expectUnavailable(result, 503, outageMessage(503));
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_list_objects when the failing request is the departmentId lookup', async () => {
      fetchMock.mockImplementation(unavailable);

      const result = await settle(() => runToolContract(metListObjects, { departmentId: 10 }));

      expectUnavailable(result, 503, outageMessage(503));
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_list_departments keeps 501 unclassified after one request', async () => {
      fetchMock.mockImplementation(serverError(501));

      const result = await settle(() => runToolContract(metListDepartments, {}));

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('met_get_object', () => {
    it('one ID: four requests, then the batch-level upstream_unavailable', async () => {
      fetchMock.mockImplementation(unavailable);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [436535] }));

      expectUnavailable(result, 503, `No object could be fetched. ${outageMessage(503)}`);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('keeps the wait a Retry-After names on the batch-level envelope', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(`<html>${PAGE_MARKER}</html>`, {
            status: 503,
            headers: { 'retry-after': '120' },
          }),
        ),
      );

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [436535] }));

      expect(errorOf(result).data).toEqual({
        reason: 'upstream_unavailable',
        status: 503,
        retryAfter: '120',
        recovery: { hint: OUTAGE_RECOVERY },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
    });

    it.each([8, 20])(
      '%i IDs: only the first wave runs its ladders; the queued IDs send nothing',
      async (count) => {
        fetchMock.mockImplementation(unavailable);
        const ids = Array.from({ length: count }, (_, i) => 1001 + i);

        const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

        expectUnavailable(result, 503, `No object could be fetched. ${outageMessage(503)}`);
        // MET_BATCH_CONCURRENCY (5) ladders × 4 attempts.
        expect(fetchMock).toHaveBeenCalledTimes(20);
        expect(new Set(fetchMock.mock.calls.map((c) => objectIdOf(c[0])))).toEqual(
          new Set([1001, 1002, 1003, 1004, 1005]),
        );
      },
    );

    describe('a first-wave fetch still in flight when a ladder ends on the outage', () => {
      /** 1001 answers `late` at 9 s; 1002–1005 answer 503; the queued IDs are healthy. */
      const lateFirst = (late: () => Response) => (request: unknown) => {
        const id = objectIdOf(request);
        if (id === 1001)
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(late()), 9000);
          });
        return id <= 1005 ? unavailable() : record(id);
      };
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);
      const objectsOf = (result: ToolResult) =>
        (result.structuredContent as { objects: { objectID: number }[] }).objects.map(
          (o) => o.objectID,
        );

      it('waits for it: a late record turns the skip off and the queue is requested', async () => {
        fetchMock.mockImplementation(
          lateFirst(() => jsonResponse({ objectID: 1001, title: 'Late' })),
        );

        const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

        // 1001's one request, four first-wave ladders, one request per queued ID.
        expect(fetchMock).toHaveBeenCalledTimes(20);
        expect(objectsOf(result)).toEqual([1001, 1006, 1007, 1008]);
        expect(failedOf(result)).toEqual(
          [1002, 1003, 1004, 1005].map((objectID) => ({
            objectID,
            error: `Failed to fetch object ${objectID}: ${outageMessage(503)} ${OUTAGE_RECOVERY}`,
          })),
        );
        expect(textOf(result)).not.toContain('was not requested');
        expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
      });

      it('waits for it: a late 404 turns the skip off, so the batch is a partial success', async () => {
        fetchMock.mockImplementation(lateFirst(() => notFoundResponse()));

        const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

        expect(fetchMock).toHaveBeenCalledTimes(20);
        expect(objectsOf(result)).toEqual([1006, 1007, 1008]);
        expect(failedOf(result).map((f) => f.objectID)).toEqual([1001, 1002, 1003, 1004, 1005]);
      });

      it('decides the same way whichever answer lands first', async () => {
        // Every ladder runs on the same unjittered schedule, so 1001's fourth
        // 503 and 1002–1005's fourth-attempt records land in the same instant,
        // 1001's first.
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const attempts = new Map<number, number>();
        fetchMock.mockImplementation((request: unknown) => {
          const id = objectIdOf(request);
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          return id === 1001 || (id <= 1005 && n < 4) ? unavailable() : record(id);
        });

        const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

        expect(objectsOf(result)).toEqual([1002, 1003, 1004, 1005, 1006, 1007, 1008]);
      });

      it('ends as cancelled when the call is cancelled while the skip waits', async () => {
        fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
          objectIdOf(request) === 1001
            ? new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
              })
            : unavailable(),
        );
        const controller = new AbortController();

        const pending = runToolContract(
          metGetObject,
          { objectIDs: ids },
          { context: { signal: controller.signal } },
        );
        await vi.advanceTimersByTimeAsync(9000);
        controller.abort();
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(fetchMock.mock.calls.map((c) => objectIdOf(c[0]))).not.toContain(1006);
      });
    });

    it('requests every ID when only one fails, and gives that entry the outage recovery', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001 ? unavailable() : record(objectIdOf(request)),
      );
      const ids = Array.from({ length: 20 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      const failed = failedOf(result);
      // 19 answered IDs, one request each, and 1001's four attempts.
      expect(fetchMock).toHaveBeenCalledTimes(23);
      expect(
        (result.structuredContent as { objects: { objectID: number }[] }).objects.map(
          (o) => o.objectID,
        ),
      ).toEqual(ids.slice(1));
      expect(failed).toEqual([
        {
          objectID: 1001,
          error: `Failed to fetch object 1001: ${outageMessage(503)} ${OUTAGE_RECOVERY}`,
        },
      ]);
      expect(textOf(result)).toContain(`**1001:** ${failed[0]?.error}`);
    });

    it('counts a 404 as an answer: no ID is skipped, and the empty batch still names the outage', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001 ? notFound() : unavailable(),
      );
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      expectUnavailable(result, 503, `No object could be fetched. ${outageMessage(503)}`);
      // 1001's one request, then seven full ladders.
      expect(fetchMock).toHaveBeenCalledTimes(29);
    });

    it('names the outage over all_failed when a network error sits beside it', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001
          ? Promise.reject(new TypeError('fetch failed'))
          : unavailable(),
      );

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [1001, 1002] }));

      expectUnavailable(result, 503, `No object could be fetched. ${outageMessage(503)}`);
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    it('still ends as upstream_blocked when a 403 sits beside the outage', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001
          ? Promise.resolve(new Response('<html>Access Denied</html>', { status: 403 }))
          : unavailable(),
      );
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      const error = errorOf(result);
      expect(error.data.reason).toBe('upstream_blocked');
      // 1001's one refused request and the four other first-wave ladders; the
      // block stops the queue.
      expect(fetchMock).toHaveBeenCalledTimes(17);
    });

    it('still ends as all_failed when every fetch is a network error, each ID running its ladder', async () => {
      fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('all_failed');
      expect(fetchMock).toHaveBeenCalledTimes(32);
    });

    it.each([
      [501, 1],
      [505, 4],
    ])('still ends as all_failed when every ID answers HTTP %i', async (status, attempts) => {
      fetchMock.mockImplementation(serverError(status));

      const result = await settle(() =>
        runToolContract(metGetObject, { objectIDs: [1001, 1002, 1003] }),
      );

      expect(errorOf(result).data.reason).toBe('all_failed');
      expect(fetchMock).toHaveBeenCalledTimes(3 * attempts);
    });
  });
});
