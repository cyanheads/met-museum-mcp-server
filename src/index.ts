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
  sessionMode: 'stateless',
  instructions: [
    'The Metropolitan Museum of Art Collection API — 501,731 artworks spanning 5,000 years.',
    'Typical workflow: met_list_departments → met_search_collections (returns IDs) → met_get_object (full records, up to 20 per call).',
    'Every met_search_collections filter draws on a partial index: a filtered search omits some objects whose own record satisfies the filter, so absence from the results proves nothing — drop the filter to widen, and confirm the attribute per object with met_get_object. A filtered search is also checked against the same query run unfiltered, so its results match the keyword; that check is best-effort, and a response whose check could not complete says so in its notice.',
    'isPublicDomain and isHighlight accept true only. hasImages=true includes copyrighted works without usable image URLs.',
    'The medium filter maps to classification categories ("Paintings", "Sculptures") — not material descriptions.',
  ].join('\n'),
  setup(core) {
    initMetService(core.config, core.storage);
  },
});
