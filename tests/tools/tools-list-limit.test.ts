/**
 * @fileoverview `limit` as a `tools/list` reply advertises it (#59), for
 * met_search_collections and met_list_objects served through the framework's
 * HTTP handler in process, with the `setup` of `src/index.ts`, in both
 * MET_CLAMP_LIMITS modes and both protocol eras. The schema tests in
 * page-limit.test.ts read `~standard` directly; this file adds the framework's
 * tool registration, the SDK's schema conversion, and the era codec. Its own
 * file: the handler sets `process.env.MCP_TRANSPORT_TYPE` and starts the
 * framework logger for the worker process.
 * @module tests/tools/tools-list-limit.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Era = '2025-11-25' | '2026-07-28';

const ERAS: Era[] = ['2025-11-25', '2026-07-28'];

/** The part of a `tools/list` reply this file reads. */
const ToolsListReply = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
      }),
    ),
  }),
});

/** A JSON-RPC reply body, sent as plain JSON or as one SSE `data:` frame. */
async function replyBody(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const frame = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length);
  return JSON.parse(frame ?? text);
}

/**
 * Each listed tool's `limit` property, by tool name. The modules load fresh
 * under the stubbed env because the server config is parsed once per module
 * instance — by `initMetService()` in `setup`, which is what reads
 * MET_CLAMP_LIMITS.
 */
async function listedLimits(era: Era, clampLimits: 'false' | undefined) {
  vi.resetModules();
  vi.stubEnv('MET_CLAMP_LIMITS', clampLimits);
  const { createWorkerHandler } = await import('@cyanheads/mcp-ts-core/worker');
  const { metListObjects } = await import(
    '@/mcp-server/tools/definitions/met-list-objects.tool.js'
  );
  const { metSearchCollections } = await import(
    '@/mcp-server/tools/definitions/met-search-collections.tool.js'
  );
  const { initMetService } = await import('@/services/met/met-service.js');

  const handler = createWorkerHandler({
    name: 'met-museum-mcp-server',
    title: 'met-museum-mcp-server',
    tools: [metSearchCollections, metListObjects],
    sessionMode: 'stateless',
    setup(core) {
      initMetService(core.config, core.storage);
    },
  });
  type Fetch = Parameters<typeof handler.fetch>;
  const post = (body: unknown, headers: Record<string, string>) =>
    handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': era,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      // The worker starts its logger at this binding's level; info would print every init step.
      { LOG_LEVEL: 'error' } as Fetch[1],
      {} as Fetch[2],
    );

  let reply: unknown;
  if (era === '2026-07-28') {
    reply = await replyBody(
      await post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': era,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        },
        { 'Mcp-Method': 'tools/list' },
      ),
    );
  } else {
    await replyBody(
      await post(
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: era,
            capabilities: {},
            clientInfo: { name: 'tools-list-limit-test', version: '0' },
          },
        },
        {},
      ),
    );
    reply = await replyBody(await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}));
  }
  const { tools } = ToolsListReply.parse(reply).result;
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.properties.limit]));
}

/** What both modes advertise for `limit`, besides the maximum. */
const LIMIT_BASE = { type: 'integer', minimum: 1, default: 20 };

describe('limit in a tools/list reply (#59)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(ERAS)('advertises maximum 500 under MET_CLAMP_LIMITS=false (%s)', async (era) => {
    const limits = await listedLimits(era, 'false');
    expect(limits.met_search_collections).toMatchObject({ ...LIMIT_BASE, maximum: 500 });
    expect(limits.met_list_objects).toMatchObject({ ...LIMIT_BASE, maximum: 500 });
  });

  it.each(ERAS)('advertises no maximum with MET_CLAMP_LIMITS unset (%s)', async (era) => {
    const limits = await listedLimits(era, undefined);
    for (const name of ['met_search_collections', 'met_list_objects']) {
      expect(limits[name], name).toMatchObject(LIMIT_BASE);
      expect(limits[name], name).not.toHaveProperty('maximum');
    }
  });
});
