# met-museum-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `met_search` | Search the Met collection by keyword and filters; returns total count and matched object IDs | `q`, `hasImages`, `isPublicDomain`, `isHighlight`, `medium`, `departmentId`, `geoLocation`, `dateBegin`, `dateEnd`, `limit` | `readOnlyHint: true` |
| `met_get_object` | Fetch full records for one or more object IDs (batch, concurrency-limited, partial-success) | `objectIDs` (array, max 20) | `readOnlyHint: true`, `idempotentHint: true` |
| `met_list_departments` | Return the 19 curatorial departments with their IDs and display names | — | `readOnlyHint: true`, `idempotentHint: true` |

### Resources

None. All data is reachable through the tool surface; the object-by-ID pattern doesn't add meaningful value as a stable resource URI beyond what `met_get_object` already provides.

### Prompts

None. The domain is read-only research with no recurring interaction pattern that benefits from a structured template.

---

## Overview

The Met Collection API exposes 501,731 artworks from The Metropolitan Museum of Art — spanning 5,000 years of human creativity across 19 curatorial departments. The API is keyless and public. Roughly 400,000 of these objects are released under CC0 open access, with direct high-resolution image URLs for public-domain works. The search index covers approximately 267,000–270,000 of these objects; the remainder exist in the collection but are not text-searchable.

Target users: art researchers, educators, students, designers sourcing CC0 imagery, and agents answering questions like "show me Van Gogh's work at the Met" or "what Egyptian artifacts are in the collection?"

---

## Requirements

- No API key required — fully public, keyless REST
- Base URL: `https://collectionapi.metmuseum.org/public/collection/v1/`
- Search returns object IDs only; full records require a per-ID fetch (`/objects/{id}`)
- Batch-fetch pattern (array input + `Promise.allSettled` + concurrency limit) is essential to avoid N+1 after a search
- No rate limit published; service has been stable at moderate request volumes — apply a reasonable concurrency cap (5 parallel) to be a polite caller
- `isPublicDomain` and `hasImages` filters are distinct: `hasImages=true` includes copyrighted works with restricted images; `isPublicDomain=true` guarantees CC0-licensed, freely reusable image URLs
- Attribution: CC0 means no attribution is legally required, but crediting "The Metropolitan Museum of Art" is courteous

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `MetService` | Met Collection API — search, object fetch, departments | All three tools |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MET_BASE_URL` | No | Override the API base URL (default: `https://collectionapi.metmuseum.org/public/collection/v1`). Useful for local stubs in tests. |
| `MET_REQUEST_TIMEOUT_MS` | No | Per-request timeout in milliseconds (default: `10000`). |
| `MET_BATCH_CONCURRENCY` | No | Max parallel fetches in `met_get_object` (default: `5`). |

No API keys. The server needs no auth env vars for normal operation.

---

## Implementation Order

1. Config (`src/config/server-config.ts`) — three optional env vars with defaults
2. `MetService` (`src/services/met/met-service.ts`) — `search()`, `getObject()`, `getDepartments()` methods with retry, timeout, concurrency pooling
3. `met_list_departments` — trivial; validates the service layer works end-to-end
4. `met_search` — exercises the search endpoint and output shaping
5. `met_get_object` — batch path, partial-success output, concurrency gate
6. Tests (`tests/`)

---

## Tool Specifications

### `met_search`

**Purpose:** Search the Met collection and return matching object IDs. Always chain to `met_get_object` to get full records.

**Upstream endpoint:** `GET /search?q=…&[filters]`

**Input schema:**

```ts
z.object({
  q: z.string().min(1)
    .describe('Keyword query. Searched across title, artist name, culture, medium, tags, and other text fields. Use concise, specific terms — broad queries return large ID sets. Tip: departmentId and geoLocation sharpen results far more than a longer query string.'),

  hasImages: z.boolean().optional()
    .describe('When true, restricts results to objects that have at least one associated image. For freely reusable CC0 images, use isPublicDomain instead — hasImages includes copyrighted works whose images cannot be reproduced.'),

  isPublicDomain: z.boolean().optional()
    .describe('When true, restricts results to objects released under CC0 open access — free to use without permission or attribution. These objects return direct high-resolution image URLs in met_get_object. Can be combined with departmentId but severely restricts results (the search index only indexes a subset of public-domain objects per department); prefer using isPublicDomain alone and filtering by department from the returned object records.'),

  isHighlight: z.boolean().optional()
    .describe('When true, restricts to objects the Met has designated as highlights — major works central to the collection. Use to surface iconic pieces rather than browsing the full corpus.'),

  medium: z.string().optional()
    .describe('Filter by object classification (e.g., "Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles"). Maps to the classification field on the object, not the materials/medium text field — pass a classification category name, not a material description like "Oil on canvas".'),

  departmentId: z.number().int().min(1).optional()
    .describe('Restrict results to one curatorial department. Use met_list_departments to get valid IDs (1–21, not all integers are valid). Can be combined with other filters; combining with isPublicDomain works but returns far fewer results than expected — use isPublicDomain alone when CC0 coverage is the goal.'),

  geoLocation: z.array(z.string()).optional()
    .describe('Filter by geographic origin. Each element is a country, region, or city (e.g., ["France"], ["Egypt", "Sudan"]). Multiple values are AND-combined — ["France", "Egypt"] returns only objects associated with both; use a single value for broader results. Matches geography fields and artist nationality broadly. Works best with the Egyptian Art, Greek and Roman Art, and similar departments that have well-populated geography fields.'),

  dateBegin: z.number().int().optional()
    .describe('Earliest object date (year, inclusive). Negative integers for BCE (e.g., -500 for 500 BCE). Requires dateEnd.'),

  dateEnd: z.number().int().optional()
    .describe('Latest object date (year, inclusive). Negative integers for BCE. Requires dateBegin.'),

  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum number of object IDs to return from the full result set. The API returns all matches (up to tens of thousands) — this caps what is handed back. Chain the returned IDs to met_get_object in batches of up to 20.'),
})
```

**Output schema:**

```ts
z.object({
  total: z.number().int()
    .describe('Total number of matching objects in the Met collection (may far exceed the returned IDs).'),
  objectIDs: z.array(z.number().int())
    .describe('Object IDs for the first `limit` results. Pass to met_get_object (up to 20 at a time) to retrieve full records.'),
  returned: z.number().int()
    .describe('Count of object IDs in this response — may be less than `total` when the full result set was truncated by `limit`.'),
  truncated: z.boolean()
    .describe('True when total > returned. Increase `limit`, refine filters, or add keywords to narrow results.'),
})
```

**Error contract:**

```ts
errors: [
  {
    reason: 'no_results',
    code: JsonRpcErrorCode.NotFound,
    when: 'total is 0 (API returned null objectIDs)',
    recovery: 'Broaden the query, remove filters, or call met_list_departments and set a valid departmentId.',
  },
  {
    reason: 'invalid_date_range',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'dateBegin or dateEnd provided without the other, or dateBegin > dateEnd',
    recovery: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
  },
]
```

**Annotations:** `{ readOnlyHint: true }`

**Notes:**
- The API returns `{ total: 0, objectIDs: null }` for no results — the service layer normalizes `null` to `[]`.
- `artistOrCulture` filter is documented by the Met but returns 0 results in live testing — excluded from the tool surface until confirmed functional.
- `title` filter is documented but returns 0 results in live testing for all tested queries — excluded until confirmed functional.
- `medium` parameter maps to the `classification` field, not the materials/medium text field. Pass classification names ("Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles"). Passing material descriptions like "Oil on canvas" returns 0.
- `isPublicDomain + departmentId` can be combined but returns far fewer results than either filter alone — search index only covers a subset of public-domain objects per department.
- `geoLocation` multiple values require repeated query params in the HTTP request (`geoLocation=France&geoLocation=Italy`). The tool schema uses `z.array(z.string())` — the service layer serializes each array element as a separate query param. Live testing (2026-06-01) confirmed multiple values are AND-combined (intersection), not OR (union) — `["France", "Italy"]` returns fewer results than `["France"]` alone. The filter also matches artist nationality, not just `country`/`region`/`geographyType` fields.
- Search relevance is basic keyword match — not semantic. Long queries do not improve results; shorter terms and filters do.

---

### `met_get_object`

**Purpose:** Fetch full records for one or more object IDs. Batch-fetches up to 20 at a time with concurrency limiting and partial-success — the intended follow-on to `met_search`.

**Upstream endpoint:** `GET /objects/{id}` (per ID)

**Input schema:**

```ts
z.object({
  objectIDs: z.array(z.number().int().positive()).min(1).max(20)
    .describe('One or more Met object IDs to fetch. Maximum 20 per call. IDs come from met_search. Fetches run in parallel (concurrency-limited); partial failures are reported per ID rather than failing the whole batch.'),
})
```

**Output schema:**

```ts
z.object({
  objects: z.array(z.object({
    objectID: z.number().int()
      .describe('Unique Met object identifier.'),
    title: z.string()
      .describe('Object title as catalogued.'),
    isPublicDomain: z.boolean()
      .describe('True when the object is released under CC0 open access. Only true objects return usable image URLs.'),
    hasImages: z.boolean()
      .describe('True when primaryImage is non-empty.'),
    primaryImage: z.string()
      .describe('Full-resolution image URL (CC0 objects only; empty string for non-public-domain works).'),
    primaryImageSmall: z.string()
      .describe('Web-display image URL (~800px; CC0 objects only; empty string for non-public-domain works).'),
    additionalImages: z.array(z.string())
      .describe('Additional image URLs (detail shots, alternate views). CC0 objects only.'),
    objectURL: z.string()
      .describe('Canonical metmuseum.org page URL for human follow-up.'),
    department: z.string()
      .describe('Curatorial department (e.g., "European Paintings", "Egyptian Art").'),
    objectName: z.string()
      .describe('Object type or classification name (e.g., "Painting", "Statuette").'),
    classification: z.string()
      .describe('Broad classification category (e.g., "Paintings", "Ceramics").'),
    isHighlight: z.boolean()
      .describe('True when the Met designates this a collection highlight.'),
    isTimelineWork: z.boolean()
      .describe('True when the work appears in the Met\'s art timeline.'),
    artistDisplayName: z.string()
      .describe('Primary artist name as displayed (e.g., "Vincent van Gogh"). Empty for anonymous or unknown works.'),
    artistDisplayBio: z.string()
      .describe('Artist biographical summary including nationality, birth/death place and year (e.g., "Dutch, Zundert 1853–1890 Auvers-sur-Oise"). Empty for anonymous works.'),
    artistNationality: z.string()
      .describe('Artist\'s nationality (e.g., "Dutch", "French"). Empty for anonymous works.'),
    artistBeginDate: z.string()
      .describe('Artist birth year as a string (e.g., "1853"). Empty for anonymous works.'),
    artistEndDate: z.string()
      .describe('Artist death year as a string. Empty for living or anonymous.'),
    constituents: z.array(z.object({
      constituentID: z.number().int()
        .describe('Constituent identifier for cross-referencing.'),
      role: z.string()
        .describe('Role in relation to the object (e.g., "Artist", "Maker", "Designer").'),
      name: z.string()
        .describe('Constituent display name.'),
      constituentULAN_URL: z.string()
        .describe('Getty ULAN (Union List of Artist Names) URL for the constituent. Empty when no ULAN record exists.'),
      constituentWikidata_URL: z.string()
        .describe('Wikidata entity URL for the constituent. Useful for enrichment via wikidata-mcp-server. Empty when no Wikidata record exists.'),
      gender: z.string()
        .describe('Gender of the constituent. Usually empty string — sparsely populated in the Met catalogue.'),
    })).nullable()
      .describe('All persons associated with the object. Null for anonymous or unknown attribution.'),
    objectDate: z.string()
      .describe('Human-readable date string (e.g., "1887", "ca. 1295–1294 B.C.", "1700–1800").'),
    objectBeginDate: z.number().int()
      .describe('Earliest date as an integer year (negative = BCE). Use for date range comparisons.'),
    objectEndDate: z.number().int()
      .describe('Latest date as an integer year (negative = BCE).'),
    medium: z.string()
      .describe('Materials and techniques (e.g., "Oil on canvas", "Bronze", "Limestone").'),
    dimensions: z.string()
      .describe('Dimensions as a formatted string (e.g., "16 x 12 1/2 in. (40.6 x 31.8 cm)").'),
    culture: z.string()
      .describe('Cultural origin when not attributed to an individual (e.g., "Japanese", "Roman"). Often empty for Western art with named artists.'),
    period: z.string()
      .describe('Historical period (e.g., "New Kingdom, Ramesside", "Meiji period"). Often empty.'),
    dynasty: z.string()
      .describe('Dynasty for applicable cultures (e.g., "Dynasty 19"). Often empty.'),
    accessionNumber: z.string()
      .describe('The Met\'s accession number for the object.'),
    creditLine: z.string()
      .describe('Provenance and gift/bequest attribution.'),
    country: z.string()
      .describe('Country of origin. Often empty.'),
    region: z.string()
      .describe('Geographic region of origin. Often empty.'),
    tags: z.array(z.object({
      term: z.string()
        .describe('Tag label (e.g., "Men", "Self-portraits", "Flowers").'),
      AAT_URL: z.string()
        .describe('Getty Art & Architecture Thesaurus URL for the term.'),
      Wikidata_URL: z.string()
        .describe('Wikidata entity URL for the term. Useful for enrichment.'),
    })).nullable()
      .describe('Controlled vocabulary tags applied to the object. Null when no tags assigned.'),
    objectWikidata_URL: z.string()
      .describe('Wikidata entity URL for the object itself. Enables enrichment via wikidata-mcp-server.'),
    GalleryNumber: z.string()
      .describe('Gallery room number at the museum. Empty for objects not currently on display.'),
  })).describe('Successfully fetched objects.'),

  failed: z.array(z.object({
    objectID: z.number().int()
      .describe('Object ID that could not be fetched.'),
    error: z.string()
      .describe('Error detail and suggested recovery action.'),
  })).describe('Object IDs that failed to fetch with per-ID error context.'),
})
```

**Error contract:**

```ts
errors: [
  {
    reason: 'all_failed',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Every requested objectID failed (network errors, API downtime)',
    recovery: 'Retry after a brief delay. If one ID fails repeatedly, verify it with met_search.',
  },
]
```

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Implementation notes:**
- Use `Promise.allSettled` over all IDs (not `Promise.all`) so one 404 doesn't fail the batch.
- Apply a concurrency pool (default 5, configurable via `MET_BATCH_CONCURRENCY`) to avoid hammering the API.
- A 404 from the API returns `{"message":"ObjectID not found"}` with HTTP 404 — classify as a per-item failure in `failed[]`, not a tool-level throw.
- Non-public-domain objects (`isPublicDomain: false`) return empty strings for `primaryImage`, `primaryImageSmall`, and `additionalImages` — normalize and derive `hasCC0Image: Boolean(primaryImage)`.
- `constituents` and `tags` are `null` on the wire for anonymous/untagged objects — pass through as nullable; don't coerce to `[]`.
- The full object record has many geography fields (`city`, `state`, `county`, `locus`, `excavation`, `river`, etc.) that are almost universally empty. These are excluded from the output schema — the meaningful geographic fields (`country`, `region`) are retained. This keeps the output focused.
- `GalleryNumber` is `""` (not null) when off display — preserve as-is; an empty string is meaningful ("not on display").

---

### `met_list_departments`

**Purpose:** Return the 19 curatorial departments with their numeric IDs and display names. Use to discover valid `departmentId` values before calling `met_search`.

**Upstream endpoint:** `GET /departments`

**Input schema:** None (no parameters).

**Output schema:**

```ts
z.object({
  departments: z.array(z.object({
    departmentId: z.number().int()
      .describe('Numeric department ID for use in met_search departmentId parameter.'),
    displayName: z.string()
      .describe('Human-readable department name (e.g., "European Paintings", "Egyptian Art", "Arms and Armor").'),
  })).describe('All 19 curatorial departments at The Metropolitan Museum of Art.'),
})
```

**Error contract:** No domain failures — the endpoint is static data; infrastructure errors bubble as `ServiceUnavailable`.

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Verified departments (live API, 2026-06-01):**

| ID | Name |
|:---|:-----|
| 1 | American Decorative Arts |
| 3 | Ancient West Asian Art |
| 4 | Arms and Armor |
| 5 | Arts of Africa, Oceania, and the Americas |
| 6 | Asian Art |
| 7 | The Cloisters |
| 8 | The Costume Institute |
| 9 | Drawings and Prints |
| 10 | Egyptian Art |
| 11 | European Paintings |
| 12 | European Sculpture and Decorative Arts |
| 13 | Greek and Roman Art |
| 14 | Islamic Art |
| 15 | The Robert Lehman Collection |
| 16 | The Libraries |
| 17 | Medieval Art |
| 18 | Musical Instruments |
| 19 | Photographs |
| 21 | Modern Art |

Note: ID 20 does not exist — the sequence is not contiguous.

**Implementation note:** The department list is stable (static catalogue taxonomy), but fetched live on each call to remain accurate if the Met reorganizes. No caching layer needed — the call is cheap.

---

## Domain Mapping

| Noun | Operations | API Endpoint | Tool |
|:-----|:-----------|:-------------|:-----|
| Object | search by keyword + filters | `GET /search` | `met_search` |
| Object | fetch by ID (single or batch) | `GET /objects/{id}` | `met_get_object` |
| Department | list all | `GET /departments` | `met_list_departments` |
| Object corpus | enumerate all IDs | `GET /objects` | — (excluded; see Decisions Log) |

---

## Workflow Analysis

**Common chain:** `met_list_departments` (once, to get ID) → `met_search` (get IDs) → `met_get_object` (get records)

The object fetch is the only multi-upstream-call tool. For a batch of N IDs:

| # | Call | Purpose | Concurrency |
|:--|:-----|:--------|:------------|
| 1…N | `GET /objects/{id}` | Fetch full record per ID | Up to `MET_BATCH_CONCURRENCY` in parallel |

`Promise.allSettled` collects all results. Successes → `objects[]`. 404s and network errors → `failed[]`. If `failed` is non-empty but `objects` has results, return partial success. If all fail, throw `all_failed`.

---

## Decisions Log

### 1. Exclude `artistOrCulture` search filter

The Met API documents `artistOrCulture=true` as a flag that restricts keyword matching to artist name and culture fields. Live probing (2026-06-01) showed it returns `{ total: 0, objectIDs: null }` for every tested query — including `Rembrandt`, `Japanese`, `Dutch`, `Egyptian` — regardless of whether those terms clearly match artist or culture records. The baseline `q` query without the flag does return results for the same terms. Conclusion: the parameter is either broken or requires an undocumented query syntax. Excluded from the tool surface to prevent agents from hitting a dead end. If the Met fixes it in a future API version, adding it to `met_search` input is a non-breaking addition.

### 2. Expose `medium` as a classification filter, not a materials filter

The Met API documents `medium` as a search filter parameter. Live probing showed that passing actual material descriptions ("Oil on canvas", "Watercolor") returns 0 results, but passing classification category names ("Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles") returns results correctly. The `medium` parameter maps to the `classification` field on the object, not the `medium` (materials/technique) text field — a naming mismatch in the API. The filter is included in `met_search` with documentation that explains classification values are required.

### 3. `isPublicDomain + departmentId` interaction

These two filters can be combined, but the combination returns far fewer results than expected. Live probing: `q=painting&isPublicDomain=true` → 96 results; `q=painting&isPublicDomain=true&departmentId=11` → 9 results. The search index appears to only index a subset of public-domain objects with department tags. The combination does not return zero results. Tool descriptions note that `isPublicDomain` is more reliable used alone, with department filtering applied post-fetch on the returned object records.

### 4. Exclude `title` search filter

The Met API documents `title=true` as a flag that restricts keyword matching to the title field. Live probing showed it returns `{ total: 0, objectIDs: null }` for every tested query including "Portrait", "Self-Portrait", "Madonna", "Vase" — queries that clearly return results without the flag. Same behavior as `artistOrCulture`. Excluded from the tool surface until confirmed functional.

### 5. Batch input on `met_get_object` (max 20)

The API has no batch endpoint — each object ID requires its own HTTP GET. The search-returns-IDs-only design of the Met API makes serial fetching impractical (a 20-result search would take 20 serial round trips). Batch input with `Promise.allSettled` and a concurrency gate solves this cleanly. Max 20 per call is a practical cap: 20 × ~150ms = ~3s worst case at concurrency 1, or ~600ms at concurrency 5. Larger batches should be multiple tool calls.

### 6. Exclude `/objects` (full corpus enumeration) from the tool surface

The endpoint returns all 501,731 object IDs. There is no practical agent workflow that needs to enumerate the full collection — it's too large to consume and produces no useful output on its own. Search + department filtering covers all real use cases. The `/objects?departmentIds=&metadataDate=` variant (filtering by department and update date) is marginally useful but also excluded — an agent wanting "all Egyptian Art objects" should use `met_search` with `departmentId=10`.

### 7. Exclude sparse geography fields from `met_get_object` output

The API record has 10+ geography fields (`city`, `state`, `county`, `locale`, `locus`, `excavation`, `river`, etc.). For the overwhelming majority of records, all of these are empty strings. Including them would bloat every response with 10 empty fields. The design retains `country` and `region` as the semantically meaningful geography fields, plus `culture` (which carries geographic context for non-Western works). `geoLocation` search filter maps to these same fields on the source data.

### 8. No resource definitions

Object-by-ID lookups are already first-class via `met_get_object`. The data is not naturally "injectable context" (it's fetched on demand, not a stable background reference). The small tool surface and the absence of deeply addressable sub-resources means resources would add implementation overhead with no workflow value for tool-only clients (which is the dominant client type).

### 9. No prompt definitions

The domain is factual retrieval. There is no recurring "how should I approach analyzing this data" pattern worth encoding as a reusable prompt template — the natural flow is search → fetch → present, which agents handle directly.

### 10. `GalleryNumber` preserved as `""` rather than `null`

An empty string is meaningful: it signals the object is not currently on display at the museum. Coercing it to `null` would lose that signal. The field is kept as-is from the API, typed as `z.string()`.

### 11. `constituents` vs flat artist fields — include both

The API provides flat `artistDisplayName`, `artistDisplayBio`, `artistNationality`, `artistBeginDate`, `artistEndDate` fields as well as a `constituents` array (which includes role, constituentID, and Wikidata/ULAN URLs). Both are retained. The flat fields are convenient for the 90% case (single artist, well-known work). The `constituents` array is necessary for multi-artist works and for enrichment chains via Wikidata. Many objects omit the `constituents` array (`null`) — primarily anonymous archaeological objects — so it is nullable.

---

## Known Limitations

- **Search relevance is basic keyword matching** — not semantic or ranked by quality. Very common terms return thousands of matches, most of which are peripheral. `departmentId` and `geoLocation` filters are more effective than longer keyword strings.
- **`geoLocation` multiple values are AND-combined, not OR** — `["France", "Italy"]` returns objects associated with both, not either. Use a single value for broader filtering; AND behavior means adding more values narrows results. The filter matches artist nationality and other text fields, not just the object's geography fields.

- **`artistOrCulture` and `title` filters are non-functional** (live API defects; see Decisions Log). `medium` works but maps to `classification`, not material descriptions.
- **`isPublicDomain + departmentId` severely restricts results** — the combination works but returns far fewer results than either filter alone due to partial search-index coverage. Use `isPublicDomain` alone and filter by department on the returned object records (see Decisions Log).
- **Non-public-domain objects have no image URLs** — the Met restricts images for works still under copyright. `primaryImage` and `primaryImageSmall` are empty strings; agents cannot display images for these works.
- **Search covers approximately 267,000 objects, not all 501,731** — the `/search` endpoint does not index every object in the collection. The `/objects` endpoint (full enumeration) covers 501,731 IDs, suggesting ~235K objects exist outside the search index (likely due to incomplete cataloguing).
- **No pagination on search results** — the API returns all matching IDs in a single response (truncated by this server's `limit` parameter). There is no cursor or page token. Very broad searches may return tens of thousands of IDs.

---

## API Reference

**Base URL:** `https://collectionapi.metmuseum.org/public/collection/v1/`

**Endpoints used:**

| Endpoint | Method | Purpose |
|:---------|:-------|:--------|
| `/search` | GET | Search — returns `{ total, objectIDs }` |
| `/objects/{id}` | GET | Single object record |
| `/departments` | GET | Static list of departments |

**Error responses:**
- 404: `{ "message": "ObjectID not found" }` — object does not exist
- 200 with `{ total: 0, objectIDs: null }` — zero search results (not an HTTP error)

**No rate limit published.** The API is run by the Met as a public service. Treat it with reasonable care: no more than 5 parallel requests (handled by `MET_BATCH_CONCURRENCY`).

**No auth.** No API key. No OAuth. Plain HTTPS GET.
