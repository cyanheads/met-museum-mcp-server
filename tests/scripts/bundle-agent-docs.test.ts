/**
 * @fileoverview Tests for the `.mcpb` agent-doc boundary shared by
 * `scripts/clean-mcpb.ts` (the strip) and `scripts/lint-packaging.ts` (check 8):
 * dependency-shipped agent docs go, runtime modules nested under a package —
 * the MCP SDK's `dist/ext/skills/`, which the framework imports at startup —
 * and the server's own root `skills/` stay.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL so `tsc` never follows the import: the shipped script's
 * fallback `import('../src/mcp-server/skills.js')` resolves only inside the
 * framework's own repository (cyanheads/mcp-ts-core#797).
 */
const { checkBundleEntries } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

describe('bundle agent-doc boundary', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/runtime/dist/skills/index.js',
    'node_modules/@scope/skills/index.js',
    'skills/example-guide/SKILL.md',
  ])('keeps the runtime or published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/package/skills/guide/SKILL.md',
    'node_modules/package/skills/guide/references/notes.md',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/outer/node_modules/@scope/package/skills/guide/SKILL.md',
    'node_modules/outer/node_modules/package/.claude/settings.json',
    'node_modules/package/.agents/guide.md',
    'node_modules/package/docs/SKILL.md',
  ])('strips the dependency agent doc %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toHaveLength(1);
  });
});
