/**
 * @fileoverview MET_CLAMP_LIMITS parsing (#57) and `activeServerConfig()`, the
 * read an input schema makes: the parsed config once `getServerConfig()` has run
 * in `setup()`, the schema defaults before then, never the environment.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh config module with MET_CLAMP_LIMITS stubbed (or unset). */
async function loadConfig(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv('MET_CLAMP_LIMITS', value);
  return await import('@/config/server-config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MET_CLAMP_LIMITS', () => {
  it('defaults to true', async () => {
    const { getServerConfig } = await loadConfig(undefined);
    expect(getServerConfig().clampLimits).toBe(true);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['true', true],
    ['1', true],
  ] as const)('reads %s as %s', async (value, expected) => {
    const { getServerConfig } = await loadConfig(value);
    expect(getServerConfig().clampLimits).toBe(expected);
  });

  it.each(['maybe', 'flase', '2'])('rejects %s, naming the variable', async (value) => {
    const { getServerConfig } = await loadConfig(value);
    expect(() => getServerConfig()).toThrow(/MET_CLAMP_LIMITS/);
  });
});

describe('activeServerConfig', () => {
  it('returns the schema defaults before getServerConfig() runs, without reading the environment', async () => {
    const { activeServerConfig } = await loadConfig('maybe');

    expect(activeServerConfig()).toMatchObject({ clampLimits: true, batchConcurrency: 5 });
  });

  it('returns what getServerConfig() parsed once it has run', async () => {
    const { activeServerConfig, getServerConfig } = await loadConfig('false');

    expect(activeServerConfig().clampLimits).toBe(true);
    getServerConfig();
    expect(activeServerConfig().clampLimits).toBe(false);
  });
});
