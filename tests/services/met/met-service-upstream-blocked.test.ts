/**
 * @fileoverview A 403 from the Met API (#31). The API takes no credentials, so a
 * 403 is its firewall refusing this server: `MetService` classifies it as
 * `upstream_blocked`, never retried, and every tool surfaces that reason and its
 * wait-and-slow-down recovery on both client surfaces. Runs the real service —
 * `fetchWithTimeout`'s status mapping and the retry ladder included — over a
 * faked global fetch.
 * @module tests/services/met/met-service-upstream-blocked.test
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

/** The block page the Met's firewall serves in place of every endpoint. */
const BLOCK_PAGE =
  '<!DOCTYPE html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>Reference #18.4c2d3217.1759213200.1a2b3c4d</p></body></html>';

/** A 403 exchange with the HTML block page, minted per call. */
const blocked = () =>
  Promise.resolve(
    new Response(BLOCK_PAGE, {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'text/html' },
    }),
  );

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** The object ID a `/v1/objects/{id}` request names. */
const objectIdOf = (request: unknown) =>
  Number(new URL(String(request)).pathname.slice(OBJECTS_PATH.length));

/** A plain-deadline call bound for service-level cases. */
function call() {
  const ctx = createMockContext();
  return [ctx, { deadlineAt: Date.now() + 30_000, signal: ctx.signal }] as const;
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

const FIREWALL = "The Met API's firewall is refusing requests from this server";

/** The upstream_blocked envelope, on both surfaces, as every tool must deliver it. */
function expectBlocked(result: ToolResult): ErrorEnvelope {
  const error = errorOf(result);
  expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect(error.data.reason).toBe('upstream_blocked');
  expect(error.data.retryable).toBe(false);
  expect(error.message).toContain(FIREWALL);
  const hint = error.data.recovery?.hint ?? '';
  expect(hint).toContain('Wait several minutes');
  expect(hint).toContain('fewer requests');
  expect(hint).not.toContain('brief delay');
  // The block page stays out of the client-visible data.
  expect(JSON.stringify(error)).not.toContain('Access Denied');

  const text = textOf(result);
  expect(text).toContain(FIREWALL);
  expect(text).toContain(hint);
  expect(text).toContain('reason upstream_blocked');
  expect(text).toContain('not retryable');
  return error;
}

describe('a 403 from the Met API (#31)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initMetService({} as AppConfig, createInMemoryStorage());
    fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('MetService classifies it as upstream_blocked and does not retry it', () => {
    it.each([
      ['getObject', () => getMetService().getObject(436535, ...call())],
      ['search', () => getMetService().search({ q: 'horse', limit: 20 }, ...call())],
      [
        'listObjects',
        () => getMetService().listObjects({ departmentId: 10, limit: 20 }, ...call()),
      ],
      ['getDepartments', () => getMetService().getDepartments(...call())],
      ['getValidDepartmentIds', () => getMetService().getValidDepartmentIds(...call())],
    ])('%s', async (_name, run) => {
      fetchMock.mockImplementation(blocked);

      const err = await run().catch((e: unknown) => e);

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_blocked', retryable: false },
      });
      expect((err as Error).message).toContain(FIREWALL);
      expect(JSON.stringify((err as { data: unknown }).data)).not.toContain('Access Denied');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the keyword-only count best-effort: a 403 there degrades the zero-match count to null', async () => {
      fetchMock.mockImplementation(blocked);
      expect(await getMetService().countKeywordMatches('horse', ...call())).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('every tool surfaces the reason on both client surfaces', () => {
    it('met_list_departments', async () => {
      fetchMock.mockImplementation(blocked);
      expectBlocked(await runToolContract(metListDepartments, {}));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_search_collections', async () => {
      fetchMock.mockImplementation(blocked);
      expectBlocked(await runToolContract(metSearchCollections, { q: 'horse' }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_search_collections when the blocked request is the departmentId lookup', async () => {
      fetchMock.mockImplementation(blocked);
      expectBlocked(await runToolContract(metSearchCollections, { q: 'horse', departmentId: 11 }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_list_objects', async () => {
      fetchMock.mockImplementation(blocked);
      expectBlocked(await runToolContract(metListObjects, { updatedSince: '2026-09-01' }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_list_objects when the blocked request is the departmentId lookup', async () => {
      fetchMock.mockImplementation(blocked);
      expectBlocked(await runToolContract(metListObjects, { departmentId: 10 }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('met_get_object, one ID', async () => {
      fetchMock.mockImplementation(blocked);
      const error = expectBlocked(await runToolContract(metGetObject, { objectIDs: [436535] }));
      expect(error.message).toContain('No object could be fetched');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('met_get_object batches', () => {
    it('names upstream_blocked at the batch level when every ID was refused, one request each', async () => {
      fetchMock.mockImplementation(blocked);
      expectBlocked(await runToolContract(metGetObject, { objectIDs: [1001, 1002, 1003] }));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('names upstream_blocked when nothing was fetched and any failure was the block', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001
          ? Promise.resolve(new Response('{"message":"ObjectID not found"}', { status: 404 }))
          : blocked(),
      );
      expectBlocked(await runToolContract(metGetObject, { objectIDs: [1001, 1002] }));
    });

    it('puts the block and its recovery in failed[] on a partial success, not "brief delay"', async () => {
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001
          ? Promise.resolve(jsonResponse({ objectID: 1001, title: 'Answered' }))
          : blocked(),
      );

      const result = await runToolContract(metGetObject, { objectIDs: [1001, 1002] });

      expect(result.isError).toBeFalsy();
      const failed = (result.structuredContent as { failed: { objectID: number; error: string }[] })
        .failed;
      expect(failed.map((f) => f.objectID)).toEqual([1002]);
      const [entry] = failed;
      expect(entry?.error).toContain(`Failed to fetch object 1002: ${FIREWALL} (HTTP 403).`);
      expect(entry?.error).toContain('Wait several minutes');
      expect(entry?.error).toContain('fewer requests');
      expect(entry?.error).not.toContain('brief delay');
      expect(entry?.error).not.toContain('..');
      expect(textOf(result)).toContain(`**1002:** ${entry?.error}`);
    });

    it('sends no request for the IDs queued behind the block', async () => {
      fetchMock.mockImplementation(blocked);
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);

      expectBlocked(await runToolContract(metGetObject, { objectIDs: ids }));
      // The first wave's five requests meet the block; the three IDs queued
      // behind it send nothing.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('lists the IDs queued behind the block in failed[] with its recovery, unrequested', async () => {
      // 1001 answers after the other four first-wave requests are refused, so its
      // worker picks up 1006 with the block already known.
      fetchMock.mockImplementation((request: unknown) =>
        objectIdOf(request) === 1001
          ? new Promise<Response>((resolve) => {
              setTimeout(() => resolve(jsonResponse({ objectID: 1001, title: 'Answered' })), 20);
            })
          : blocked(),
      );
      const ids = Array.from({ length: 8 }, (_, i) => 1001 + i);

      const result = await runToolContract(metGetObject, { objectIDs: ids });

      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(fetchMock.mock.calls.map((c) => objectIdOf(c[0]))).not.toContain(1006);
      const failed = (result.structuredContent as { failed: { objectID: number; error: string }[] })
        .failed;
      expect(failed.map((f) => f.objectID)).toEqual([1002, 1003, 1004, 1005, 1006, 1007, 1008]);
      const byId = new Map(failed.map((f) => [f.objectID, f.error]));
      for (const id of [1006, 1007, 1008]) {
        const error = byId.get(id) ?? '';
        expect(error).toContain(`Object ${id} was not requested`);
        expect(error).toContain('(HTTP 403)');
        expect(error).toContain('Wait several minutes');
        expect(error).not.toContain('brief delay');
      }
      expect(textOf(result)).toContain(`**1008:** ${byId.get(1008)}`);
    });

    it('keeps all_not_found when every ID is a 404 and none was refused', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('{"message":"ObjectID not found"}', { status: 404 })),
      );
      expect(errorOf(await runToolContract(metGetObject, { objectIDs: [1001] })).data.reason).toBe(
        'all_not_found',
      );
    });
  });
});
