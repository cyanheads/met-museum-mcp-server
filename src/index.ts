#!/usr/bin/env node
/**
 * @fileoverview met-museum-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { metGetObject } from './mcp-server/tools/definitions/met-get-object.tool.js';
import { metListDepartments } from './mcp-server/tools/definitions/met-list-departments.tool.js';
import { metSearchCollections } from './mcp-server/tools/definitions/met-search-collections.tool.js';
import { initMetService } from './services/met/met-service.js';

await createApp({
  name: 'met-museum-mcp-server',
  title: 'met-museum-mcp-server',
  tools: [metListDepartments, metSearchCollections, metGetObject],
  resources: [],
  prompts: [],
  instructions: [
    'The Metropolitan Museum of Art Collection API — 501,731 artworks spanning 5,000 years.',
    'Typical workflow: met_list_departments → met_search_collections (returns IDs) → met_get_object (full records, up to 20 per call).',
    'isPublicDomain=true guarantees CC0 open-access images; hasImages=true includes copyrighted works without usable image URLs.',
    'The medium filter maps to classification categories ("Paintings", "Sculptures") — not material descriptions.',
  ].join('\n'),
  setup(core) {
    initMetService(core.config, core.storage);
  },
});
