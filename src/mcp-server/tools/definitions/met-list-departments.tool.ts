/**
 * @fileoverview Tool: met_list_departments — list all 19 Met curatorial departments.
 * @module mcp-server/tools/definitions/met-list-departments
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMetService, startCallDeadline } from '@/services/met/met-service.js';
import { escapeMarkdown } from '@/utils/markdown.js';

export const metListDepartments = tool('met_list_departments', {
  title: 'List Met Departments',
  description:
    'Return the 19 curatorial departments at The Metropolitan Museum of Art, each with its numeric departmentId and display name — the valid values for the departmentId filter on met_search_collections and met_list_objects.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({}),
  output: z.object({
    departments: z
      .array(
        z
          .object({
            departmentId: z
              .number()
              .int()
              .describe(
                'Numeric department ID for the departmentId parameter of met_search_collections and met_list_objects.',
              ),
            displayName: z
              .string()
              .describe(
                'Human-readable department name (e.g., "European Paintings", "Egyptian Art", "Arms and Armor").',
              ),
          })
          .describe('A Met curatorial department.'),
      )
      .describe('All 19 curatorial departments at The Metropolitan Museum of Art.'),
  }),
  errors: [
    {
      reason: 'upstream_blocked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      thrownBy: 'service',
      when: "The Met API's firewall refused the request with HTTP 403 — it blocks this server's address, not one endpoint.",
      recovery: 'Wait several minutes before retrying, and send fewer requests.',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: "The call's time budget ran out, retries and backoff included, before the Met API returned a successful response.",
      recovery:
        "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
    },
  ],

  async handler(_input, ctx) {
    ctx.log.info('Fetching Met departments');
    const departments = await getMetService().getDepartments(ctx, startCallDeadline(ctx.signal));
    return { departments };
  },

  format: (result) => {
    // displayName is upstream text — escaped so it cannot restructure content[].
    const lines = result.departments.map(
      (d) => `- **${d.departmentId}** — ${escapeMarkdown(d.displayName)}`,
    );
    return [{ type: 'text', text: `## Met Departments\n\n${lines.join('\n')}` }];
  },
});
