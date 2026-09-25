/**
 * @fileoverview `MET_BASE_URL` resolution: the collection-root default and a
 * `/v1`- or `/v1.1`-suffixed override resolve every endpoint to the same URL,
 * each endpoint carrying its own API version. Each case re-imports the service so
 * config parsing runs against the stubbed environment.
 * @module tests/services/met/met-service-base-url.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** The body each endpoint answers with, keyed by the pathname's last segment(s). */
function answer(url: URL): Response {
  if (url.pathname.endsWith('/v1.1/search')) return jsonResponse({ total: 1, objectIDs: [436535] });
  if (url.pathname.endsWith('/v1/objects/436535')) return jsonResponse({ objectID: 436535 });
  if (url.pathname.endsWith('/v1/departments')) return jsonResponse({ departments: [] });
  throw new Error(`unrouted fetch ${url.origin}${url.pathname}`);
}

describe('MET_BASE_URL resolution', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Load a fresh service under `baseUrl` (unset = the default) and hit every endpoint once. */
  async function requestedUrls(baseUrl: string | undefined): Promise<string[]> {
    vi.resetModules();
    vi.stubEnv('MET_BASE_URL', baseUrl);
    const { getMetService, initMetService } = await import('@/services/met/met-service.js');
    initMetService({} as AppConfig, createInMemoryStorage());
    fetchMock.mockImplementation((request: unknown) =>
      Promise.resolve(answer(new URL(String(request)))),
    );

    const ctx = createMockContext();
    const service = getMetService();
    await service.search({ q: 'cat', limit: 5 }, ctx);
    await service.getObject(436535, ctx);
    await service.getDepartments(ctx);

    return fetchMock.mock.calls.map((call) => {
      const url = new URL(String(call[0]));
      return `${url.origin}${url.pathname}`;
    });
  }

  const DEFAULT_URLS = [
    'https://collectionapi.metmuseum.org/public/collection/v1.1/search',
    'https://collectionapi.metmuseum.org/public/collection/v1/objects/436535',
    'https://collectionapi.metmuseum.org/public/collection/v1/departments',
  ];

  it('defaults to the collection root, with each endpoint on its own version', async () => {
    expect(await requestedUrls(undefined)).toEqual(DEFAULT_URLS);
  });

  it.each([
    'https://collectionapi.metmuseum.org/public/collection/v1',
    'https://collectionapi.metmuseum.org/public/collection/v1/',
    'https://collectionapi.metmuseum.org/public/collection/',
    'https://collectionapi.metmuseum.org/public/collection/v1.1',
    'https://collectionapi.metmuseum.org/public/collection/v1.1/',
  ])('resolves the override %s exactly as the default', async (baseUrl) => {
    expect(await requestedUrls(baseUrl)).toEqual(DEFAULT_URLS);
  });

  it('hangs the version paths off a suffix-less local stub', async () => {
    expect(await requestedUrls('http://127.0.0.1:3494')).toEqual([
      'http://127.0.0.1:3494/v1.1/search',
      'http://127.0.0.1:3494/v1/objects/436535',
      'http://127.0.0.1:3494/v1/departments',
    ]);
  });
});
