/**
 * @fileoverview Server-specific configuration for the Met Museum MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('https://collectionapi.metmuseum.org/public/collection')
    .describe(
      'Met Collection API root; each endpoint appends its own version (/v1.1/search, /v1/objects, /v1/departments). A value ending in /v1 or /v1.1 is read as its root. Override for local stubs in tests.',
    ),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000)
    .describe('Per-request timeout in milliseconds.'),
  batchConcurrency: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Max parallel fetches in met_get_object.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'MET_BASE_URL',
    requestTimeoutMs: 'MET_REQUEST_TIMEOUT_MS',
    batchConcurrency: 'MET_BATCH_CONCURRENCY',
  });
  return _config;
}
