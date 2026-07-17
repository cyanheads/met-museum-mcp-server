<div align="center">
  <h1>@cyanheads/met-museum-mcp-server</h1>
  <p><b>Search the Metropolitan Museum of Art collection, fetch full artwork records and open-access images via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/met-museum-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/met-museum-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/met-museum-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/met-museum-mcp-server/releases/latest/download/met-museum-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=met-museum-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWV0LW11c2V1bS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22met-museum-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmet-museum-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://met-museum.caseyjhand.com/mcp](https://met-museum.caseyjhand.com/mcp)

</div>

---

## Tools

Three tools for browsing and fetching Metropolitan Museum of Art collection data:

| Tool | Description |
|:---|:---|
| `met_list_departments` | Return all 19 curatorial departments with their numeric IDs and display names |
| `met_search_collections` | Search the collection by keyword with filters for department, date range, medium, geography, on-view status, public-domain status, and highlight designation |
| `met_get_object` | Fetch full records for one or more object IDs — metadata, provenance, artist info, CC0 image URLs, tags, and Wikidata links |

### `met_list_departments`

Return the 19 curatorial departments at The Metropolitan Museum of Art with their numeric IDs and display names.

- `departmentId` values are the valid inputs for the `met_search_collections` department filter

---

### `met_search_collections`

Search the Met collection by keyword and optional filters.

- Keyword search across title, artist name, culture, medium, tags, and other text fields
- Filter by department ID (valid IDs from `met_list_departments`)
- Filter by date range (integer years, negative = BCE)
- Filter by medium/classification (e.g., `"Paintings"`, `"Sculptures"`, `"Ceramics"`) — maps to the classification field, not material descriptions
- Filter by geographic origin — country, region, or city; multiple values are AND-combined
- `isPublicDomain=true` restricts to CC0 open-access objects (guaranteed usable image URLs)
- `hasImages=true` includes any object with images (includes copyrighted works without reusable URLs)
- `isHighlight=true` restricts to collection highlights designated by the Met
- `isOnView=true` restricts to objects currently on display in a Met gallery
- Paginate past `limit` with `offset` (default 0) — a broad, unfiltered query carries the same timeout risk on every page as on the first
- Returns total match count, truncation indicator, `remaining` count, `nextOffset` for the next page (`null` once exhausted), and up to `limit` object IDs (default 20, max 500)
- Returned IDs resolve to full records via `met_get_object` (up to 20 per call)

---

### `met_get_object`

Fetch full records for one or more Met Museum object IDs.

- Accepts 1–20 IDs per call
- Partial-success — a single 404 does not fail the whole batch; failed IDs are reported per-ID
- Full metadata: title, department, classification, medium, dimensions, date, culture, period, dynasty, accession number, credit line, gallery number
- Artist data: display name, biography, nationality, dates, Getty ULAN URL, Wikidata URL
- Constituents array for all associated persons (null for anonymous/unattributed works)
- Controlled vocabulary tags with Getty AAT and Wikidata URLs
- Canonical metmuseum.org URL for human follow-up
- CC0 objects return full-resolution and web-display image URLs plus additional image arrays
- Object-level Wikidata URL for enrichment via external knowledge graph tools

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Metropolitan Museum of Art collection:

- 500K+ artworks spanning 5,000 years from the Met's public collection API
- CC0 open-access data from [The Metropolitan Museum of Art](https://www.metmuseum.org/) — free to use without permission or attribution
- Parallel batch fetching with configurable concurrency for `met_get_object`
- Linked data on every object — Getty ULAN and AAT URLs, Wikidata entity URLs for artists, tags, and works

Agent-friendly output:

- Provenance on every record — `isPublicDomain` and `hasCC0Image` flags distinguish CC0 objects from works with inaccessible images, so agents can reason about what they can actually display
- Partial failure reporting — `met_get_object` returns `objects` and `failed` arrays so callers receive successful records alongside structured per-ID error context
- Truncation signaling — `met_search_collections` returns `total`, `returned`, `truncated`, `remaining`, and `nextOffset` fields so agents know when to refine filters, increase `limit`, or page further with `offset`

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation | `false` |
| `MET_BASE_URL` | Met Collection API base URL (override for local stubs) | `https://collectionapi.metmuseum.org/public/collection/v1` |
| `MET_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds | `10000` |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — `met_list_departments`, `met_search_collections`, `met_get_object`. |
| `src/services/met` | Met Collection API client — HTTP, request timeout, response normalization. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the arrays in `createApp()` in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

Data from [The Metropolitan Museum of Art Collection API](https://metmuseum.github.io/) (CC0).

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
