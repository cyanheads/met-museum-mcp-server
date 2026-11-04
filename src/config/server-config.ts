/**
 * @fileoverview Server-specific configuration for the Met Museum MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** The largest delay a timer accepts; past it, the timer overflows and fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
    .max(MAX_TIMER_DELAY_MS)
    .default(10_000)
    .describe('Per-request timeout in milliseconds.'),
  callDeadlineMs: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(30_000)
    .describe(
      "Wall-clock budget in milliseconds for one tool call, shared by every Met API request the call makes — retries and backoff included. Each request's timeout is capped by what remains of it.",
    ),
  batchConcurrency: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Max parallel fetches in met_get_object.'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Reads a limit above the 500-ID page on met_search_collections and met_list_objects as a 500-ID page, with a notice to continue from nextOffset, instead of rejecting it. False advertises and enforces 500 as the schema maximum.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Every field at its default: the config before `setup()` parses the environment. */
const SCHEMA_DEFAULTS: ServerConfig = ServerConfigSchema.parse({});

let _config: ServerConfig | undefined;

/**
 * The server config, parsed from the environment once. `setup()` reaches it
 * first, through `initMetService()`, after `createApp()` has loaded `.env`, so
 * an invalid value stops startup with the banner naming the variable. Never
 * call it at module import: a `ConfigurationError` thrown there exits on a raw
 * stack trace, and under Node `.env` is not loaded yet.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'MET_BASE_URL',
    requestTimeoutMs: 'MET_REQUEST_TIMEOUT_MS',
    callDeadlineMs: 'MET_CALL_DEADLINE_MS',
    batchConcurrency: 'MET_BATCH_CONCURRENCY',
    clampLimits: 'MET_CLAMP_LIMITS',
  });
  return _config;
}

/**
 * The config an input schema reads when it validates or is emitted: what
 * `getServerConfig()` parsed, or the schema defaults before it runs. Never
 * parses the environment, since `tool()` emits every input schema when its
 * definition module is imported.
 */
export function activeServerConfig(): ServerConfig {
  return _config ?? SCHEMA_DEFAULTS;
}
