# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-20

Maintenance: adopt @cyanheads/mcp-ts-core ^0.10.9 — re-sync vendored devcheck scripts and skills, enable plugin-manifest packaging checks

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-12

Maintenance: adopt @cyanheads/mcp-ts-core ^0.10.6, reclassify invalid_date_range as ValidationError, add Docker HEALTHCHECK and .mcpb cleanup

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-08 · ⚠️ Breaking

BREAKING: met_search renamed to met_search_collections; adds isOnView filter to restrict results to works currently on display

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-04 · ⚠️ Breaking

BREAKING: met_get_object renames hasImages → hasCC0Image; adds all_not_found error distinguishing 404s from network failures

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-02

Public hosted endpoint at met-museum.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-01

Public launch — Met Museum collection search, object fetch, and department listing via MCP

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-31

Initial release — MET Museum MCP server scaffolded on @cyanheads/mcp-ts-core
