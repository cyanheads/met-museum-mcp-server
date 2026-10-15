/**
 * @fileoverview An HTTP 429 from the Met API (#49). A retry ladder that ends on
 * 429 — every attempt spent, or a `Retry-After` too long for the backoff cap or
 * the call's remaining budget — is classified as `upstream_rate_limited` with no
 * upstream page in the error and the requested wait in its message. Every tool
 * surfaces that reason and its recovery on both client surfaces, and
 * `met_get_object` stops sending the IDs queued behind a throttle. Runs the real
 * service — `fetchWithTimeout`'s status mapping, the retry ladder, its backoff,
 * and `Retry-After` handling included — over a faked global fetch and fake timers.
 * @module tests/services/met/met-service-upstream-rate-limited.test
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

/** The declared `upstream_rate_limited` recovery, the same on every tool. */
const RATE_LIMIT_RECOVERY =
  'Wait the period this error names, or about a minute when it names none, then retry with fewer requests at once.';

/** Text that appears only in the upstream error page, never in an envelope. */
const PAGE_MARKER = 'UPSTREAM-ERROR-PAGE';

/** The message a 429-ended ladder carries, naming the wait when the Met asked for one. */
const rateLimitMessage = (waitSeconds?: number) =>
  `The Met API is rate-limiting requests from this server (HTTP 429)${
    waitSeconds === undefined ? '' : ` and asked for a ${waitSeconds}-second wait`
  }.`;

/** An HTML 429 page exchange, with `Retry-After` when given, minted per attempt. */
const tooMany = (retryAfter?: string) => () =>
  Promise.resolve(
    new Response(
      `<!DOCTYPE html><html><body><h1>Too Many Requests</h1><p>Reference #${PAGE_MARKER}-429</p></body></html>`,
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'content-type': 'text/html',
          ...(retryAfter !== undefined && { 'retry-after': retryAfter }),
        },
      },
    ),
  );

const throttled = tooMany('120');

const serverError = (status: number) => () =>
  Promise.resolve(
    new Response(`<html>${PAGE_MARKER}-${status}</html>`, {
      status,
      headers: { 'content-type': 'text/html' },
    }),
  );

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
function call(budgetMs = 30_000) {
  const ctx = createMockContext();
  return [ctx, { deadlineAt: Date.now() + budgetMs, signal: ctx.signal }] as const;
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

const objectsOf = (result: ToolResult) =>
  (result.structuredContent as { objects: { objectID: number }[] }).objects.map((o) => o.objectID);

/**
 * The upstream_rate_limited envelope, on both surfaces: -32003, the reason,
 * status, and `Retry-After` value and nothing else from the service, the
 * recovery, and no page text.
 */
function expectRateLimited(
  result: ToolResult,
  message: string,
  retryAfter?: string,
): ErrorEnvelope {
  const error = errorOf(result);
  expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
  expect(error.message).toBe(message);
  expect(error.data).toEqual({
    reason: 'upstream_rate_limited',
    status: 429,
    ...(retryAfter !== undefined && { retryAfter }),
    recovery: { hint: RATE_LIMIT_RECOVERY },
  });
  expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);

  const text = textOf(result);
  expect(text).toContain(`Error: ${message}`);
  expect(text).toContain(`Recovery: ${RATE_LIMIT_RECOVERY}`);
  expect(text).toContain('(reason upstream_rate_limited)');
  expect(text).not.toContain('brief delay');
  return error;
}

describe('an HTTP 429 from the Met API (#49)', () => {
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

  describe('MetService classifies a ladder that ends on 429', () => {
    it('Retry-After past the backoff cap: one request, the wait named, the raw value kept', async () => {
      fetchMock.mockImplementation(throttled);

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.message).toBe(rateLimitMessage(120));
      expect(err.data).toEqual({ reason: 'upstream_rate_limited', status: 429, retryAfter: '120' });
      // The attempt's own error, page included, rides as the cause for the log only.
      expect(JSON.stringify(err.cause?.data)).toContain(PAGE_MARKER);
    });

    it('no Retry-After: four attempts, then the reason with no wait named', async () => {
      fetchMock.mockImplementation(tooMany());

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.message).toBe(rateLimitMessage());
      expect(err.data).toEqual({ reason: 'upstream_rate_limited', status: 429 });
      expect(err.cause?.data).toMatchObject({ status: 429, retryAttempts: 4 });
    });

    it('an HTTP-date Retry-After: the wait named in seconds from now', async () => {
      vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
      const retryAfter = 'Thu, 15 Oct 2026 12:02:00 GMT';
      fetchMock.mockImplementation(tooMany(retryAfter));

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.message).toBe(rateLimitMessage(120));
      expect(err.data.retryAfter).toBe(retryAfter);
    });

    it('an unparseable Retry-After: the full ladder, no wait named, the raw value kept', async () => {
      fetchMock.mockImplementation(tooMany('soon'));

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.message).toBe(rateLimitMessage());
      expect(err.data).toEqual({
        reason: 'upstream_rate_limited',
        status: 429,
        retryAfter: 'soon',
      });
    });

    it('a Retry-After inside the cap but past the remaining budget: one request, classified', async () => {
      fetchMock.mockImplementation(tooMany('20'));

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call(10_000))
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.message).toBe(rateLimitMessage(20));
      expect(err.data).toEqual({ reason: 'upstream_rate_limited', status: 429, retryAfter: '20' });
    });

    it.each([
      ['0', rateLimitMessage()],
      ['Wed, 21 Oct 2015 07:28:00 GMT', rateLimitMessage()],
      [
        'Thu, 01 Jan 2099 00:00:00 GMT',
        'The Met API is rate-limiting requests from this server (HTTP 429) and asked for a wait of more than a day.',
      ],
    ])(
      'Retry-After %s: no zero wait is named, and none longer than a day as seconds',
      async (retryAfter, message) => {
        fetchMock.mockImplementation(tooMany(retryAfter));

        const err = (await settle(() =>
          getMetService()
            .getDepartments(...call())
            .catch((e: unknown) => e),
        )) as ServiceError;

        expect(err.message).toBe(message);
        expect(err.data).toEqual({ reason: 'upstream_rate_limited', status: 429, retryAfter });
      },
    );

    it('uses "an" before a wait read with a vowel sound', async () => {
      fetchMock.mockImplementation(tooMany('8'));

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call())
          .catch((e: unknown) => e),
      )) as ServiceError;

      // 8 s fits the cap and the budget, so every rung waits it out.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.message).toBe(
        'The Met API is rate-limiting requests from this server (HTTP 429) and asked for an 8-second wait.',
      );
    });

    it('waits out a Retry-After inside the cap and budget: a 429 then a 200 returns the result', async () => {
      fetchMock.mockImplementationOnce(tooMany('2')).mockImplementationOnce(() => record(436535));

      const started = Date.now();
      const result = await settle(() => getMetService().getObject(436535, ...call()));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result?.objectID).toBe(436535);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    });

    it('a 429 with no Retry-After then a 200 returns the result', async () => {
      fetchMock.mockImplementationOnce(tooMany()).mockImplementationOnce(() => record(436535));

      const result = await settle(() => getMetService().getObject(436535, ...call()));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result?.objectID).toBe(436535);
    });

    it('leaves a ladder the call deadline cuts after 429 answers as retry_deadline_exceeded', async () => {
      // Unjittered backoff: 1 s, then 2 s — more than the 1.5 s left after the second answer.
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      fetchMock.mockImplementation(tooMany());

      const err = (await settle(() =>
        getMetService()
          .getDepartments(...call(2500))
          .catch((e: unknown) => e),
      )) as ServiceError;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data.reason).toBe('retry_deadline_exceeded');
    });

    it.each([
      ['getObject', () => getMetService().getObject(436535, ...call())],
      ['search', () => getMetService().search({ q: 'horse', limit: 20 }, ...call())],
      [
        'listObjects',
        () => getMetService().listObjects({ departmentId: 10, limit: 20 }, ...call()),
      ],
      ['getValidDepartmentIds', () => getMetService().getValidDepartmentIds(...call())],
    ])('%s', async (_name, run) => {
      fetchMock.mockImplementation(throttled);

      const err = await settle(() => run().catch((e: unknown) => e));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        message: rateLimitMessage(120),
        data: { reason: 'upstream_rate_limited', status: 429, retryAfter: '120' },
      });
    });
  });

  describe('every tool surfaces the reason on both client surfaces', () => {
    const tools = [
      ['met_list_departments', () => runToolContract(metListDepartments, {})],
      ['met_search_collections', () => runToolContract(metSearchCollections, { q: 'sunflower' })],
      ['met_list_objects', () => runToolContract(metListObjects, {})],
    ] as const;

    it.each(tools)('%s, Retry-After 120: one request, the wait named', async (_name, run) => {
      fetchMock.mockImplementation(throttled);

      const result = await settle(run);

      expectRateLimited(result, rateLimitMessage(120), '120');
      expect(textOf(result)).toContain('120-second wait');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(tools)('%s, no Retry-After: four requests, no wait named', async (_name, run) => {
      fetchMock.mockImplementation(tooMany());

      const result = await settle(run);

      expectRateLimited(result, rateLimitMessage());
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('met_search_collections when the throttled request is the departmentId lookup', async () => {
      fetchMock.mockImplementation(throttled);

      const result = await settle(() =>
        runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }),
      );

      expectRateLimited(result, rateLimitMessage(120), '120');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_list_objects when the throttled request is the departmentId lookup', async () => {
      fetchMock.mockImplementation(throttled);

      const result = await settle(() => runToolContract(metListObjects, { departmentId: 10 }));

      expectRateLimited(result, rateLimitMessage(120), '120');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('met_get_object', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 1001 + i);

    it('one ID, Retry-After 120: one request, then the batch-level upstream_rate_limited', async () => {
      fetchMock.mockImplementation(throttled);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [436535] }));

      expectRateLimited(result, `No object could be fetched. ${rateLimitMessage(120)}`, '120');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('20 IDs, Retry-After 120: only the first wave is requested, one request each', async () => {
      fetchMock.mockImplementation(throttled);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: twenty }));

      expectRateLimited(result, `No object could be fetched. ${rateLimitMessage(120)}`, '120');
      // MET_BATCH_CONCURRENCY (5) requests.
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(new Set(fetchMock.mock.calls.map((c) => objectIdOf(c[0])))).toEqual(
        new Set([1001, 1002, 1003, 1004, 1005]),
      );
    });

    it('20 IDs, no Retry-After: only the first wave runs its ladders', async () => {
      fetchMock.mockImplementation(tooMany());

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: twenty }));

      expectRateLimited(result, `No object could be fetched. ${rateLimitMessage()}`);
      // MET_BATCH_CONCURRENCY (5) ladders × 4 attempts.
      expect(fetchMock).toHaveBeenCalledTimes(20);
    });

    it('stops sending queued IDs once the call budget cuts a 429 ladder', async () => {
      // Unjittered backoff: 1001 answers 429 at 0 s and 1 s, then its 2 s backoff outruns the 1.5 s left.
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      vi.resetModules();
      vi.stubEnv('MET_CALL_DEADLINE_MS', '2500');
      vi.stubEnv('MET_BATCH_CONCURRENCY', '1');
      try {
        const service = await import('@/services/met/met-service.js');
        const { metGetObject: tool } = await import(
          '@/mcp-server/tools/definitions/met-get-object.tool.js'
        );
        service.initMetService({} as AppConfig, createInMemoryStorage());
        fetchMock.mockImplementation(tooMany());

        const result = await settle(() => runToolContract(tool, { objectIDs: twenty }));

        expect(errorOf(result).data.reason).toBe('retry_deadline_exceeded');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('19 records and a throttled 20th: the 20th fails with the rate-limit recovery', async () => {
      fetchMock.mockImplementation((request: unknown) => {
        const id = objectIdOf(request);
        return id === 1020 ? throttled() : record(id);
      });

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: twenty }));

      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(objectsOf(result)).toEqual(twenty.slice(0, 19));
      const failed = failedOf(result);
      expect(failed).toEqual([
        {
          objectID: 1020,
          error: `Failed to fetch object 1020: ${rateLimitMessage(120)} ${RATE_LIMIT_RECOVERY}`,
        },
      ]);
      expect(textOf(result)).toContain(`**1020:** ${failed[0]?.error}`);
      expect(JSON.stringify(result)).not.toContain('brief delay');
      expect(JSON.stringify(result)).not.toContain(PAGE_MARKER);
    });

    it('lists the IDs queued behind the throttle in failed[] with its recovery, unrequested', async () => {
      // 1001 is throttled at once; 1002–1005 answer later, so 1001's worker
      // picks up 1006 with the throttle already known.
      fetchMock.mockImplementation((request: unknown) => {
        const id = objectIdOf(request);
        if (id === 1001) return throttled();
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ objectID: id, title: `Object ${id}` })), 100);
        });
      });
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(objectsOf(result)).toEqual([1002, 1003, 1004, 1005]);
      expect(failedOf(result)).toEqual([
        {
          objectID: 1001,
          error: `Failed to fetch object 1001: ${rateLimitMessage(120)} ${RATE_LIMIT_RECOVERY}`,
        },
        ...[1006, 1007, 1008].map((objectID) => ({
          objectID,
          error: `Object ${objectID} was not requested. ${rateLimitMessage(120)} ${RATE_LIMIT_RECOVERY}`,
        })),
      ]);
    });

    it('skips only the requested IDs behind the throttle; remainingIDs are never requested (#50)', async () => {
      fetchMock.mockImplementation((request: unknown) => {
        const id = objectIdOf(request);
        if (id === 1001) return throttled();
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ objectID: id, title: `Object ${id}` })), 100);
        });
      });
      const ids = Array.from({ length: 25 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(objectsOf(result)).toEqual([1002, 1003, 1004, 1005]);
      expect(failedOf(result).map((f) => f.objectID)).toEqual([1001, ...ids.slice(5, 20)]);
      expect((result.structuredContent as { remainingIDs?: number[] }).remainingIDs).toEqual(
        ids.slice(20),
      );
    });

    it('names the unrequested over-cap count in the batch-level upstream_rate_limited (#50)', async () => {
      fetchMock.mockImplementation(throttled);
      const ids = Array.from({ length: 25 }, (_, i) => 1001 + i);

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: ids }));

      expectRateLimited(
        result,
        `No object could be fetched. ${rateLimitMessage(120)} The other 5 of 25 distinct object IDs, past the per-call cap of 20, were not requested.`,
        '120',
      );
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('names the throttle over upstream_unavailable when a 5xx outage sits beside it', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001 ? throttled() : serverError(503)(),
      );

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [1001, 1002] }));

      expectRateLimited(result, `No object could be fetched. ${rateLimitMessage(120)}`, '120');
      // 1001's one request and 1002's four-attempt ladder.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('names the throttle over all_failed when a 404 and a network error sit beside it', async () => {
      fetchMock.mockImplementation((request: unknown) => {
        const id = objectIdOf(request);
        if (id === 1001) return Promise.resolve(new Response('{}', { status: 404 }));
        if (id === 1002) return Promise.reject(new TypeError('fetch failed'));
        return throttled();
      });

      const result = await settle(() =>
        runToolContract(metGetObject, { objectIDs: [1001, 1002, 1003] }),
      );

      expectRateLimited(result, `No object could be fetched. ${rateLimitMessage(120)}`, '120');
    });

    it('still ends as upstream_blocked when a 403 sits beside the throttle', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001
          ? Promise.resolve(new Response('<html>Access Denied</html>', { status: 403 }))
          : throttled(),
      );

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [1001, 1002] }));

      expect(errorOf(result).data.reason).toBe('upstream_blocked');
    });

    it('still ends as all_not_found when every ID is a 404', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 404 })));

      const result = await settle(() => runToolContract(metGetObject, { objectIDs: [1001, 1002] }));

      expect(errorOf(result).data.reason).toBe('all_not_found');
    });
  });
});
