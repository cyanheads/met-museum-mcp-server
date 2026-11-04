/**
 * @fileoverview The shared `limit` mechanism of met_search_collections and
 * met_list_objects (#57), tabled once at its seam: the schema in both
 * MET_CLAMP_LIMITS modes, the JSON Schema it emits, and the clamp with its
 * counter. Each case loads the modules fresh so the config is parsed the way
 * `setup()` parses it, after import; the per-tool suites prove only the wiring.
 * @module tests/tools/page-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CounterAdd {
  attributes: unknown;
  name: string;
  value: number;
}

/**
 * Fresh `server-config` and `page-limit` modules, with `createCounter` recording
 * what it creates and adds. `MET_CLAMP_LIMITS` is stubbed before the import;
 * `setup` parses the config after it, as `createApp()` runs `setup()` after the
 * tool modules load — left false, the config stays unparsed.
 */
async function load({ env, setup = true }: { env?: string | undefined; setup?: boolean } = {}) {
  vi.resetModules();
  if (env !== undefined) vi.stubEnv('MET_CLAMP_LIMITS', env);
  const created: string[] = [];
  const added: CounterAdd[] = [];
  vi.doMock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
    createCounter: (name: string) => {
      created.push(name);
      return {
        add: (value: number, attributes: unknown) => added.push({ name, value, attributes }),
      };
    },
  }));
  const config = await import('@/config/server-config.js');
  const pageLimit = await import('@/mcp-server/tools/page-limit.js');
  const limit = pageLimit.pageLimitInput((clamped) => (clamped ? 'clamp mode' : 'strict mode'));
  const runSetup = () => config.getServerConfig();
  if (setup) runSetup();
  return { ...pageLimit, added, created, limit, runSetup };
}

/** The `limit` property as `tools/list` advertises it: the SDK reads the schema through `~standard`. */
const advertised = (limit: z.ZodType) => {
  const { properties } = z.object({ limit })['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  });
  return (properties as Record<string, unknown>).limit;
};

afterEach(() => {
  vi.doUnmock('@cyanheads/mcp-ts-core/utils');
  vi.unstubAllEnvs();
});

describe('pageLimitInput', () => {
  const modes = [
    ['clamp (MET_CLAMP_LIMITS unset)', undefined],
    ['strict (MET_CLAMP_LIMITS=false)', 'false'],
  ] as const;

  it.each([
    [undefined, 1, true],
    [undefined, 500, true],
    [undefined, 501, true],
    [undefined, 10_001, true],
    [undefined, 40_000, true],
    ['false', 1, true],
    ['false', 500, true],
    ['false', 501, false],
    ['false', 10_001, false],
  ] as const)(
    'MET_CLAMP_LIMITS=%s: limit %i accepted = %s, the value unchanged',
    async (env, value, ok) => {
      const { limit } = await load({ env });

      const result = limit.safeParse(value);

      expect(result.success).toBe(ok);
      if (result.success) expect(result.data).toBe(value);
      else
        expect(result.error.issues).toEqual([
          expect.objectContaining({ code: 'too_big', maximum: 500, inclusive: true }),
        ]);
    },
  );

  it.each(modes)('%s: still rejects 0, -1, 1.5, "abc", and true', async (_label, env) => {
    const { limit } = await load({ env });

    for (const value of [0, -1, 1.5, 'abc', true]) {
      expect(limit.safeParse(value).success, `limit ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it.each(modes)('%s: defaults an absent limit to 20', async (_label, env) => {
    const { limit } = await load({ env });
    expect(limit.parse(undefined)).toBe(20);
  });

  it('clamp mode advertises minimum 1 and default 20 with no maximum key at all', async () => {
    const { limit } = await load();

    // Exact: `.int()` alone would emit `maximum: 9007199254740991`.
    expect(advertised(limit)).toEqual({
      type: 'integer',
      minimum: 1,
      default: 20,
      description: 'clamp mode',
    });
    expect(limit.description).toBe('clamp mode');
  });

  it('strict mode advertises maximum 500 and its own description', async () => {
    const { limit } = await load({ env: 'false' });

    expect(advertised(limit)).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      default: 20,
      description: 'strict mode',
    });
    expect(limit.description).toBe('strict mode');
  });

  it('reads the config on each parse and emission: the same schema turns strict once setup() parses MET_CLAMP_LIMITS=false', async () => {
    const { limit, runSetup } = await load({ env: 'false', setup: false });

    // Before setup(): the schema defaults, whatever the environment holds.
    expect(advertised(limit)).not.toHaveProperty('maximum');
    expect(limit.safeParse(501).success).toBe(true);

    runSetup();

    expect(advertised(limit)).toHaveProperty('maximum', 500);
    expect(limit.description).toBe('strict mode');
    expect(limit.safeParse(501).success).toBe(false);
  });

  it('never parses the environment at import or emission: an invalid MET_CLAMP_LIMITS reads as the default until setup()', async () => {
    const { limit, runSetup } = await load({ env: 'maybe', setup: false });

    expect(advertised(limit)).not.toHaveProperty('maximum');
    expect(limit.safeParse(40_000).success).toBe(true);
    expect(runSetup).toThrow(/MET_CLAMP_LIMITS/);
  });
});

describe('servePageLimit', () => {
  it('returns a limit at or under 500 as is, and creates no counter', async () => {
    const { servePageLimit, created, added } = await load();

    expect(servePageLimit(1, 'met_search_collections')).toBe(1);
    expect(servePageLimit(500, 'met_list_objects')).toBe(500);
    expect(created).toEqual([]);
    expect(added).toEqual([]);
  });

  it('reads a limit above 500 as 500 and adds 1 to met.limit.clamped for the tool', async () => {
    const { servePageLimit, created, added } = await load();

    expect(servePageLimit(501, 'met_search_collections')).toBe(500);
    expect(servePageLimit(10_001, 'met_list_objects')).toBe(500);
    expect(servePageLimit(40_000, 'met_list_objects')).toBe(500);

    expect(created).toEqual(['met.limit.clamped']);
    expect(added).toEqual([
      {
        name: 'met.limit.clamped',
        value: 1,
        attributes: { 'mcp.tool.name': 'met_search_collections' },
      },
      { name: 'met.limit.clamped', value: 1, attributes: { 'mcp.tool.name': 'met_list_objects' } },
      { name: 'met.limit.clamped', value: 1, attributes: { 'mcp.tool.name': 'met_list_objects' } },
    ]);
  });

  it('creates the counter on the first clamp, not at import: the meter is a no-op until after setup()', async () => {
    const { servePageLimit, created } = await load();

    expect(created).toEqual([]);
    servePageLimit(600, 'met_search_collections');
    expect(created).toEqual(['met.limit.clamped']);
  });
});
