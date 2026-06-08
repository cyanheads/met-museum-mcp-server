/**
 * @fileoverview Tool: met_list_departments — list all 19 Met curatorial departments.
 * @module mcp-server/tools/definitions/met-list-departments
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMetService } from '@/services/met/met-service.js';

export const metListDepartments = tool('met_list_departments', {
  title: 'List Met Departments',
  description:
    'Return the 19 curatorial departments at The Metropolitan Museum of Art with their numeric IDs and display names. ' +
    'Use before calling met_search_collections to discover valid departmentId values. ' +
    'The department list is fetched live on each call to remain accurate if the Met reorganizes.',
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
                'Numeric department ID for use in the met_search_collections departmentId parameter.',
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

  async handler(_input, ctx) {
    ctx.log.info('Fetching Met departments');
    const departments = await getMetService().getDepartments(ctx);
    return { departments };
  },

  format: (result) => {
    const lines = result.departments.map((d) => `- **${d.departmentId}** — ${d.displayName}`);
    return [{ type: 'text', text: `## Met Departments\n\n${lines.join('\n')}` }];
  },
});
