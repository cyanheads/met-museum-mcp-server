/**
 * @fileoverview Tests for met_list_departments tool.
 * @module tests/tools/met-list-departments.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metListDepartments } from '@/mcp-server/tools/definitions/met-list-departments.tool.js';

vi.mock('@/services/met/met-service.js', () => ({
  getMetService: () => ({
    getDepartments: vi.fn().mockResolvedValue([
      { departmentId: 11, displayName: 'European Paintings' },
      { departmentId: 10, displayName: 'Egyptian Art' },
    ]),
  }),
}));

describe('metListDepartments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns departments from the service', async () => {
    const ctx = createMockContext();
    const input = metListDepartments.input.parse({});
    const result = await metListDepartments.handler(input, ctx);
    expect(result.departments).toHaveLength(2);
    expect(result.departments[0]).toEqual({ departmentId: 11, displayName: 'European Paintings' });
  });

  it('format renders department IDs and names', () => {
    const blocks = metListDepartments.format!({
      departments: [
        { departmentId: 11, displayName: 'European Paintings' },
        { departmentId: 10, displayName: 'Egyptian Art' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('11');
    expect(text).toContain('European Paintings');
    expect(text).toContain('10');
    expect(text).toContain('Egyptian Art');
  });
});
