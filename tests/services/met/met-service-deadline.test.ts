/**
 * @fileoverview The per-call wall-clock deadline (#22): one `MET_CALL_DEADLINE_MS`
 * budget shared by every Met API request a tool call makes, and caller
 * cancellation that stays a cancellation. Runs the real service — `withRetry`
 * and `fetchWithTimeout` included — over a faked global fetch and fake timers,
 * so each case exercises the retry ladder, backoff, and request timers it
 * asserts on. Tool cases go through `runToolContract`, the seam that builds the
 * error envelope a client reads.
 * @module tests/services/met/met-service-deadline.test
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

/** The default `MET_CALL_DEADLINE_MS`. */
const CALL_DEADLINE_MS = 30_000;

/** The declared `retry_deadline_exceeded` recovery, the same on every tool that declares it. */
const DEADLINE_RECOVERY =
  "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.";

const OBJECTS_PATH = '/public/collection/v1/objects/';
const SEARCH_PATH = '/public/collection/v1.1/search';
const DEPARTMENTS_PATH = '/public/collection/v1/departments';
const LIST_PATH = '/public/collection/v1/objects';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** A 503 exchange, minted per call so every attempt reads a fresh body. */
const unavailable = () =>
  Promise.resolve(new Response('<html>busy</html>', { status: 503, statusText: 'Unavailable' }));

/**
 * A request that never answers until its signal aborts. Like a real `fetch`, a
 * signal that is already aborted rejects at once rather than hanging.
 */
function neverAnswers(_request: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

/** A response that arrives `ms` after the request, inside the 10 s request timeout. */
const answerAfter = (ms: number, response: Response) =>
  new Promise<Response>((resolve) => {
    setTimeout(() => resolve(response), ms);
  });

/** The pathname of a fetch call's URL. */
const pathOf = (request: unknown) => new URL(String(request)).pathname;

/** The object ID a `/v1/objects/{id}` request names. */
const objectIdOf = (request: unknown) => Number(pathOf(request).slice(OBJECTS_PATH.length));

/** Run `start` to completion under fake timers, reporting the fake wall-clock it took. */
async function timed<T>(start: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = Date.now();
  const pending = start();
  await vi.runAllTimersAsync();
  const value = await pending;
  return { value, elapsedMs: Date.now() - startedAt };
}

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

describe('call deadline (#22)', () => {
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('an upstream that never answers', () => {
    /**
     * Attempt 1 runs 0–10 s, backoff 0.75–1.25 s, attempt 2 another 10 s, backoff
     * 1.5–2.5 s, and attempt 3 is cut at 30 s by the budget — three requests at
     * any jitter, then the expiry.
     */
    it('ends met_list_departments within the budget as retry_deadline_exceeded', async () => {
      fetchMock.mockImplementation(neverAnswers);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metListDepartments, {}),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(textOf(result)).toContain('retry_deadline_exceeded');
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ends met_search_collections within the budget as retry_deadline_exceeded', async () => {
      fetchMock.mockImplementation(neverAnswers);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metSearchCollections, { q: 'horse' }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ends met_list_objects within the budget as retry_deadline_exceeded', async () => {
      fetchMock.mockImplementation(neverAnswers);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metListObjects, { updatedSince: '2026-09-01' }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ends a 20-ID met_get_object within the budget as retry_deadline_exceeded, one budget across every wave', async () => {
      fetchMock.mockImplementation(neverAnswers);
      const ids = Array.from({ length: 20 }, (_, i) => 1000 + i);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metGetObject, { objectIDs: ids }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(error.message).toBe("All 20 object fetches ran out of the call's time budget.");
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      // The first wave's five ladders spend the budget, three attempts each; the
      // fifteen IDs whose ladders start after it fail without a request.
      expect(fetchMock).toHaveBeenCalledTimes(15);
      expect(new Set(fetchMock.mock.calls.map((call) => objectIdOf(call[0])))).toEqual(
        new Set([1000, 1001, 1002, 1003, 1004]),
      );
    });

    it('lists every ID the budget ran out on in failed[], with one period before the recovery', async () => {
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        objectIdOf(request) === 1000
          ? Promise.resolve(jsonResponse({ objectID: 1000, title: 'Answered' }))
          : neverAnswers(request, init),
      );
      const ids = Array.from({ length: 20 }, (_, i) => 1000 + i);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metGetObject, { objectIDs: ids }),
      );

      expect(result.isError).toBeFalsy();
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      const structured = result.structuredContent as {
        objects: { objectID: number }[];
        failed: { objectID: number; error: string }[];
      };
      expect(structured.objects.map((o) => o.objectID)).toEqual([1000]);
      expect(structured.failed.map((f) => f.objectID)).toEqual(ids.slice(1));
      // 1000 answers, its worker moves on to 1005; 1001–1005 each run three
      // attempts into the budget; 1006–1019 start after it and send nothing.
      expect(fetchMock).toHaveBeenCalledTimes(16);
      for (const { objectID, error } of structured.failed) {
        expect(error).toMatch(
          new RegExp(
            `^Failed to fetch object ${objectID}: .*[^.]\\. Retry after a brief delay\\.$`,
          ),
        );
        expect(error).not.toContain('..');
      }
      const byId = new Map(structured.failed.map((f) => [f.objectID, f.error]));
      expect(byId.get(1001)).toContain('retry deadline');
      // An ID whose fetch would start after the budget is spent says so in the
      // caller's terms, naming no internal method.
      expect(byId.get(1006)).toBe(
        "Failed to fetch object 1006: The Met API request was not sent: this call's time budget had already run out. Retry after a brief delay.",
      );
      expect(textOf(result)).toContain(`**1006:** ${byId.get(1006)}`);
    });
  });

  describe('met_get_object when nothing was fetched and every failure is the budget', () => {
    /** A 2 s budget, well under the 10 s request timeout, so every first attempt is cut by it. */
    const SHORT_BUDGET_MS = 2000;

    /**
     * The tool over a fresh service whose config parsed `MET_CALL_DEADLINE_MS`
     * from a stubbed environment — the file's static imports hold the default.
     */
    async function getObjectUnderBudget(budgetMs: number) {
      vi.resetModules();
      vi.stubEnv('MET_CALL_DEADLINE_MS', String(budgetMs));
      const service = await import('@/services/met/met-service.js');
      const { metGetObject: tool } = await import(
        '@/mcp-server/tools/definitions/met-get-object.tool.js'
      );
      service.initMetService({} as AppConfig, createInMemoryStorage());
      return tool;
    }

    /** The expiry, its code, and its declared recovery, on both client surfaces. */
    function expectBatchExpiry(result: ToolResult, message: string): void {
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(error.message).toBe(message);
      expect((error.data.recovery as { hint: string } | undefined)?.hint).toBe(DEADLINE_RECOVERY);
      const text = textOf(result);
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${DEADLINE_RECOVERY}`);
      expect(text).toContain('reason retry_deadline_exceeded');
      expect(text).not.toContain('Failed Fetches');
    }

    it('throws the batch-level expiry when every fetch ran out, not-attempted IDs included', async () => {
      fetchMock.mockImplementation(neverAnswers);
      const tool = await getObjectUnderBudget(SHORT_BUDGET_MS);
      const ids = Array.from({ length: 8 }, (_, i) => 1000 + i);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(tool, { objectIDs: ids }),
      );

      expectBatchExpiry(result, "All 8 object fetches ran out of the call's time budget.");
      expect(elapsedMs).toBeLessThanOrEqual(SHORT_BUDGET_MS);
      // The first wave's five requests are each cut at 2 s; 1005–1007 start after
      // the budget is spent and are never sent.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('words a single-ID expiry for the one object it names', async () => {
      fetchMock.mockImplementation(neverAnswers);
      const tool = await getObjectUnderBudget(SHORT_BUDGET_MS);

      const { value: result } = await timed(() => runToolContract(tool, { objectIDs: [1000] }));

      expectBatchExpiry(
        result,
        "Object 1000 could not be fetched before the call's time budget ran out.",
      );
    });

    it('carries a recovery that still holds when the Met API answered, with 503s', async () => {
      // Attempt 1 answers 503 at once, backoff 1 (0.75–1.25 s) fits, attempt 2
      // answers 503, and backoff 2 (1.5–2.5 s) cannot fit in what is left.
      fetchMock.mockImplementation(unavailable);
      const tool = await getObjectUnderBudget(SHORT_BUDGET_MS);

      const { value: result } = await timed(() => runToolContract(tool, { objectIDs: [1000] }));

      expectBatchExpiry(
        result,
        "Object 1000 could not be fetched before the call's time budget ran out.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('still ends as all_failed when a 404 sits beside the expiries', async () => {
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        objectIdOf(request) === 1000
          ? Promise.resolve(new Response('{"message":"ObjectID not found"}', { status: 404 }))
          : neverAnswers(request, init),
      );

      const { value: result } = await timed(() =>
        runToolContract(metGetObject, { objectIDs: [1000, 1001] }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('all_failed');
      expect(error.message).toBe('All 2 object fetches failed.');
    });
  });

  describe('a fast-failing upstream surfaces as the outage, not a deadline', () => {
    it('met_list_departments reports upstream_unavailable after four attempts', async () => {
      fetchMock.mockImplementation(unavailable);

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metListDepartments, {}),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('The Met API answered with a server error (HTTP 503).');
      expect(error.data.reason).toBe('upstream_unavailable');
      expect(error.data.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // 1 + 2 + 4 s of backoff, each ±25%: at most 8.75 s.
      expect(elapsedMs).toBeLessThanOrEqual(8750);
    });

    it('a single-ID met_get_object reports upstream_unavailable after four attempts', async () => {
      fetchMock.mockImplementation(unavailable);

      const { value: result } = await timed(() =>
        runToolContract(metGetObject, { objectIDs: [436535] }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('upstream_unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('one budget across a met_search_collections call', () => {
    const departments = () =>
      jsonResponse({ departments: [{ departmentId: 11, displayName: 'European Paintings' }] });

    it('charges a slow cold-cache department lookup to the search that follows it', async () => {
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        pathOf(request) === DEPARTMENTS_PATH
          ? answerAfter(9500, departments())
          : neverAnswers(request, init),
      );

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }),
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      // The search inherits the 20.5 s the lookup left: a full 10 s attempt, a
      // backoff, and a second attempt cut at 30 s.
      expect(fetchMock.mock.calls.map((call) => pathOf(call[0]))).toEqual([
        DEPARTMENTS_PATH,
        SEARCH_PATH,
        SEARCH_PATH,
      ]);
    });

    it('caps the keyword-only count at what the lookup and search left, and still answers the zero result', async () => {
      // Lookup 9.5 s, a 503 after 9 s, a backoff, "no match" after 9 s: the
      // count starts with 1.25–1.75 s left and never answers.
      let searches = 0;
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) => {
        const url = new URL(String(request));
        if (url.pathname === DEPARTMENTS_PATH) return answerAfter(9500, departments());
        if (url.searchParams.has('departmentId')) {
          searches++;
          return answerAfter(
            9000,
            searches === 1
              ? new Response('<html>busy</html>', { status: 503 })
              : jsonResponse({ total: 0, objectIDs: null }),
          );
        }
        return neverAnswers(request, init);
      });

      const { value: result, elapsedMs } = await timed(() =>
        runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }),
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { total: number; notice: string };
      expect(structured.total).toBe(0);
      expect(structured.notice).toContain('could not be checked');
      expect(textOf(result)).toContain('could not be checked');
      expect(elapsedMs).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      const count = fetchMock.mock.calls.map((call) => new URL(String(call[0]))).at(-1);
      expect(count?.searchParams.get('limit')).toBe('1');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('met_list_objects waits on its shared load only as long as its own budget', () => {
    it('ends the call at its deadline after a slow department lookup, while the load runs on', async () => {
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        pathOf(request) === DEPARTMENTS_PATH
          ? answerAfter(
              9500,
              jsonResponse({
                departments: [{ departmentId: 11, displayName: 'European Paintings' }],
              }),
            )
          : neverAnswers(request, init),
      );
      const startedAt = Date.now();
      let settledAt = Number.NaN;

      const pending = runToolContract(metListObjects, { departmentId: 11 }).then((result) => {
        settledAt = Date.now();
        return result;
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect(settledAt - startedAt).toBe(CALL_DEADLINE_MS);
      // The load starts at 9.5 s with a budget of its own, so it runs past the
      // caller's 30 s: attempts at 9.5 s, ~20.5 s, and ~32.5 s, cut at 39.5 s.
      expect(fetchMock.mock.calls.map((call) => pathOf(call[0]))).toEqual([
        DEPARTMENTS_PATH,
        LIST_PATH,
        LIST_PATH,
        LIST_PATH,
      ]);
    });
  });

  describe('the budget expiry reaches the caller with a recovery hint', () => {
    /** The expiry's envelope carries the declared hint on both surfaces. */
    function expectExpiryWithHint(result: ToolResult): void {
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      expect((error.data.recovery as { hint: string } | undefined)?.hint).toBe(DEADLINE_RECOVERY);
      expect(textOf(result)).toContain(`Recovery: ${DEADLINE_RECOVERY}`);
    }

    const cases: [string, () => Promise<ToolResult>][] = [
      ['met_list_departments', () => runToolContract(metListDepartments, {})],
      ['met_search_collections', () => runToolContract(metSearchCollections, { q: 'horse' })],
      ['met_list_objects', () => runToolContract(metListObjects, { updatedSince: '2026-09-01' })],
      ['met_get_object', () => runToolContract(metGetObject, { objectIDs: [1000, 1001] })],
    ];

    it.each(cases)('%s, when its retry ladder runs out', async (_name, run) => {
      fetchMock.mockImplementation(neverAnswers);

      const { value: result } = await timed(run);

      expectExpiryWithHint(result);
    });

    it('met_search_collections, when the search ladder inherits a budget a slow lookup spent', async () => {
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        pathOf(request) === DEPARTMENTS_PATH
          ? answerAfter(
              9500,
              jsonResponse({
                departments: [{ departmentId: 11, displayName: 'European Paintings' }],
              }),
            )
          : neverAnswers(request, init),
      );

      const { value: result } = await timed(() =>
        runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }),
      );

      expectExpiryWithHint(result);
    });

    it('met_list_objects, when the caller stops waiting on the shared load', async () => {
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        pathOf(request) === DEPARTMENTS_PATH
          ? answerAfter(
              9500,
              jsonResponse({
                departments: [{ departmentId: 11, displayName: 'European Paintings' }],
              }),
            )
          : neverAnswers(request, init),
      );

      const { value: result } = await timed(() =>
        runToolContract(metListObjects, { departmentId: 11 }),
      );

      expectExpiryWithHint(result);
      expect(errorOf(result).message).toBe(
        "This call's time budget ran out while waiting for the Met API's object ID list.",
      );
    });

    it('met_get_object, once a partial success is off the table: one expiry, not all_failed', async () => {
      fetchMock.mockImplementation(neverAnswers);

      const { value: result } = await timed(() =>
        runToolContract(metGetObject, { objectIDs: [1000] }),
      );

      expectExpiryWithHint(result);
      expect(errorOf(result).message).toBe(
        "Object 1000 could not be fetched before the call's time budget ran out.",
      );
    });
  });

  describe('caller cancellation stays a cancellation', () => {
    /** 1001 answers at once; every other ID hangs. */
    const oneAnswers = (request: unknown, init?: RequestInit) =>
      objectIdOf(request) === 1001
        ? Promise.resolve(jsonResponse({ objectID: 1001, title: 'Answered' }))
        : neverAnswers(request, init);

    it('ends a batch cancelled mid-flight as RequestCancelled, not a partial success', async () => {
      fetchMock.mockImplementation(oneAnswers);
      const controller = new AbortController();

      const pending = runToolContract(
        metGetObject,
        { objectIDs: [1001, 1002, 1003] },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(500);
      controller.abort();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(textOf(result)).not.toContain('Failed Fetches');
    });

    it('ends a batch cancelled during a backoff sleep as RequestCancelled', async () => {
      // 1002 fails fast with a 503, so its ladder is sleeping its first backoff
      // (at least 750 ms) when the cancel lands at 500 ms.
      fetchMock.mockImplementation((request: unknown, init?: RequestInit) =>
        objectIdOf(request) === 1002 ? unavailable() : oneAnswers(request, init),
      );
      const controller = new AbortController();

      const pending = runToolContract(
        metGetObject,
        { objectIDs: [1001, 1002] },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(500);
      controller.abort();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('MetService ladders under a caller-supplied deadline', () => {
    it('fails a ladder that starts with the budget spent as the expiry, without a request', async () => {
      fetchMock.mockImplementation(unavailable);
      const ctx = createMockContext();

      const { value: err } = await timed(() =>
        getMetService()
          .getObject(436535, ctx, { deadlineAt: Date.now(), signal: ctx.signal })
          .catch((e: unknown) => e),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: "The Met API request was not sent: this call's time budget had already run out.",
        data: { reason: 'retry_deadline_exceeded' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never sleeps a backoff into the budget: the second backoff outlasts it, so the ladder ends early', async () => {
      // A 2 s budget: backoff 1 (0.75–1.25 s) fits, backoff 2 (1.5–2.5 s) cannot
      // fit in the 0.75–1.25 s left, at any jitter.
      fetchMock.mockImplementation(unavailable);
      const ctx = createMockContext();

      const { value: err, elapsedMs } = await timed(() =>
        getMetService()
          .getDepartments(ctx, { deadlineAt: Date.now() + 2000, signal: ctx.signal })
          .catch((e: unknown) => e),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', retryAttempts: 2 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(elapsedMs).toBeGreaterThanOrEqual(750);
      expect(elapsedMs).toBeLessThanOrEqual(1250);
    });

    it("bounds an attempt's request by what is left of the budget, not the full request timeout", async () => {
      fetchMock.mockImplementation(neverAnswers);
      const ctx = createMockContext();

      const { value: err, elapsedMs } = await timed(() =>
        getMetService()
          .search({ q: 'cat', limit: 20 }, ctx, {
            deadlineAt: Date.now() + 5000,
            signal: ctx.signal,
          })
          .catch((e: unknown) => e),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded' },
      });
      expect(elapsedMs).toBe(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("caps the keyword-only count's single attempt at the remaining budget", async () => {
      fetchMock.mockImplementation(neverAnswers);
      const ctx = createMockContext();

      const { value: total, elapsedMs } = await timed(() =>
        getMetService().countKeywordMatches('cat', ctx, {
          deadlineAt: Date.now() + 3000,
          signal: ctx.signal,
        }),
      );

      expect(total).toBeNull();
      expect(elapsedMs).toBe(3000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips the keyword-only count without a request when the budget is already spent', async () => {
      fetchMock.mockImplementation(neverAnswers);
      const ctx = createMockContext();

      const { value: total, elapsedMs } = await timed(() =>
        getMetService().countKeywordMatches('cat', ctx, {
          deadlineAt: Date.now(),
          signal: ctx.signal,
        }),
      );

      expect(total).toBeNull();
      expect(elapsedMs).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('runs under a deadline and signal that are not the tool call’s ctx', async () => {
      fetchMock.mockImplementation(neverAnswers);
      const ctx = createMockContext();
      const own = new AbortController();

      const pending = getMetService()
        .getDepartments(ctx, { deadlineAt: Date.now() + CALL_DEADLINE_MS, signal: own.signal })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      own.abort();
      await vi.runAllTimersAsync();

      expect(await pending).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(ctx.signal.aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('a call inside the budget is unchanged', () => {
    it('makes one request per endpoint and returns the same results', async () => {
      vi.useRealTimers();
      fetchMock.mockImplementation((request: unknown) => {
        const url = new URL(String(request));
        if (url.pathname === DEPARTMENTS_PATH) {
          return Promise.resolve(
            jsonResponse({
              departments: [{ departmentId: 11, displayName: 'European Paintings' }],
            }),
          );
        }
        if (url.pathname === SEARCH_PATH) {
          return Promise.resolve(jsonResponse({ total: 2, objectIDs: [436535, 1] }));
        }
        return Promise.resolve(jsonResponse({ objectID: objectIdOf(request), title: 'Wheat' }));
      });

      const departments = await runToolContract(metListDepartments, {});
      const search = await runToolContract(metSearchCollections, { q: 'wheat', departmentId: 11 });
      const objects = await runToolContract(metGetObject, { objectIDs: [436535, 1] });

      expect(departments.structuredContent).toEqual({
        departments: [{ departmentId: 11, displayName: 'European Paintings' }],
      });
      expect(search.structuredContent).toMatchObject({ total: 2, objectIDs: [436535, 1] });
      expect(
        (objects.structuredContent as { objects: { objectID: number; title: string }[] }).objects,
      ).toMatchObject([
        { objectID: 436535, title: 'Wheat' },
        { objectID: 1, title: 'Wheat' },
      ]);
      expect(fetchMock.mock.calls.map((call) => pathOf(call[0]))).toEqual([
        DEPARTMENTS_PATH,
        DEPARTMENTS_PATH,
        SEARCH_PATH,
        `${OBJECTS_PATH}436535`,
        `${OBJECTS_PATH}1`,
      ]);
    });
  });
});

/** A fresh config module parsed against one stubbed variable. */
async function loadConfig(name: string, value: string | undefined) {
  vi.resetModules();
  vi.stubEnv(name, value);
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

describe('MET_CALL_DEADLINE_MS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 30000 ms', async () => {
    const getServerConfig = await loadConfig('MET_CALL_DEADLINE_MS', undefined);
    expect(getServerConfig().callDeadlineMs).toBe(CALL_DEADLINE_MS);
  });

  it('reads a positive integer override', async () => {
    const getServerConfig = await loadConfig('MET_CALL_DEADLINE_MS', '45000');
    expect(getServerConfig().callDeadlineMs).toBe(45_000);
  });

  it.each(['abc', '0', '-5', '2.5'])('rejects %s, naming the variable', async (value) => {
    const getServerConfig = await loadConfig('MET_CALL_DEADLINE_MS', value);
    expect(() => getServerConfig()).toThrow(/MET_CALL_DEADLINE_MS/);
  });
});

/**
 * Both millisecond settings become timer delays, and a delay past 2^31 − 1 ms
 * overflows the timer, which then fires at once — a budget of zero.
 */
describe('the timer ceiling on millisecond settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const settings = [
    ['MET_CALL_DEADLINE_MS', 'callDeadlineMs'],
    ['MET_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'],
  ] as const;

  it.each(settings)('%s accepts 2147483647, the largest timer delay', async (name, key) => {
    const getServerConfig = await loadConfig(name, '2147483647');
    expect(getServerConfig()[key]).toBe(2_147_483_647);
  });

  it.each(settings)('%s rejects 2147483648 at startup, naming the variable', async (name) => {
    const getServerConfig = await loadConfig(name, '2147483648');
    expect(() => getServerConfig()).toThrow(new RegExp(name));
  });
});
