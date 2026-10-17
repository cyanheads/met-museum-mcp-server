<div align="center">
  <h1>@cyanheads/met-museum-mcp-server</h1>
  <p><b>Search the Metropolitan Museum of Art collection, browse it by department or update date, fetch full artwork records and open-access images via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/met-museum-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/met-museum-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/met-museum-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/met-museum-mcp-server/releases/latest/download/met-museum-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=met-museum-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWV0LW11c2V1bS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22met-museum-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmet-museum-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://met-museum.caseyjhand.com/mcp](https://met-museum.caseyjhand.com/mcp)

</div>

---

## Overview

The Metropolitan Museum of Art's collection of 500,000+ works spanning 5,000 years. Search by keyword and filters, browse by department, and fetch full object records with provenance and CC0 open-access images.

### Tools

| Tool | Description |
|:---|:---|
| `met_list_departments` | Return all 19 curatorial departments with their numeric IDs and display names |
| `met_search_collections` | Search the collection by keyword, optionally matched in titles or tags only, with filters for department, date range, medium, geography, image availability, on-view status, and highlight designation |
| `met_list_objects` | List every object ID in a department, every object created or revised since a date, or both, without a keyword |
| `met_get_object` | Fetch full records for one or more object IDs — metadata, provenance, artist info, CC0 image URLs, tags, and Wikidata links — optionally with up to 3 CC0 images as image content |

## Capability reference

### `met_list_departments` <sub>tool</sub>

- No input; returns all 19 curatorial departments, each a numeric `departmentId` with its `displayName` (e.g., "Egyptian Art")
- `departmentId` values are the valid input for the `departmentId` filter on `met_search_collections` and `met_list_objects`
- Typed errors: `upstream_blocked`, `upstream_unavailable` (the Met answered 500/502/503/504 through every retry), `upstream_rate_limited` (the Met answered 429), and `retry_deadline_exceeded` (the call's time budget ran out)

---

### `met_search_collections` <sub>tool</sub>

- Keyword `q` (required), matched across all text fields unless `matchField` narrows it to `"title"` or `"tags"`; `"*"` matches everything, for a search by filters alone. Filters: `departmentId`, `medium` (case-sensitive, e.g. `"Paintings"`), `dateBegin`/`dateEnd` (integer years, negative = BCE, set together), one `geoLocation`, `hasImages`, `isOnView`, and `isHighlight` (`true` only)
- Up to 500 IDs per page (default 20), paged by `offset` / `nextOffset` through the first 10,000 matches; `total` reports the full count. `departmentId` 7 (The Cloisters) and 17 (Medieval Art) share one result set at the Met, so a page can hold fewer than `limit` IDs, which a `notice` flags
- Zero matches is a result with a `notice`, not an error; every result echoes the applied query as `effectiveQuery`. Typed errors: `invalid_date_range`, `invalid_filter` (a blank `q`, `medium`, or `geoLocation`), `invalid_department`, `upstream_blocked`, `upstream_unavailable`, `upstream_rate_limited`, `retry_deadline_exceeded`

---

### `met_list_objects` <sub>tool</sub>

- Filters `departmentId` (from `met_list_departments`) and `updatedSince` (`YYYY-MM-DD`, records created or revised on or after that day), alone or together; with neither, the whole collection (over 500,000 IDs). Up to 500 IDs per page (default 20) in ascending order, paged by `offset` / `nextOffset` with no depth limit
- An empty list is a result with a `notice`, not an error; every result echoes the applied filters as `effectiveQuery`. Typed errors: `invalid_department`, `invalid_date` (an impossible date such as `2026-02-30`), `upstream_blocked`, `upstream_unavailable`, `upstream_rate_limited`, `retry_deadline_exceeded`
- Lists are cached for up to an hour, so a record revised in the last hour may not appear yet

---

### `met_get_object` <sub>tool</sub>

- Fetches 20 distinct IDs per call, from `met_search_collections` or `met_list_objects`; a list of up to 500 is accepted, and the IDs past the first 20 come back in `remainingIDs`. The index can list IDs the Met no longer serves, so drop an ID that 404s
- Partial success: per-ID errors land in `failed[]`, and the call fails only when every ID does (`all_not_found`, `upstream_blocked`, `upstream_rate_limited`, `retry_deadline_exceeded`, `upstream_unavailable`, or `all_failed`). Records past a 60,000-byte `structuredContent` budget are listed in `deferred[]` with their sizes, to re-request
- Non-public-domain objects (`isPublicDomain` / `hasCC0Image`) return empty `primaryImage`, `primaryImageSmall`, and `additionalImages`. `includeImages: true` attaches the CC0 image (about 600 px) of the first 3 records that have one as image content in `content[]` only, with each record's outcome in `images[]`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Met Museum-specific:

- 500K+ artworks spanning 5,000 years from the Met's public collection API
- CC0 open-access data from [The Metropolitan Museum of Art](https://www.metmuseum.org/) — free to use without permission or attribution
- Parallel batch fetching with configurable concurrency for `met_get_object`
- Linked data on every object — Getty ULAN and AAT URLs, Wikidata entity URLs for artists, tags, and works
- Met API failures surface on every tool as typed errors (`upstream_blocked` for a 403 firewall block, `upstream_unavailable` for 5xx, `upstream_rate_limited` for 429), never as the Met's raw error page
- `met_get_object` stops requesting the rest of a batch once the Met is blocking, down, or throttling, so a bad batch costs only a few requests

Agent-friendly output:

- Provenance on every record: `isPublicDomain` and `hasCC0Image` flags show which images can be displayed
- Partial failure reporting: `met_get_object` returns `objects` and `failed` arrays, so successes arrive alongside per-ID errors
- Truncation signaling: `met_search_collections` and `met_list_objects` return `total`, `returned`, `truncated`, `remaining`, `nextOffset`, and the resolved `offset`
- Byte-budget disclosure: `met_get_object` lists `deferred[]` records with their sizes when a batch is too large

## Getting started

### Public Hosted Instance

A public instance is available at `https://met-museum.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "met-museum-mcp-server": {
      "type": "streamable-http",
      "url": "https://met-museum.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "met-museum-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/met-museum-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "met-museum-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/met-museum-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "met-museum-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/met-museum-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — the Met Collection API is public and unauthenticated.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/met-museum-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd met-museum-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env as needed (all vars are optional)
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless` | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation | `false` |
| `MET_BASE_URL` | Met Collection API root; override for local stubs | `https://collectionapi.metmuseum.org/public/collection` |
| `MET_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds | `10000` |
| `MET_CALL_DEADLINE_MS` | Time budget in milliseconds for one tool call, retries included; exceeding it fails with `retry_deadline_exceeded` | `30000` |
| `MET_BATCH_CONCURRENCY` | Max parallel fetches in `met_get_object` | `5` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t met-museum-mcp-server .
docker run --rm -p 3010:3010 met-museum-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/met-museum-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the Met service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — `met_list_departments`, `met_search_collections`, `met_list_objects`, `met_get_object`. |
| `src/services/met` | Met Collection API client — HTTP, call deadline, response normalization, cached object-ID lists. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the arrays in `createApp()` in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## Data attribution

Data from [The Metropolitan Museum of Art Collection API](https://metmuseum.github.io/) (CC0).

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
