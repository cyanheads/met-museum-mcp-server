/**
 * @fileoverview The `limit` input shared by met_search_collections and
 * met_list_objects. A value above the 500-ID page is read as one 500-ID page and
 * counted, or, with MET_CLAMP_LIMITS=false, rejected at the schema.
 * @module mcp-server/tools/page-limit
 */

import { z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { activeServerConfig } from '@/config/server-config.js';
import { PAGE_MAX_IDS } from '@/services/met/met-service.js';

/** The tools whose `limit` reads one page of at most `PAGE_MAX_IDS` IDs. */
type PageLimitTool = 'met_list_objects' | 'met_search_collections';

/** None while MET_CLAMP_LIMITS is on (the default); the page size while it is off. */
const maximum = () => (activeServerConfig().clampLimits ? undefined : PAGE_MAX_IDS);

/**
 * A `limit` input, default 20 and minimum 1, whose maximum follows
 * MET_CLAMP_LIMITS. A `.check()` enforces it on each parse and `.meta()` getters
 * advertise it, with the matching description, on each JSON Schema emission (the
 * SDK converts input schemas on every `tools/list`), so both read the config
 * `setup()` parsed, or the defaults before then. The `maximum` getter's
 * `undefined` also keeps `.int()`'s safe-integer bound out of the emitted schema.
 */
export function pageLimitInput(describe: (clamped: boolean) => string) {
  return z
    .number()
    .int()
    .min(1)
    .check((payload) => {
      const max = maximum();
      if (max !== undefined && payload.value > max) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: max,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .default(20)
    .meta({
      get maximum() {
        return maximum();
      },
      get description() {
        return describe(activeServerConfig().clampLimits);
      },
    });
}

/** Created on the first clamp: the global meter is a no-op until `createApp()` starts OTel, after `setup()`. */
let clampedCounter: ReturnType<typeof createCounter> | undefined;

/**
 * The `limit` a page is read with: the caller's, or `PAGE_MAX_IDS` for a larger
 * one, which adds 1 to `met.limit.clamped` for `tool`. The tool's info log line
 * records both values, so a clamp needs no line of its own.
 */
export function servePageLimit(limit: number, tool: PageLimitTool): number {
  if (limit <= PAGE_MAX_IDS) return limit;
  clampedCounter ??= createCounter(
    'met.limit.clamped',
    'Tool calls whose limit above the 500-ID page was read as a 500-ID page',
    '{calls}',
  );
  clampedCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  return PAGE_MAX_IDS;
}
