#!/usr/bin/env node
/**
 * @fileoverview met-museum-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { metGetObject } from './mcp-server/tools/definitions/met-get-object.tool.js';
import { metListDepartments } from './mcp-server/tools/definitions/met-list-departments.tool.js';
import { metListObjects } from './mcp-server/tools/definitions/met-list-objects.tool.js';
import { metSearchCollections } from './mcp-server/tools/definitions/met-search-collections.tool.js';
import { initMetService } from './services/met/met-service.js';

await createApp({
  name: 'met-museum-mcp-server',
  title: 'met-museum-mcp-server',
  tools: [metListDepartments, metSearchCollections, metListObjects, metGetObject],
  resources: [],
  prompts: [],
  sessionMode: 'stateless',
  instructions: [
    'The Metropolitan Museum of Art Collection API — over 500,000 artworks spanning 5,000 years.',
    'Typical workflow: met_list_departments → met_search_collections (returns IDs) → met_get_object (full records, up to 20 per call).',
    'To browse without a keyword, met_list_objects lists every object ID in one department (departmentId), every object created or revised on or after a date (updatedSince, YYYY-MM-DD), or both — in ascending ID order, with no paging depth limit.',
    'met_search_collections pages through at most the first 10,000 matches of a search; narrow a larger one with filters. CC0 status is per object, from the isPublicDomain field on met_get_object — hasImages=true includes copyrighted works without usable image URLs. isHighlight accepts true only.',
    'The medium filter takes a case-sensitive classification as the Met spells it ("Paintings", "Sculpture") — not a material description.',
  ].join('\n'),
  setup(core) {
    initMetService(core.config, core.storage);
  },
});
