# met-museum-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `met_search_collections` | Search the Met collection by keyword and filters; returns total count and one page of matched object IDs | `q`, `hasImages`, `isHighlight`, `isOnView`, `medium`, `departmentId`, `geoLocation`, `dateBegin`, `dateEnd`, `limit`, `offset` | `readOnlyHint: true`, `idempotentHint: true` |
| `met_get_object` | Fetch full records for one or more object IDs (batch, concurrency-limited, partial-success) | `objectIDs` (array, max 20) | `readOnlyHint: true`, `idempotentHint: true` |
| `met_list_departments` | Return the 19 curatorial departments with their IDs and display names | — | `readOnlyHint: true`, `idempotentHint: true` |

### Resources

None. All data is reachable through the tool surface; the object-by-ID pattern doesn't add meaningful value as a stable resource URI beyond what `met_get_object` already provides.

### Prompts

None. The domain is read-only research with no recurring interaction pattern that benefits from a structured template.

---

## Overview

The Met Collection API exposes over 500,000 artworks from The Metropolitan Museum of Art (`/v1/objects` reported 502,828 on 2026-09-24) — spanning 5,000 years of human creativity across 19 curatorial departments. The API is keyless and public. Roughly 400,000 of these objects are released under CC0 open access, with direct high-resolution image URLs for public-domain works. The `/v1.1/search` index reports 536,200 matches for `q=*`, but any one search pages through only its first 10,000 matches.

Target users: art researchers, educators, students, designers sourcing CC0 imagery, and agents answering questions like "show me Van Gogh's work at the Met" or "what Egyptian artifacts are in the collection?"

---

## Requirements

- No API key required — fully public, keyless REST
- Collection root: `https://collectionapi.metmuseum.org/public/collection/`; each endpoint carries its own version (`/v1.1/search`, `/v1/objects/{id}`, `/v1/departments`)
- Search returns object IDs only, one `offset`/`limit` page at a time; full records require a per-ID fetch (`/v1/objects/{id}`)
- Batch-fetch pattern (array input + `Promise.allSettled` + concurrency limit) is essential to avoid N+1 after a search
- No rate limit published; service has been stable at moderate request volumes — apply a reasonable concurrency cap (5 parallel) to be a polite caller
- `hasImages=true` includes copyrighted works with restricted images. CC0 status is not a search filter (`/v1.1/search` ignores `isPublicDomain`); it is read per object from `isPublicDomain`/`hasCC0Image` on `met_get_object`
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
| `MET_BASE_URL` | No | Override the API root (default: `https://collectionapi.metmuseum.org/public/collection`); each endpoint appends its own version. A value ending in `/v1` or `/v1.1` is read as its root. Useful for local stubs in tests. |
| `MET_REQUEST_TIMEOUT_MS` | No | Per-request timeout in milliseconds (default: `10000`). |
| `MET_BATCH_CONCURRENCY` | No | Max parallel fetches in `met_get_object` (default: `5`). |

No API keys. The server needs no auth env vars for normal operation.

---

## Implementation Order

1. Config (`src/config/server-config.ts`) — three optional env vars with defaults
2. `MetService` (`src/services/met/met-service.ts`) — `search()`, `getObject()`, `getDepartments()` methods with retry, timeout, concurrency pooling
3. `met_list_departments` — trivial; validates the service layer works end-to-end
4. `met_search_collections` — exercises the search endpoint and output shaping
5. `met_get_object` — batch path, partial-success output, concurrency gate
6. Tests (`tests/`)

---

## Tool Specifications

### `met_search_collections`

**Purpose:** Search the Met collection and return matching object IDs. Always chain to `met_get_object` to get full records.

**Upstream endpoint:** `GET /v1.1/search?q=…&offset=…&limit=…&[filters]` — one request per page

**Input schema** (describes abbreviated; the definition file carries the full text):

```ts
z.object({
  q: z.string().min(1)
    .describe('Keyword query, matched across title, artist name, culture, medium, tags, and other text fields.'),
  hasImages: z.boolean().optional()
    .describe('true: objects with at least one image, copyrighted works included; false: objects with none. CC0 status is per object on met_get_object.'),
  isHighlight: z.literal(true).optional()
    .describe('Opt-in filter, true only — the search ignores false. Objects the Met designates as highlights.'),
  isOnView: z.boolean().optional()
    .describe('true: objects on display in a Met gallery; false: objects not on view.'),
  medium: z.string().optional()
    .describe('Object classification, case-sensitive and spelled as the Met spells it ("Paintings", "Sculpture") — not a material like "Oil on canvas".'),
  departmentId: z.number().int().min(1).optional()
    .describe('One curatorial department; valid IDs come from met_list_departments, and an unknown ID is rejected (invalid_department).'),
  geoLocation: z.array(z.string()).max(1).optional()
    .describe('One country, region, or city, as a one-element array. Matched against geography fields and artist nationality.'),
  dateBegin: z.number().int().optional()
    .describe('Earliest object date (year, inclusive; negative = BCE). Requires dateEnd.'),
  dateEnd: z.number().int().optional()
    .describe('Latest object date (year, inclusive; negative = BCE). Requires dateBegin.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Page size. Paging reaches only the first 10,000 matches; a page that would cross 10,000 is cut short there.'),
  offset: z.number().int().min(0).default(0)
    .describe('Zero-based index of the first match to return; pass nextOffset to continue. An offset at or beyond 10,000 or total returns an empty page, not an error. Tied relevance can repeat or skip an ID at a page boundary.'),
})
```

**Output schema:**

```ts
z.object({
  total: z.number().int()
    .describe('Total matching objects — can exceed 10,000, the most that paging reaches.'),
  objectIDs: z.array(z.number().int())
    .describe('Object IDs for this page, up to `limit` results.'),
  returned: z.number().int()
    .describe('Count of object IDs in this page.'),
  truncated: z.boolean()
    .describe('True when reachable matches remain after this page: offset + returned < min(total, 10,000).'),
  remaining: z.number().int()
    .describe('Reachable matches after this page: min(total, 10,000) − (offset + returned), floored at 0.'),
  nextOffset: z.number().int().nullable()
    .describe('The offset to pass on the next call, or null when no further page is reachable.'),
  offset: z.number().int()
    .describe('The resolved offset. At or beyond min(total, 10,000) the page is empty because the offset ran past what paging reaches.'),
})
// enrichment: { notice?: string } — present only when total > 10,000, naming the window.
```

**Error contract:**

```ts
errors: [
  {
    reason: 'no_results',
    code: JsonRpcErrorCode.NotFound,
    when: 'total is 0 — no object matches the keyword, or none of its matches survives the filters.',
    recovery: 'Try a different or broader keyword, or correct or drop the filters, then retry.',
    // The thrown hint is composed at runtime from the levers the call used — Decisions Log #17.
  },
  {
    reason: 'invalid_date_range',
    code: JsonRpcErrorCode.ValidationError,
    when: 'dateBegin or dateEnd provided without the other, or dateBegin > dateEnd',
    recovery: 'Provide both dateBegin and dateEnd as integer years, with dateBegin ≤ dateEnd.',
  },
  {
    reason: 'invalid_filter',
    code: JsonRpcErrorCode.ValidationError,
    when: 'q is whitespace-only, or medium or geoLocation was supplied blank',
    recovery: 'Supply a non-blank value for the named field, or omit the optional filter entirely.',
  },
  {
    reason: 'invalid_department',
    code: JsonRpcErrorCode.ValidationError,
    when: 'departmentId is provided but is not one of the Met department IDs',
    recovery: 'Call met_list_departments to get valid department IDs, then retry with one of the returned IDs.',
  },
]
```

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Notes:** (measured against `/v1.1/search`, 2026-09-24)
- An empty page arrives as HTTP 200 `{ total, objectIDs: null }` — for no match, and for an `offset` at or past the reachable window (`q=horse&offset=10000` → `total` 14,398, `objectIDs: null`). The service normalizes `null` to `[]`; the tool raises `no_results` only when `total` is 0.
- Paging is upstream: `limit` caps at 500 (an absent one defaults to 100, so the service always sends it), a page is clipped where `offset + limit` crosses 10,000 (`q=horse&offset=9900&limit=500` → 100 IDs), and `total` stays the full count. Continuation fields are computed against `min(total, 10,000)`; a `total` above it adds an `enrichment.notice`.
- Every advertised filter is honored: `hasImages` and `isOnView` on both arms (`q=sunflower`: `hasImages` 153/25 of 178), `isHighlight` on `true` only (`false` is ignored → 178), `medium` case-sensitively (`Paintings` 11, `Painting` 0, `paintings` 0), `departmentId`, a single `geoLocation`, and `dateBegin`+`dateEnd` together. A filtered result is a subset of the keyword's unfiltered matches — there is no query-independent floor on `/v1.1` (`q=zzzqqqxyz` plus any filter → 0).
- The search ignores `isPublicDomain` (`true`, `false`, and absent all → 178 for `q=sunflower`), repeats of `geoLocation` past the first (`France&Japan` → 35, the same as `France`), an unknown `departmentId`, and a blank value (`medium=` → 178). Each silently widens the search, which is why the tool drops `isPublicDomain`, caps `geoLocation` at one element, validates `departmentId`, and rejects blanks.
- Tied relevance scores are ordered nondeterministically across requests, so an ID can occasionally repeat or be skipped at a page boundary. It can't be fixed across independent calls; the `offset` description discloses it.
- Search relevance is basic keyword match — not semantic. Long queries do not improve results; shorter terms and filters do.

---

### `met_get_object`

**Purpose:** Fetch full records for one or more object IDs. Batch-fetches up to 20 at a time with concurrency limiting and partial-success — the intended follow-on to `met_search_collections`.

**Upstream endpoint:** `GET /v1/objects/{id}` (per ID)

**Input schema:**

```ts
z.object({
  objectIDs: z.array(z.number().int().positive()).min(1).max(20)
    .describe('One or more Met object IDs to fetch. Maximum 20 per call. IDs come from met_search_collections. Fetches run in parallel (concurrency-limited); partial failures are reported per ID rather than failing the whole batch.'),
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
    hasCC0Image: z.boolean()
      .describe('True when a CC0 open-access image URL is available (primaryImage is non-empty). Distinct from met_search_collections\'s hasImages filter, which matches objects that have any image including copyrighted works.'),
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
    objectBeginDate: z.number().int().nullable()
      .describe('Earliest date as an integer year (negative = BCE). Null when the Met has no machine-readable date for the work — read objectDate for what is known instead, and do not treat null as year zero or substitute a default.'),
    objectEndDate: z.number().int().nullable()
      .describe('Latest date as an integer year (negative = BCE). Null under the same condition as objectBeginDate — the two are null together.'),
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
    geography: z.object({
      geographyType: z.string()
        .describe('How the object relates to the place (e.g., "From", "Original"). Empty when the Met records no findspot.'),
      city: z.string().describe('City of origin or findspot. Empty on nearly every record.'),
      state: z.string().describe('State or province of origin. Empty on nearly every record.'),
      county: z.string().describe('County of origin. Empty on nearly every record.'),
      subregion: z.string()
        .describe('Sub-region or site within the region (e.g., "Saqqara"). Commonly populated for archaeological departments.'),
      locale: z.string()
        .describe('Named place within the site (e.g., "Tomb of Harkhebit"). Excavated objects only.'),
      locus: z.string()
        .describe('Specific findspot within the locale (e.g., "burial chamber"). Excavated objects only.'),
      excavation: z.string()
        .describe('Excavation that recovered the object (e.g., "MMA excavations, 1928-29"). Excavated objects only.'),
      river: z.string().describe('Associated river. Empty on nearly every record.'),
    }).describe('Findspot detail beyond the top-level country and region, which are not repeated here.'),
    measurements: z.array(z.object({
      elementName: z.string()
        .describe('Which part of the object was measured (e.g., "Overall", "Other", "Length").'),
      elementDescription: z.string()
        .describe('Qualifier distinguishing this element from a sibling with the same name (e.g., "Print" vs "Negativ"). Empty when the Met records none.'),
      elementMeasurements: z.record(z.string(), z.number())
        .describe('Measured axes for this element — centimeters for spatial axes, kilograms for weight. Which keys are present varies element to element.'),
    })).nullable()
      .describe('Structured element measurements — the numeric counterpart to the formatted dimensions string. Null when the Met records none.'),
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

  deferred: z.array(z.object({
    objectID: z.number().int()
      .describe('Object ID whose record was fetched but withheld from this response.'),
    bytes: z.number().int().nonnegative()
      .describe('Serialized structuredContent size of the withheld record — the same scale the budget is measured on — so a follow-up batch can be sized before it is requested.'),
  })).optional()
    .describe('Records that were fetched but did not fit the call\'s cumulative budget on serialized structuredContent bytes, in request order. Absent when every fetched record fit.'),
})
```

**Enrichment block:**

```ts
enrichment: {
  notice: z.string().optional()
    .describe('How to retrieve the deferred records, with the budget applied. Present only when the batch byte budget deferred a record.'),
}
```

**Error contract:**

```ts
errors: [
  {
    reason: 'all_failed',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Every requested objectID failed (network errors, API downtime)',
    recovery: 'Retry after a brief delay. If one ID fails repeatedly, verify it with met_search_collections.',
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
- Inside a populated `tags[]`, `AAT_URL` and `Wikidata_URL` are themselves nullable on the wire (a term with no Getty/Wikidata record) — normalize each item's URLs to `''`, matching every other absent string. `constituents[]` sub-fields send `''` and need no per-item guard.
- `objectBeginDate`/`objectEndDate` are `0`/`0` when the Met has no machine-readable date. The Met's date model skips year zero (object `250240` encodes "1st century BCE" as `-100` to `-1`), so zero is never a real year and is free to carry the sentinel. Normalize that pair to `null`/`null` and render `objectDate` alone in `content[]`; a single zero bound is left as sent.
- Upstream catalog text is escaped at the `content[]` render boundary (`escapeMarkdown`, `src/utils/markdown.ts`) — real titles carry complete Markdown sequences. `structuredContent` keeps the raw value.
- The nine URL-shaped fields (`objectURL`, `primaryImage`, `primaryImageSmall`, `additionalImages[]`, `objectWikidata_URL`, `tags[].AAT_URL`, `tags[].Wikidata_URL`, `constituents[].constituentULAN_URL`, `constituents[].constituentWikidata_URL`) are free catalog text, not identifiers — object `288322` sends `(not assigned)` in a constituent's ULAN field. Validate each with `isHttpUrl` before rendering: an `http`/`https` value becomes a link destination unescaped, anything else renders through the prose escaper. Escaping a destination is not an option — a backslash inside one breaks the link.
- The nine findspot fields beyond `country`/`region` ship as a nested `geography` block, each defaulting to `''` when absent (see Decision #7). `country` and `region` stay top-level and are not duplicated into the block.
- `measurements` is `null` on the wire when the Met records none — pass through as nullable like `tags`/`constituents`. Within a populated array, `elementDescription` is itself nullable on the wire (object `544683`'s `Overall` element) and normalizes to `''`; `elementMeasurements` is an open `Record<string, number>` because sibling elements of one record carry different axis keys, and its keys are upstream text, so `format()` escapes them alongside the element name and description.
- The records a single call returns are bounded by a cumulative budget on serialized `structuredContent` bytes (see Decision #12). The budget is spent in request order and admits whole records only; anything that does not fit is reported in `deferred[]` with its size, never truncated or dropped. `content[]` re-renders the admitted records, so the delivered response is roughly twice the budget — the disclosure states this rather than leaving the number to read as a response cap.
- `objectIDs` is de-duplicated before fetching, first occurrence keeping its position (see Decision #13), so a repeated ID is fetched once, charged to the budget once, and appears in exactly one of `objects[]`/`failed[]`/`deferred[]`.
- `GalleryNumber` is `""` (not null) when off display — preserve as-is; an empty string is meaningful ("not on display").

---

### `met_list_departments`

**Purpose:** Return the 19 curatorial departments with their numeric IDs and display names. Use to discover valid `departmentId` values before calling `met_search_collections`.

**Upstream endpoint:** `GET /v1/departments`

**Input schema:** None (no parameters).

**Output schema:**

```ts
z.object({
  departments: z.array(z.object({
    departmentId: z.number().int()
      .describe('Numeric department ID for use in met_search_collections departmentId parameter.'),
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

**Implementation note:** The department list is stable (static catalogue taxonomy). `met_list_departments` fetches it live on each call to remain accurate if the Met reorganizes. `departmentId` validation reads the set of valid IDs through `MetService.getValidDepartmentIds()`, which caches it in memory for one hour.

---

## Domain Mapping

| Noun | Operations | API Endpoint | Tool |
|:-----|:-----------|:-------------|:-----|
| Object | search by keyword + filters | `GET /v1.1/search` | `met_search_collections` |
| Object | fetch by ID (single or batch) | `GET /v1/objects/{id}` | `met_get_object` |
| Department | list all | `GET /v1/departments` | `met_list_departments` |
| Object corpus | enumerate all IDs | `GET /v1/objects` | — (excluded; see Decisions Log) |

---

## Workflow Analysis

**Common chain:** `met_list_departments` (once, to get ID) → `met_search_collections` (get IDs) → `met_get_object` (get records)

The object fetch is the only multi-upstream-call tool. For a batch of N IDs:

| # | Call | Purpose | Concurrency |
|:--|:-----|:--------|:------------|
| 1…N | `GET /v1/objects/{id}` | Fetch full record per ID | Up to `MET_BATCH_CONCURRENCY` in parallel |

`Promise.allSettled` collects all results. Successes → `objects[]`. 404s and network errors → `failed[]`. If `failed` is non-empty but `objects` has results, return partial success. If all fail, throw `all_failed`.

---

## Decisions Log

### 1. Exclude `artistOrCulture` search filter

The Met API documents `artistOrCulture=true` as a flag that restricts keyword matching to artist name and culture fields. Live probing (2026-06-01) showed it returns `{ total: 0, objectIDs: null }` for every tested query — including `Rembrandt`, `Japanese`, `Dutch`, `Egyptian` — regardless of whether those terms clearly match artist or culture records. The baseline `q` query without the flag does return results for the same terms. Conclusion: the parameter is either broken or requires an undocumented query syntax. Excluded from the tool surface to prevent agents from hitting a dead end. If the Met fixes it in a future API version, adding it to `met_search_collections` input is a non-breaking addition. Re-confirmed returning zero results for all tested queries on 2026-06-08, and on `/v1.1/search` on 2026-09-24 (`q=sunflower&artistOrCulture=true` → 0).

### 2. Expose `medium` as a classification filter, not a materials filter

The Met API documents `medium` as a search filter parameter. Live probing showed that passing actual material descriptions ("Oil on canvas", "Watercolor") returns 0 results, but passing classification category names ("Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles") returns results correctly. The `medium` parameter maps to the `classification` field on the object, not the `medium` (materials/technique) text field — a naming mismatch in the API. The filter is included in `met_search_collections` with documentation that explains classification values are required.

**Addendum (2026-09-24, `/v1.1/search`).** The match is also case-sensitive and spelling-exact, and the Met's classification names are not uniformly plural: `q=sunflower` with `Paintings` → 11, `Painting` / `paintings` / `Oil on canvas` → 0; `q=horse` with `Sculpture` → 604, `Sculptures` → 0. The `medium` description says so, and the `no_results` recovery names `medium` with that correction whenever it was among the filters that removed a matching keyword's results (Decision #17). The Met exposes no classification list to validate against, so the value is not checked up front.

### 3. `isPublicDomain` and `isHighlight` are `true`-only opt-ins

**Under-inclusiveness (original finding).** `isPublicDomain + departmentId` can be combined, but the combination returns far fewer results than expected. Live probing: `q=painting&isPublicDomain=true` → 96 results; `q=painting&isPublicDomain=true&departmentId=11` → 9 results. The search index only indexes a subset of public-domain objects with department tags. The combination does not return zero results. Tool descriptions note that `isPublicDomain` is more reliable used alone, with department filtering applied post-fetch on the returned object records.

**Extension: the under-inclusiveness is not department-specific.** `q=sunflower` → 97 matches unfiltered; `q=sunflower&isPublicDomain=true` → 4, and object `436580` — whose own record reports `isPublicDomain: true` — is absent from that arm. So the `true` arm is a partial index even with no department filter, and describing it as a guarantee of CC0 coverage overstates it.

**The `true` arm is CC0-sound but was not query-sound.** Every object it returns is genuinely public domain — `437261`, `436529`, `228990`, `436043` all report `isPublicDomain: true` with populated image URLs — but three of those four came back for *any* keyword, including one that matches nothing. That query-independent floor reaches every filter parameter, not just this one, and is corrected by the intersection in Decision #14. The narrowing decision below is independent of it: the floor was present on the `true` arm either way.

**The `false` arm is unsound.** `q=sunflower&isPublicDomain=false` → 1 match, object `436580`, whose record reports `isPublicDomain: true` — a wrong answer, not an empty one. `isHighlight=false` fails identically: `q=sunflower&isHighlight=false` returns objects `337700` and `309959`, both of which report `isHighlight: true`.

**Decision.** Both parameters are narrowed to a `true`-only literal on the input schema and on `SearchInput`, so the unsound value can never reach `buildSearchUrl` and the constraint is advertised in `tools/list` rather than enforced only at runtime. The `true` arm is kept — narrow, and sound on the CC0 claim — rather than removing the filters or verifying post-fetch, which would change the caller's declared search semantics. `hasImages` and `isOnView` stay plain booleans: neither reproduced a wrong-answer defect on either arm across `q=sunflower` and `q=vase` (six `hasImages=false` records with no image URLs, five `isOnView=false` records with an empty `GalleryNumber`). Both share the query-irrelevant floor of #21, which is not what this decision narrows.

**Reversed for `isPublicDomain` (2026-09-24).** `/v1.1/search` ignores `isPublicDomain` on both arms (`q=sunflower`: `true`, `false`, and absent all → 178), so the filter is removed from the input schema and `SearchInput` rather than advertised as a no-op; CC0 status is read per object from `met_get_object`. `isHighlight` stays `true`-only: `/v1.1` honors `true` (3) and ignores `false` (178).

### 3a. Blank filter values are rejected, not forwarded

A blank parameter value is not an absent one to the Met index. Live probing against `q=sunflower` (baseline 97): `&isPublicDomain=` → 31, `&geoLocation=` → 19, `&zzz=1` → 34, `&bogusParam=true` → 0. A blank or unrecognized value silently selects a different result set, and the figure shifts with the exact string sent, so there is no safe blank to forward. `buildSearchUrl`'s truthiness checks separately *drop* a blank `medium` or an empty `geoLocation` array, silently widening the search to unfiltered.

**Decision.** `met_search_collections` rejects a whitespace-only `q`, a blank `medium`, an empty `geoLocation` array, and any blank `geoLocation` element, via a declared `invalid_filter` reason. The check lives in the handler rather than the Zod schema: this file already validates semantically there (date-range pairing, department membership), a schema `.refine()` would surface as a bare JSON-RPC `-32602` with no `data.reason` and no recovery hint, and only a handler check can name the offending field dynamically under one shared reason. The advertised `inputSchema` is therefore unchanged by this decision — only runtime behavior narrows.

**Still holds on `/v1.1` (2026-09-24), for a different reason.** `/v1.1/search` ignores a blank value rather than selecting a different set (`q=sunflower&medium=` → 178, the unfiltered total), so a forwarded blank now silently widens the search — the same outcome the dropped blank already had. Refusing it remains the only handling that can't be mistaken for a correct answer.

### 4. Exclude `title` search filter

The Met API documents `title=true` as a flag that restricts keyword matching to the title field. Live probing showed it returns `{ total: 0, objectIDs: null }` for every tested query including "Portrait", "Self-Portrait", "Madonna", "Vase" — queries that clearly return results without the flag. Same behavior as `artistOrCulture`. Excluded from the tool surface until confirmed functional. Re-confirmed broken on 2026-06-08.

**Revisit note (2026-09-24).** On `/v1.1/search`, `title=true` and `tags=true` now answer (`q=sunflower` → 36 and 23 of 178). Neither is added in the `/v1.1` migration, which only moves the existing surface; adding them is a separate, non-breaking decision.

### 5. Batch input on `met_get_object` (max 20)

The API has no batch endpoint — each object ID requires its own HTTP GET. The search-returns-IDs-only design of the Met API makes serial fetching impractical (a 20-result search would take 20 serial round trips). Batch input with `Promise.allSettled` and a concurrency gate solves this cleanly. Max 20 per call is a practical cap: 20 × ~150ms = ~3s worst case at concurrency 1, or ~600ms at concurrency 5. Larger batches should be multiple tool calls.

The cap bounds *latency*, not response size — a record's cost is driven by its `constituents`/`tags`/`additionalImages`/`measurements` counts, so three composite objects can cost more than twenty sparse ones. Response size is bounded separately (Decision #12); the input cap stays at 20.

### 6. Exclude `/objects` (full corpus enumeration) from the tool surface

The endpoint returns every object ID (502,828 on 2026-09-24). There is no practical agent workflow that needs to enumerate the full collection — it's too large to consume and produces no useful output on its own. Search + department filtering covers all real use cases. The `/objects?departmentIds=&metadataDate=` variant (filtering by department and update date) is marginally useful but also excluded — an agent wanting "all Egyptian Art objects" should use `met_search_collections` with `departmentId=10`.

### 7. Geography fields are department-stratified, not universally empty — expose them as a nested block

**Original decision.** The API record has 10+ geography fields (`city`, `state`, `county`, `locale`, `locus`, `excavation`, `river`, etc.), read as almost universally empty and excluded to keep the output focused; `country` and `region` were retained as the semantically meaningful pair, plus `culture` for non-Western works.

**Revision.** "Almost universally empty" holds for `county` and `river`, empty in every record drawn so far. Population of the rest is department-stratified: `subregion` was populated in every draw from the two archaeological departments (Ancient West Asian Art, Egyptian Art), and object `548211` (Sarcophagus of Harkhebit) carried `geographyType`, `country`, `region`, `subregion`, `locale`, `locus`, and `excavation` at once. `city` and `state` look empty only from an archaeological or costume sample — a later draw across Islamic Art, Medieval Art, Asian Art, Arms and Armor, and the Michael C. Rockefeller Wing found `city` on three of six records (`452102` Damascus, `472562` Constantinople (?), `788174` Springfield) and `state` on one (`788174` Massachusetts), making `city` the block's most widely populated field outside the archaeological departments. A researcher who finds a work through `geoLocation` and then fetches it was losing the field that explained the match. Costume Institute records populated none of the nine, so the original reasoning describes those departments correctly.

**Decision.** All nine excluded fields ship, nested under `geography` rather than flattened, so nine sparse fields read as one block instead of nine top-level siblings. `country` and `region` stay exactly where they are and are **not** duplicated into the block — a second copy would force a choice about which is authoritative for no functional gain. Each field defaults to `''` when absent, and `format()` omits an empty one from the rendered Geography line rather than printing a placeholder for it; nine dashes would bury the two fields that usually are populated. The added cost is bounded by Decision #12 like every other field.

### 8. No resource definitions

Object-by-ID lookups are already first-class via `met_get_object`. The data is not naturally "injectable context" (it's fetched on demand, not a stable background reference). The small tool surface and the absence of deeply addressable sub-resources means resources would add implementation overhead with no workflow value for tool-only clients (which is the dominant client type).

### 9. No prompt definitions

The domain is factual retrieval. There is no recurring "how should I approach analyzing this data" pattern worth encoding as a reusable prompt template — the natural flow is search → fetch → present, which agents handle directly.

### 10. `GalleryNumber` preserved as `""` rather than `null`

An empty string is meaningful: it signals the object is not currently on display at the museum. Coercing it to `null` would lose that signal. The field is kept as-is from the API, typed as `z.string()`.

### 11. `constituents` vs flat artist fields — include both

The API provides flat `artistDisplayName`, `artistDisplayBio`, `artistNationality`, `artistBeginDate`, `artistEndDate` fields as well as a `constituents` array (which includes role, constituentID, and Wikidata/ULAN URLs). Both are retained. The flat fields are convenient for the 90% case (single artist, well-known work). The `constituents` array is necessary for multi-artist works and for enrichment chains via Wikidata. Many objects omit the `constituents` array (`null`) — primarily anonymous archaeological objects — so it is nullable.

### 12. Bound the returned records by cumulative bytes, not by record count

`met_get_object` returns every field of up to 20 records, and the per-record cost is set by four upstream arrays with no length cap (`constituents`, `tags`, `additionalImages`, and now `measurements`). A live 20-ID batch produced a 159,464-byte response. Nothing in the tool bounded how large a correct response could get.

The alternatives each fail on their own terms: lowering the input cap narrows the advertised `inputSchema` for every existing caller while bounding a proxy rather than the driver; truncating the heavy arrays drops data with no retrieval path; a field selector leaves the default call unchanged and would require making every currently-required output field optional; and defaulting to a compact shape silently gives existing callers less than they asked for.

The framework's `outlineOnOverflow` is built for the *one fat document* case and defaults to a 24,000-byte budget per document — applied per Met record (the heaviest measured normalizes to under 4 KB) it would never fire. `spillover()` is for tabular rows staged to a queryable canvas, and `paginateArray` paginates by element count, the proxy the measurements rule out. So this is a pattern the tool establishes rather than one it adopts, borrowing the outline technique's disclosure vocabulary — per-item sizes, an explicit re-call instruction naming the budget — without its mechanism.

**Decision.** Assemble `objects[]` in request order, admitting whole records while a cumulative 60,000-byte budget lasts, and account for every ID that did not fit in a sibling `deferred[]` carrying its `objectID` and serialized size. Three boundaries:

- **Never a partial record.** A record goes in whole or is deferred whole, so nothing downstream reasons about a half-populated object — and the per-record shape is untouched by the bound.
- **The first successful record is admitted unconditionally**, even when it alone exceeds the budget. Without that, an unusually large object would be deferred by every call that requested it and become permanently unreachable.
- **Admission stops at the first record that does not fit**, rather than packing smaller later records around it. The returned set is then a prefix of the successes and a re-call with the deferred IDs continues where the response left off.

60,000 bytes is where the advertised 20-ID cap meets the measured record size: 60,000 / 20 = 3,000 bytes per record, between a typical normalized record (~2.4 KB with Decision #7's fields) and the heaviest sampled one (~3.7 KB). A full 20-ID batch of ordinary records therefore returns whole and unchanged; only a batch whose records run heavy spends the budget early. It is a code constant, not an env var — a deploy-tunable threshold would drift the tool's response shape between environments.

**The budget measures `structuredContent`, and only it** — the surface the sizing measurements identify as dominant. `content[]` renders the same admitted records as markdown, so the response that reaches the wire runs to roughly twice the budget: a call that spent 50,352 bytes of `structuredContent` delivered 100,390 bytes across both surfaces. Measuring one surface is deliberate (admitting against the sum of both would bind the budget to `format()`'s output length, which is a rendering concern), but it makes the disclosure's phrasing load-bearing: the notice names the measured surface and states that the delivered response is larger, so an agent budgeting context off the number is not off by a factor of two.

`deferred[]` is optional and absent when everything fit, so a fitting response is what it was before the bound existed. The re-call guidance rides the `enrichment` block (`ctx.enrich.notice`), which the framework mirrors onto `structuredContent` and `content[]` alike, keeping both surfaces on the same budget outcome.

### 13. De-duplicate `objectIDs` rather than rejecting a repeat

A repeated ID in one call fetched the object twice, charged it to the byte budget twice — displacing a distinct record that would otherwise have fit — and, once the budget was spent, returned it in `objects[]` while also listing it in `deferred[]`, telling the caller to re-request a record it had already received. That breaks Decision #12's partition: every requested ID in exactly one of `objects[]`, `failed[]`, `deferred[]`.

**Decision.** De-duplicate in the handler, first occurrence keeping its position, and advertise it in the `objectIDs` description. A `.refine()` rejecting duplicates was the alternative and is worse on two counts: it narrows the advertised `inputSchema` for input a caller could previously send, and it answers a request with an obvious reading — a repeated ID means the caller wants that record, once — with an error. De-duplicating also halves the upstream calls for such input.

### 14. Intersect a filtered search with an unfiltered control run of the same query

Adding any filter to `/search` makes the upstream index return the union of the genuine keyword matches and a fixed, query-independent floor. The floor is per parameter and per value, present in every filtered response rather than only the ones where the keyword matches nothing: `q=zzzqqqxyz` matches nothing unfiltered yet returns 3 IDs under `isPublicDomain=true`, 338 under `medium=Paintings`, and 29 under `dateBegin=1800&dateEnd=1900`. The consequences compound — `total` is inflated by the floor size, `no_results` is unreachable whenever a filter is present, and an agent presenting the IDs is presenting unrelated artworks.

**Decision.** A search carrying any filter issues a second upstream request with `q` alone and no filter parameters at all, in parallel with the filtered one, and keeps only the filtered IDs that also appear in the control run. `total` becomes the intersection size, and the page slice and continuation fields derive from it as before.

Why each part:

- **Intersect rather than subtract a cached floor.** A cached per-filter floor is cheaper — one query-independent fetch per filter combination — but unsound in the opposite direction: it drops the floor members that genuinely match the query. `q=cat&hasImages=true` returns 673 IDs, 632 of them in the 51,873-result unfiltered run and 41 not. The `hasImages` floor is 128 IDs, so 87 of those 128 are inside the 632 — genuine matches that a wholesale floor subtraction would discard. Intersection removes exactly the 41 the unfiltered query does not support and keeps the rest.
- **The control run drops every filter, not just the booleans.** `medium` and the date range carry the largest floors measured (338 and 29), so a control run that kept them would leave those floors in place.
- **Order comes from the filtered run.** It preserves the upstream relevance ranking a caller is paging through; the control run supplies membership only, via a `Set` because it reaches tens of thousands of IDs (`q=cat` is 51,873 unfiltered).
- **Parallel, not sequential.** Wall-clock cost is the slower of the two runs rather than their sum.
- **The control run is best-effort; only the filtered run's failure is fatal.** This is the load-bearing part of the design, because the control run can cost far more than the query it corrects. Measured: `q=the&departmentId=11` returns 132 correct IDs in 0.44s on 952 bytes, while its control run `q=the` needs 12.7s to deliver 2.7 MB — past the 10,000 ms `requestTimeoutMs` default. Making the correction mandatory would turn a fast, working, narrow query into a hard `search_timeout` in order to strip a floor of 2 objects out of 132: a worse defect than the one being fixed, because it removes reachability rather than accuracy. So a control run that rejects — timeout, transport error, unparseable body — falls back to the filtered run's IDs and upstream `total`, the behavior the tool had before this decision, and discloses it. A control run that *resolves* with a null `objectIDs` is not a failure: that is the upstream reporting zero matches, and honoring it is what makes `no_results` reachable behind a filter.
- **Disclosure rides `ctx.enrich.notice`, not an output field.** The `lint:mcp` `enrichment-prefer-block` rule puts agent-facing context there, and the framework mirrors enrichment onto `structuredContent` and the `content[]` trailer alike with no `format()` entry, so both client surfaces see it. The declared `notice` is optional, so a checked response is shaped exactly as before.
- **The rejection is caught on the control promise itself**, not by `Promise.allSettled` at the join — the failure then never reaches `Promise.all`, the `search_timeout` classifier, or `withRetry`, so a degraded run cannot re-issue the whole search.
- **No schema change to the domain payload.** `total` and `objectIDs` keep their declared shape; this is a data correction plus an optional enrichment field. Verifying each returned object against the filter would have been a no-op, since floor objects genuinely satisfy the filter — catching this would mean checking text fields against `q`, which is relevance ranking the server should not be doing.

Because the control run is best-effort, `search_timeout` fires only on the filtered run, and its recovery still advises adding filters — they do shrink that download.

Intersecting makes a filtered result sound but not complete. Decision #3's under-inclusiveness survives it unchanged: intersection can only remove IDs the filtered call returned, never add ones it omitted, so `isPublicDomain=true` still omits object `436580`. That surviving caveat is what the filter descriptions and server instructions state now, in place of the floor disclosure they carried before.

**Reversed (2026-09-24).** The upstream endpoint changed: `/v1.1/search` has no query-independent floor (`q=zzzqqqxyz` plus each filter → 0, and every filtered set measured is a subset of its unfiltered one), so the control run, the intersection, and the "unchecked results" notice are removed. A filtered search is one request again. The partial-index caveat goes with it: its evidence (`436580`) is not a `/v1.1` `sunflower` match at all. See Decision #15.

### 15. Search runs on `/v1.1/search`, paged upstream

The Met deprecated `GET /v1/search` on 2026-09-04 and retires it on 2026-10-01. Its replacement, `/v1.1/search`, runs on a different backend and pages upstream: `offset`/`limit` (at most 500 per page), nothing past `offset + limit = 10,000`, `total` still the full count, and HTTP 200 `objectIDs: null` for a page at or past the window.

**Decision.** The tool's `limit`/`offset` pass straight through, one request per page, `limit` always sent (the upstream default is 100). `remaining`, `truncated`, and `nextOffset` are computed against `min(total, 10,000)`, and a `total` above 10,000 adds an `enrichment.notice` naming the window; `format()` gains a fourth marker, `(window end)`, for a last page that stops at the window short of `total`. `offset` stays uncapped in the schema because upstream still answers `total` past the window. `q` stays required: a blank keyword is the whole index, and filter-only browsing through search would reach only its first 10,000 results.

**Base URL.** `/v1/objects` and `/v1/departments` are not deprecated (`/v1.1/objects/{id}` → 404), so no single versioned base serves every endpoint. `MET_BASE_URL` now names the collection root and the service owns each path's version; a value ending in `/v1` — the old default's shape — is reduced to its root so existing overrides keep resolving. A value ending in `/v1.1` is reduced the same way: kept, it would nest every endpoint under it (`/v1.1/v1/objects/{id}` → 404), and `met_get_object` would report every ID as not found. Rewriting a trailing `/v1` to `/v1.1` for search was rejected: it breaks for a suffix-less local stub.

**Reverses** the local offset slicing over a full ID array (issues #9 and #17): `/v1.1` never returns the full array, so paging is upstream. #17's decision survives in the format markers — an exhausted page and an out-of-range offset still render differently, now across four states. `geoLocation` is capped at one element, because `/v1.1` applies only the first repeated value (`France&Japan` → 35, `Japan&France` → 6).

### 16. Timeout-coded failures take the ordinary retry ladder

**Reverses** `search_timeout` (issue #11), because the upstream endpoint changed: on `/v1` one search downloaded every matching ID (`q=*` is 1.3 MB compressed and took 14.7 s on 2026-09-24), so a timeout was deterministic for that query and was surfaced non-retryable. A `/v1.1` page is at most 500 IDs (1.6 KB compressed for `q=horse`), so a timeout says nothing about the size of the result set. The relabel is removed and `search_timeout` leaves the error contract; an upstream 504/408/425 and the request timer's own abort (`errorSource: 'FetchTimeout'`) are retried by `withRetry` like any transient failure and, if they persist, surface as the upstream error. Keying the relabel on `FetchTimeout` alone was rejected: it fixes the 504 case but keeps a transient timer abort non-retryable with a misleading "narrow the query" hint.

### 17. Compose the `no_results` recovery from the levers the call used

A zero result has two causes a caller fixes differently: the keyword matches nothing, or the filters removed every match. A hint keyed on which inputs were set misfires on the first cause — it tells the caller to fix a valid filter.

**Decision.** When a filtered search returns `total: 0`, the handler issues one extra `/v1.1/search?q=…&limit=1` request and reads the keyword-only `total`. Zero → a keyword hint naming no filter. Positive → a hint naming every filter the call set, in one sentence, so one retry clears it; `medium` adds its correction (case-sensitive classification as the Met spells it, not a material; Decision #2). If the extra request fails, the hint names the filters used — the caller did set them — and the call still returns `no_results`; a caller abort during it is not such a failure and ends the call as cancelled. An unfiltered zero needs no extra request. The extra request is one attempt, not a retry ladder: it only words a hint for an answer that is already a miss. `data.reason` stays `no_results`; `ctx.recoveryFor` cannot branch on input, so the hint is built at the throw site and the declared `recovery` is its static summary.

**Reverses** the `isPublicDomain` recovery branch (issue #20): the filter is gone (Decision #3), and a branch keyed on the input alone fired even when the keyword itself matched nothing. Validating `medium` against a classification list up front was rejected: the Met exposes no classification endpoint, and a hardcoded list would go stale and reject values that work.

---

## Known Limitations

- **Search relevance is basic keyword matching** — not semantic or ranked by quality. Very common terms return thousands of matches, most of which are peripheral. `departmentId` and `geoLocation` filters are more effective than longer keyword strings.
- **Paging reaches only the first 10,000 matches of a search** — `/v1.1/search` serves nothing past `offset + limit = 10,000`, so the rest of a larger result set is reachable only by narrowing it (filters, a more specific keyword). `total` still reports the full count, and the response says so in a `notice` (Decision #15).
- **Page boundaries can repeat or skip an ID** — tied relevance scores are ordered nondeterministically across requests; full 20-page walks of `q=horse` (500 per page) returned 9,995 and 9,997 unique IDs of 10,000 on 2026-09-24. Independent calls can't prevent it.
- **`geoLocation` takes one value** — `/v1.1` applies only the first repeated value, so the schema accepts a single location. The filter matches artist nationality and other text fields, not just the object's geography fields.
- **`artistOrCulture` and `title` filters are not exposed** (see Decisions Log #1, #4). `medium` works but maps to `classification`, case-sensitively, not material descriptions.
- **No public-domain search filter** — `/v1.1/search` ignores `isPublicDomain`. CC0 status is read per object from `isPublicDomain`/`hasCC0Image` on `met_get_object`; `hasImages=true` is the nearest search narrowing and includes copyrighted works.
- **Non-public-domain objects have no image URLs** — the Met restricts images for works still under copyright. `primaryImage` and `primaryImageSmall` are empty strings; agents cannot display images for these works.
- **An unknown or blank filter value widens the search upstream** — `/v1.1/search` ignores it and answers unfiltered, which is why `departmentId` is validated and blank values are rejected before any request (Decisions Log #3a).

---

## API Reference

**Collection root:** `https://collectionapi.metmuseum.org/public/collection/` — each endpoint carries its own version

**Endpoints used:**

| Endpoint | Method | Purpose |
|:---------|:-------|:--------|
| `/v1.1/search` | GET | Search — one `offset`/`limit` page, returns `{ total, objectIDs }` |
| `/v1/objects/{id}` | GET | Single object record |
| `/v1/departments` | GET | Static list of departments |

**Error responses:**
- 404: `{ "message": "ObjectID not found" }` — object does not exist
- 200 with `{ total, objectIDs: null }` — an empty search page: zero matches, or an `offset` at or past the reachable window (not an HTTP error)

**No rate limit published.** The API is run by the Met as a public service. Treat it with reasonable care: no more than 5 parallel requests (handled by `MET_BATCH_CONCURRENCY`).

**No auth.** No API key. No OAuth. Plain HTTPS GET.
