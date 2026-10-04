# met-museum-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `met_search_collections` | Search the Met collection by keyword and filters; returns total count and one page of matched object IDs | `q`, `matchField`, `hasImages`, `isHighlight`, `isOnView`, `medium`, `departmentId`, `geoLocation`, `dateBegin`, `dateEnd`, `limit`, `offset` | `readOnlyHint: true`, `idempotentHint: true` |
| `met_list_objects` | Browse without a keyword: every object ID in one department, every object created or revised on or after a date, or both; ascending, paged with no depth limit | `departmentId`, `updatedSince`, `limit`, `offset` | `readOnlyHint: true`, `idempotentHint: true` |
| `met_get_object` | Fetch full records for one or more object IDs (batch, concurrency-limited, partial-success), optionally with up to 3 CC0 images as image content | `objectIDs` (array, max 20), `includeImages` | `readOnlyHint: true`, `idempotentHint: true` |
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
- Collection root: `https://collectionapi.metmuseum.org/public/collection/`; each endpoint carries its own version (`/v1.1/search`, `/v1/objects`, `/v1/objects/{id}`, `/v1/departments`)
- Search returns object IDs only, one `offset`/`limit` page at a time; full records require a per-ID fetch (`/v1/objects/{id}`)
- Batch-fetch pattern (array input + a concurrency-limited worker pool that records each ID's outcome) is essential to avoid N+1 after a search
- The documented rate limit is 80 requests per second, but the Met's firewall has blocked a burst far below it (Decision #19) — cap concurrency (5 parallel by default) and keep bursts small
- `hasImages=true` includes copyrighted works with restricted images. CC0 status is not a search filter (`/v1.1/search` ignores `isPublicDomain`); it is read per object from `isPublicDomain`/`hasCC0Image` on `met_get_object`
- Attribution: CC0 means no attribution is legally required, but crediting "The Metropolitan Museum of Art" is courteous

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `MetService` | Met Collection API — search, object ID lists, object fetch, departments — and the Met image host, for `met_get_object`'s opt-in image content | All four tools |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MET_BASE_URL` | No | Override the API root (default: `https://collectionapi.metmuseum.org/public/collection`); each endpoint appends its own version. A value ending in `/v1` or `/v1.1` is read as its root. Useful for local stubs in tests. |
| `MET_REQUEST_TIMEOUT_MS` | No | Per-request timeout in milliseconds (default: `10000`). |
| `MET_CALL_DEADLINE_MS` | No | Wall-clock budget in milliseconds for one tool call, shared by every Met API request it makes, retries and backoff included (default: `30000`). See Decision #18. |
| `MET_BATCH_CONCURRENCY` | No | Max parallel fetches in `met_get_object` (default: `5`). |

No API keys. The server needs no auth env vars for normal operation.

---

## Implementation Order

1. Config (`src/config/server-config.ts`) — four optional env vars with defaults
2. `MetService` (`src/services/met/met-service.ts`) — `search()`, `listObjects()`, `getObject()`, `getDepartments()`, `getValidDepartmentIds()`, `countKeywordMatches()`, and `keepDepartmentMembers()`, with retry, the per-call deadline, firewall-block and 5xx-outage classification, and the cached object-ID lists
3. `met_list_departments` — trivial; validates the service layer works end-to-end
4. `met_search_collections` — exercises the search endpoint and output shaping
5. `met_list_objects` — the keyword-less browse over `/v1/objects`, paged from the sorted, cached list
6. `met_get_object` — batch path, partial-success output, concurrency gate
7. Tests (`tests/`)

---

## Tool Specifications

### `met_search_collections`

**Purpose:** Search the Met collection and return matching object IDs. Always chain to `met_get_object` to get full records.

**Upstream endpoint:** `GET /v1.1/search?q=…&offset=…&limit=…&[filters]` — one request per page

**Input schema** (describes abbreviated; the definition file carries the full text):

```ts
z.object({
  q: z.string().min(1)
    .describe('Keyword query, matched across title, artist name, culture, medium, tags, and other text fields; matchField narrows it to titles or tags. "*" matches every object, for a search narrowed by filters alone (still the first 10,000 matches). An accession number ranks its object first, near-numbered objects after it — confirm from accessionNumber on met_get_object.'),
  matchField: z.enum(['title', 'tags']).optional()
    .describe('Restrict the keyword match to titles (title=true) or subject tags (tags=true). Combines with every filter; no effect when q is "*".'),
  hasImages: z.boolean().optional()
    .describe('true: objects with at least one image, copyrighted works included; false: objects with none. CC0 status is per object on met_get_object.'),
  isHighlight: z.literal(true).optional()
    .describe('Opt-in filter, true only — the search ignores false. Objects the Met designates as highlights.'),
  isOnView: z.boolean().optional()
    .describe('true: objects on display in a Met gallery; false: objects not on view.'),
  medium: z.string().optional()
    .describe('Object classification, case-sensitive and spelled as the Met spells it ("Paintings", "Sculpture") — not a material like "Oil on canvas".'),
  departmentId: z.number().int().min(1).optional()
    .describe('One curatorial department; valid IDs come from met_list_departments, and an unknown ID is rejected (invalid_department). 7 and 17 search as one combined set: objectIDs keeps the requested department, total and paging count both (Decision #21).'),
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
    .describe('Object IDs for this page, up to `limit` results; for departmentId 7 or 17 only that department\'s, so possibly fewer, or none, while more remain.'),
  returned: z.number().int()
    .describe('Count of object IDs in this page.'),
  truncated: z.boolean()
    .describe('True when reachable matches remain after this page: offset + positions read < min(total, 10,000). Positions read equal returned, except for departmentId 7 or 17 (the combined set before the department filter). An empty page reports false.'),
  remaining: z.number().int()
    .describe('Reachable matches after this page: min(total, 10,000) − (offset + positions read), floored at 0; an empty page reports 0.'),
  nextOffset: z.number().int().nullable()
    .describe('The offset to pass on the next call (offset + positions read, which for 7 or 17 can exceed returned), or null when no further page is reachable.'),
  offset: z.number().int()
    .describe('The resolved offset. Nonzero and at or beyond min(total, 10,000), the page is empty because the offset ran past what paging reaches.'),
})
// enrichment: {
//   notice?: string — total 0: the zero-match guidance, composed from the levers the call used (Decision #17);
//                     total > 10,000: the window; departmentId 7 or 17: the combined set — total counts both
//                     departments and a page can hold fewer than limit IDs, or the department filter could not
//                     be applied (Decision #21). Every notice for one response is joined into one string.
//   effectiveQuery?: string — every success: q and each filter set, `name=` + JSON-encoded value, schema order,
//                     without limit/offset (`q="sunflower", medium="Paintings", departmentId=11`).
// }
```

**Error contract:**

```ts
errors: [
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
  {
    reason: 'upstream_blocked',
    code: JsonRpcErrorCode.ServiceUnavailable,
    retryable: false,
    thrownBy: 'service', // Decision #19
    when: "The Met API's firewall refused the request with HTTP 403 — it blocks this server's address, not one endpoint.",
    recovery: 'Wait several minutes before retrying, and send fewer requests.',
  },
  {
    reason: 'upstream_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    thrownBy: 'service', // Decision #20
    when: 'The Met API answered HTTP 500, 502, 503, or 504 to the department lookup or the search until the retry ladder ran out — an outage on its side.',
    recovery: 'The Met API is failing on its side, so changing the request will not help. Wait a few minutes before retrying.',
  },
  {
    reason: 'retry_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    thrownBy: 'service', // Decision #18
    when: "The call's time budget ran out, retries and backoff included, before the Met API returned a successful response to the department lookup or the search.",
    recovery: "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
  },
]
```

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Notes:** (measured against `/v1.1/search`, 2026-09-24)
- An empty page arrives as HTTP 200 `{ total, objectIDs: null }` — for no match, and for an `offset` at or past the reachable window (`q=horse&offset=10000` → `total` 14,398, `objectIDs: null`). The service normalizes `null` to `[]`, and an empty page ends paging wherever it falls (`remaining` 0, `nextOffset` null): continuing from one would hand back the offset just read, and a caller following `nextOffset` would loop. A `total` of 0 is an empty success carrying the zero-match notice; an empty page of a nonzero `total` carries none.
- `format()` marks a page `(truncated)`, `(offset beyond result set)` when `offset` is nonzero and at or past `min(total, 10,000)`, `(window end)` for a last page that stops at the window short of `total`, and `(complete)` otherwise — a zero result read from offset 0 included.
- Paging is upstream: `limit` caps at 500 (an absent one defaults to 100, so the service always sends it), a page is clipped where `offset + limit` crosses 10,000 (`q=horse&offset=9900&limit=500` → 100 IDs), and `total` stays the full count. Continuation fields are computed against `min(total, 10,000)`; a `total` above it adds an `enrichment.notice`.
- Every advertised filter is honored: `hasImages` and `isOnView` on both arms (`q=sunflower`: `hasImages` 153/25 of 178), `isHighlight` on `true` only (`false` is ignored → 178), `medium` case-sensitively (`Paintings` 11, `Painting` 0, `paintings` 0), `departmentId`, a single `geoLocation`, and `dateBegin`+`dateEnd` together. A filtered result is a subset of the keyword's unfiltered matches — there is no query-independent floor on `/v1.1` (`q=zzzqqqxyz` plus any filter → 0).
- `matchField` sends `title=true` or `tags=true` (2026-10-04: `q=sunflower` → 36 and 23 of 178, each a subset of the 178), composes with the filters (`title` with `hasImages=true` → 20, the intersection), and counts as a filter in the zero-match notice; the keyword-only count is sent without it. It has no effect on `q=*` (536,265 either way). See Decision #4.
- The search ignores `isPublicDomain` (`true`, `false`, and absent all → 178 for `q=sunflower`), repeats of `geoLocation` past the first (`France&Japan` → 35, the same as `France`), an unknown `departmentId`, and a blank value (`medium=` → 178). Each silently widens the search, which is why the tool drops `isPublicDomain`, caps `geoLocation` at one element, validates `departmentId`, and rejects blanks.
- `departmentId` 7 (The Cloisters) and 17 (Medieval Art) answer one combined set: `q=tapestry` → the same 165 IDs in the same order for either, 40 on department 7's `/v1/objects` list (2,350 IDs) and 125 on 17's (7,129), no ID on both (2026-10-04). Each 7/17 page keeps the IDs on the requested department's list — the sorted, cached list `met_list_objects` pages, read after the search and only for a page holding IDs — while `total`, `remaining`, `truncated`, and `nextOffset` stay in the combined space, advancing by the positions the page read. A page can therefore hold fewer than `limit` IDs, or none, with `truncated: true`; the zero-match notice still keys on the Met's `total: 0` alone. Every 7/17 response carries a notice saying so, or, when the list cannot be loaded, that the page is unfiltered. Walked live in 60-ID pages: department 7 → 23 + 10 + 7 = 40 IDs, the Unicorn Tapestries (467638–467642) included, department 17 → 37 + 50 + 38 = 125, each walk reading positions 60 + 60 + 45 = 165 with one list request per department. Decision #21.
- Tied relevance scores are ordered nondeterministically across requests, so an ID can occasionally repeat or be skipped at a page boundary. It can't be fixed across independent calls; the `offset` description discloses it.
- Search relevance is basic keyword match — not semantic. Long queries do not improve results; shorter terms and filters do.
- `q=*` matches the whole index and combines with the filters, which serves questions with no keyword that `met_list_objects` cannot filter for (highlight, on-view, images): `{ q: "*", isHighlight: true, isOnView: true, departmentId: 10 }` → 98 (2026-10-04), still inside the 10,000-match window. An accession number as `q` ranks its own object first and near-numbered neighbours after it (`29.100.5` → `436573`, accession `29.100.5`, first of 31), so the match is confirmed from `accessionNumber` on `met_get_object`. Both notes ride the `q` description and the server `instructions`; `q` stays required (Decision #15).

---

### `met_list_objects`

**Purpose:** Browse the collection without a keyword — every object ID in one curatorial department, every object whose record was created or revised on or after a date, or both. Chain to `met_get_object` for full records.

**Upstream endpoint:** `GET /v1/objects?[departmentIds=…]&[metadataDate=…]` — one request per filter set, sorted and cached; pages are sliced locally

**Input schema** (describes abbreviated; the definition file carries the full text):

```ts
// inputAliases: { metadataDate: 'updatedSince' } — the Met API's name for the same filter
z.object({
  departmentId: z.number().int().min(1).optional()
    .describe('One curatorial department; valid IDs come from met_list_departments, and an unknown ID is rejected (invalid_department).'),
  updatedSince: blankAsUnset(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional())
    .describe('Objects whose record was created or revised on or after this date, the day itself included, as YYYY-MM-DD with no time part. It compares the UTC date of each record\'s metadataDate, which met_get_object returns. A date later than the newest update returns an empty list, not an error.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum number of object IDs to return in this page.'),
  offset: z.number().int().min(0).default(0)
    .describe('Zero-based index of the first ID; pass nextOffset to continue. Every ID is reachable; an offset at or past total returns an empty page, not an error.'),
})
```

**Output schema:**

```ts
z.object({
  total: z.number().int()
    .describe('Objects matching the filters. Paging reaches every one — there is no 10,000 window here.'),
  objectIDs: z.array(z.number().int())
    .describe('Object IDs for this page in ascending order, up to `limit` results.'),
  returned: z.number().int()
    .describe('Count of object IDs in this page.'),
  offset: z.number().int()
    .describe('The resolved offset. At or beyond a nonzero total the page is empty because the offset ran past the list.'),
  remaining: z.number().int()
    .describe('IDs after this page: total − (offset + returned), floored at 0.'),
  truncated: z.boolean()
    .describe('True when IDs remain after this page: offset + returned < total.'),
  nextOffset: z.number().int().nullable()
    .describe('The offset to pass on the next call, or null when this page ends the list.'),
})
// enrichment: {
//   notice?: string — present only when total is 0, naming the filters that matched nothing and how to widen the list.
//   effectiveQuery?: string — every success: the filters as sent (updatedSince after its clamp to 1753-01-01),
//                     `name=` + JSON-encoded value (`departmentId=10, updatedSince="2026-09-01"`), or
//                     `no filter (whole collection)` — a blank updatedSince, read as unset, included.
// }
```

**Error contract:**

```ts
errors: [
  {
    reason: 'invalid_department',
    code: JsonRpcErrorCode.ValidationError,
    when: 'departmentId is provided but is not one of the Met department IDs.',
    recovery: 'Call met_list_departments to get valid department IDs, then retry with one of the returned IDs.',
  },
  {
    reason: 'invalid_date',
    code: JsonRpcErrorCode.ValidationError,
    when: 'updatedSince has the YYYY-MM-DD shape but names no calendar day, such as 2026-02-30.',
    recovery: 'Pass updatedSince as a real calendar date in YYYY-MM-DD form, such as 2026-09-01.',
  },
  {
    reason: 'upstream_blocked',
    code: JsonRpcErrorCode.ServiceUnavailable,
    retryable: false,
    thrownBy: 'service', // Decision #19
    when: "The Met API's firewall refused the request with HTTP 403 — it blocks this server's address, not one endpoint.",
    recovery: 'Wait several minutes before retrying, and send fewer requests.',
  },
  {
    reason: 'upstream_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    thrownBy: 'service', // Decision #20
    when: 'The Met API answered HTTP 500, 502, 503, or 504 to the department lookup or the ID list until the retry ladder ran out — an outage on its side.',
    recovery: 'The Met API is failing on its side, so changing the request will not help. Wait a few minutes before retrying.',
  },
  {
    reason: 'retry_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    thrownBy: 'service', // Decision #18
    when: "The call's time budget ran out, retries and backoff included, before the Met API returned a successful response to the department lookup or the ID list.",
    recovery: "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
  },
]
```

**Format markers:** `content[]` marks the page `(truncated)` when IDs remain after it, `(offset beyond result set)` when `offset` is nonzero and at or past `total` — an empty list read from offset 50 included — and `(complete)` otherwise, including an empty list read from offset 0, whose `notice` says why it is empty.

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Implementation notes:**
- `departmentId` is checked against the cached department set (`getValidDepartmentIds()`) before any `/v1/objects` request: upstream answers an unknown department with an empty list, indistinguishable from a real department with nothing to show.
- `updatedSince` is shape-checked by the schema — a time part or any other date format is rejected there — and calendar-checked in the handler (`2026-02-30` → `invalid_date`). A future date is not an error; it returns `total: 0` with the notice. A blank value from a form client is read as unset (`blankAsUnset`), but the advertised pattern still rejects `""`, so the description does not offer it.
- `metadataDate` filters nothing before `1753-01-01` (`METADATA_DATE_FLOOR`): any earlier date answers `total: 0`, and the floor itself answers the whole collection. The handler sends an earlier `updatedSince` as the floor, after the calendar check, so the clamped date is both the URL parameter and the cache key — every pre-1753 date shares the floor's cached list. A date on or after the floor is sent unchanged. An empty list for a date at or before the floor gets a notice saying that date already covers every record and pointing to `departmentId` (or, with none set, saying the Met returned nothing for the collection), never to an earlier date.
- An empty list arrives as `objectIDs: []`; a `null` in its place is read the same way rather than failing the load.
- `/v1/objects` returns the whole ID set in a different order on every call, so the service sorts each list ascending into an `Int32Array` and slices every page from it. That gives a stable order across pages and no depth limit.
- Sorted lists are cached per `departmentId` + `updatedSince` for one hour, bounded to 16 MiB of retained `Int32Array` bytes with least-recently-used eviction. A list larger than the whole bound is returned but not retained.
- Concurrent callers of one filter set share one in-flight load. The load runs under its own `MET_CALL_DEADLINE_MS` budget and a signal no caller owns, so a caller that cancels or runs out of budget ends alone while the load finishes for the rest. A failed load fails every waiting caller and is not cached. A caller whose signal has already aborted starts no load, so every load has a caller attached and none can reject unobserved.
- One call deadline (Decision #18) covers both the department lookup and the list request.

---

### `met_get_object`

**Purpose:** Fetch full records for one or more object IDs. Batch-fetches up to 20 at a time with concurrency limiting and partial-success — the intended follow-on to `met_search_collections` and `met_list_objects`.

**Upstream endpoint:** `GET /v1/objects/{id}` (per ID)

**Input schema:**

```ts
z.object({
  objectIDs: z.array(z.number().int().positive()).min(1).max(20)
    .describe('One or more Met object IDs to fetch. Maximum 20 per call. IDs come from met_search_collections or met_list_objects. A repeated ID is fetched and returned once, at its first position. Partial failures are reported per ID rather than failing the whole batch.'),
  includeImages: z.boolean().default(false)
    .describe('Also attach the web-display image (primaryImageSmall, about 600 px on the long edge) of the first 3 returned records that have hasCC0Image true, in request order, as image blocks in content[], each after a caption naming its objectID. images[] reports what happened for every returned record. The image bytes ride content[] only, so a client that hands the model only structuredContent will not show the images. Default false: no image is fetched.'),
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
      .describe('Web-display image URL (about 600 px on the long edge; CC0 objects only; empty string for non-public-domain works).'),
    additionalImages: z.array(z.string())
      .describe('Additional image URLs (detail shots, alternate views). CC0 objects only.'),
    objectURL: z.string()
      .describe('Canonical metmuseum.org page URL for human follow-up.'),
    department: z.string()
      .describe('Curatorial department as the record names it (e.g., "European Paintings", "Egyptian Art"). Five departments carry a different name on their records than in met_list_departments — "The American Wing", "The Michael C. Rockefeller Wing", "Costume Institute", "Robert Lehman Collection", "Modern and Contemporary Art" — so match departments by departmentId, not by name.'),
    departmentId: z.number().int().nullable()
      .describe('The department\'s numeric ID, resolved from department, for the departmentId filter of met_list_objects and met_search_collections. Null when the record\'s department name was not recognized — never a guess.'),
    objectName: z.string()
      .describe('Object type or classification name (e.g., "Painting", "Statuette").'),
    classification: z.string()
      .describe('Broad classification category (e.g., "Paintings", "Ceramics").'),
    isHighlight: z.boolean()
      .describe('True when the Met designates this a collection highlight.'),
    isTimelineWork: z.boolean()
      .describe('True when the work appears in the Met\'s art timeline.'),
    artistPrefix: z.string()
      .describe('Qualifier the Met places before artistDisplayName (e.g., "Style of", "Workshop of", "Attributed to", "Published by"). Read the two together: "Style of" with "Rembrandt" is a work in Rembrandt\'s style, not one by him. Empty when the attribution is unqualified.'),
    artistDisplayName: z.string()
      .describe('Name of the person or firm the attribution names (e.g., "Vincent van Gogh"), without the qualifier in artistPrefix or the text in artistSuffix — read those and artistRole with it. Empty for anonymous or unknown works.'),
    artistSuffix: z.string()
      .describe('Text the Met places after artistDisplayName (e.g., "(r. 1876–1909)", ", Paris", "(?)"). Empty when the Met records none.'),
    artistRole: z.string()
      .describe('The named person\'s role for this object (e.g., "Artist", "Maker", "Publisher", "Patron") — a patron or publisher is not the maker. Empty when the record names no one.'),
    artistDisplayBio: z.string()
      .describe('Artist biographical summary including nationality, birth/death place and year (e.g., "Dutch, Zundert 1853–1890 Auvers-sur-Oise"). Empty for anonymous works.'),
    artistNationality: z.string()
      .describe('Artist\'s nationality (e.g., "Dutch", "French"). Empty for anonymous works.'),
    artistBeginDate: z.string()
      .describe('Birth year of the person artistDisplayName names, or a firm\'s founding year, as a string (e.g., "1853") — that person\'s even when artistPrefix qualifies the attribution. Occasionally a full date (e.g., "1928-01-10"). Empty for anonymous works.'),
    artistEndDate: z.string()
      .describe('Death year of the person artistDisplayName names, or a firm\'s closing year, as a string (e.g., "1890") — that person\'s even when artistPrefix qualifies the attribution. Occasionally a full date (e.g., "1928-01-10"). Empty for a living artist, a firm still active, or an anonymous work.'),
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
    accessionYear: z.string()
      .describe('Year the Met acquired the object, as sent (e.g., "1960") — occasionally a full date (e.g., "2005-02-15"). Can differ from the year in creditLine. Empty when the Met records none.'),
    creditLine: z.string()
      .describe('Provenance and gift/bequest attribution.'),
    rightsAndReproduction: z.string()
      .describe('Rights holder and reproduction notice (e.g., "© 2026 Pollock-Krasner Foundation / Artists Rights Society (ARS), New York"). Most copyrighted records carry none, so an empty value does not make a work free to reuse — isPublicDomain decides that.'),
    country: z.string()
      .describe('Country of origin. Often empty.'),
    region: z.string()
      .describe('Geographic region of origin. Often empty.'),
    geography: z.object({
      geographyType: z.string()
        .describe('How the object relates to the place (e.g., "From", "Original", "Probably originally from"). Empty when the Met records no findspot.'),
      city: z.string()
        .describe('City of origin or findspot (e.g., "Damascus", "Constantinople (?)", "Springfield"). The most widely populated field of this block outside the archaeological departments; empty when the Met records no city.'),
      state: z.string()
        .describe('State or province of origin (e.g., "Massachusetts"). Sparse, and concentrated in departments that catalogue a manufacturing place. Empty when the Met records none.'),
      county: z.string().describe('County of origin. Empty on nearly every record.'),
      subregion: z.string()
        .describe('Sub-region or site within the region (e.g., "Saqqara", "Deir el-Bahri"). Commonly populated for archaeological departments, empty elsewhere.'),
      locale: z.string()
        .describe('Named place within the site (e.g., "Late Period cemetery, Tomb of Harkhebit"). Excavated objects only.'),
      locus: z.string()
        .describe('Specific findspot within the locale (e.g., "burial chamber"). Excavated objects only.'),
      excavation: z.string()
        .describe('Excavation that recovered the object (e.g., "MMA excavations, 1928-29"). Excavated objects only.'),
      river: z.string().describe('Associated river. Empty on nearly every record.'),
    }).describe('Findspot detail beyond the top-level country and region, which are not repeated here. Every field is an empty string when the Met records nothing; population concentrates in the archaeological departments.'),
    measurements: z.array(z.object({
      elementName: z.string()
        .describe('Which part of the object was measured (e.g., "Overall", "Other", "Length").'),
      elementDescription: z.string()
        .describe('Qualifier distinguishing this element from a sibling with the same name (e.g., "Print" vs "Negativ"). Empty when the Met records none.'),
      elementMeasurements: z.record(z.string(), z.number()) // key: axis ("Height", "Width", …); value: centimeters for spatial axes, kilograms for weight
        .describe('Measured axes for this element. Which keys are present varies element to element, so read the keys rather than assuming a fixed set. Empty object when the Met records no values.'),
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
      .describe('Gallery room number at the museum. Empty string for objects not currently on display.'),
    metadataDate: z.string()
      .describe('When the Met last created or revised this record: an ISO 8601 UTC timestamp, as sent (e.g., "2026-10-01T04:59:29.693Z"; fractional seconds run from none to three digits). Its UTC date is what met_list_objects updatedSince compares, that day included. Empty when the Met sends none.'),
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
    .describe('Records that were fetched but did not fit the call’s cumulative budget on serialized structuredContent bytes, in request order. Re-call met_get_object with these IDs to retrieve them. Absent when every fetched record fit.'),

  images: z.array(z.object({
    objectID: z.number().int()
      .describe('Object ID of a returned record.'),
    status: z.enum(['attached', 'no_cc0_image', 'over_cap', 'unavailable'])
      .describe('attached: the image rides content[], after a caption naming the objectID. no_cc0_image: the record has no CC0 image, so nothing was fetched. over_cap: 3 earlier CC0 records took the image slots — request this ID among the first 3 CC0 records of another call to see its image. unavailable: the image host returned no image in time, or the URL was not on the Met image host.'),
  })).optional()
    .describe('Image outcome for each record in objects[], in request order; deferred and failed IDs get no entry. Present only when includeImages is true.'),
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
    reason: 'all_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'Every requested objectID returned a 404 — all IDs are stale or invalid.',
    recovery: 'The search index can carry IDs the object endpoint no longer serves, so searching again returns the same IDs. Drop these IDs rather than re-checking them with met_search_collections.',
    severity: 'notice',
  },
  {
    reason: 'all_failed',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'No object was fetched, no failure was a firewall block or a 500/502/503/504 outage, and the failures were neither all 404s nor all time-budget expiries — network errors, other HTTP errors, or 404s beside expiries.',
    recovery: 'Retry after a brief delay. If one ID keeps failing across retries, drop it from the batch.',
  },
  {
    reason: 'upstream_blocked',
    code: JsonRpcErrorCode.ServiceUnavailable,
    retryable: false,
    // Raised by the handler with ctx.fail once the batch fetched nothing — Decision #19
    when: "No object was fetched and the Met API's firewall refused requests with HTTP 403 — it blocks this server's address, not one object.",
    recovery: 'Wait several minutes before retrying, and send fewer requests.',
  },
  {
    reason: 'upstream_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    // Raised by the handler with ctx.fail once the batch fetched nothing — Decision #20
    when: "No object was fetched and a fetch exhausted its retries on HTTP 500, 502, 503, or 504 — an outage on the Met API's side, not a problem with the IDs.",
    recovery: 'The Met API is failing on its side, so changing the request will not help. Wait a few minutes before retrying.',
  },
  {
    reason: 'retry_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    // Raised by the handler with ctx.fail — Decision #18
    when: "No object was fetched and every fetch ran out of the call's time budget, retries and backoff included — an ID whose fetch would have started after the budget was spent counts too.",
    recovery: "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
  },
]
```

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Implementation notes:**
- A fixed pool of workers (default 5, configurable via `MET_BATCH_CONCURRENCY`) drains the IDs; each fetch runs in its own `try`/`catch`, so one 404 or failed fetch becomes that ID's outcome instead of failing the batch.
- A 404 from the API returns `{"message":"ObjectID not found"}` with HTTP 404 — classify as a per-item failure in `failed[]`, not a tool-level throw.
- `/v1.1/search` indexes IDs the object endpoint does not serve: `q=*` totals about 536,265 while `/v1/objects` lists about 502,886, and object `706047`, returned by a department-16 search, answers 404 (2026-10-04). Running the search again returns the same IDs, so neither the per-ID not-found text nor the `all_not_found` recovery sends the caller back to `met_search_collections` to verify an ID: both say the search index can still list it and to drop it.
- Non-public-domain objects (`isPublicDomain: false`) return empty strings for `primaryImage`, `primaryImageSmall`, and `additionalImages` — normalize and derive `hasCC0Image: Boolean(primaryImage)`.
- `constituents` and `tags` are `null` on the wire for anonymous/untagged objects — pass through as nullable; don't coerce to `[]`.
- Inside a populated `tags[]`, `AAT_URL` and `Wikidata_URL` are themselves nullable on the wire (a term with no Getty/Wikidata record) — normalize each item's URLs to `''`, matching every other absent string. `constituents[]` sub-fields send `''` and need no per-item guard, but `name` alone arrives entity-encoded (`Tiffany &amp; Co.` on object `20121`, whose `artistDisplayName` reads `Tiffany & Co.`; `World&#39;s Views Series` on `288322`). Each item's `name` is decoded with `decodeHtmlEntities` (`src/utils/html-entities.ts`): one left-to-right pass over the five predefined names and decimal/hex numeric references, refusing U+0000, control characters, surrogates, and code points past U+10FFFF; everything else stays literal. `escapeMarkdown` escapes the decoded text again in `content[]`.
- `objectBeginDate`/`objectEndDate` are `0`/`0` when the Met has no machine-readable date. The Met's date model skips year zero (object `250240` encodes "1st century BCE" as `-100` to `-1`), so zero is never a real year and is free to carry the sentinel. Normalize that pair to `null`/`null` and render `objectDate` alone in `content[]`; a single zero bound is left as sent.
- `artistEndDate` carries `9999` for a maker still living or active (object `20121`, "1837–present") and occasionally another future year (object `79199`, `2112`). No death or closing year lies in the future, so a bare integer later than the current UTC year normalizes to `''`, the field's documented empty value; a year up to the current one and a full date (`2005-08-01`) pass through. `artistBeginDate` is left as sent. `content[]` renders a range with one bound open (`1837–`, `–1890`) and `—` only when both are empty.
- The attribution arrives in four flat fields: `artistPrefix` (`Style of`, `Published by`), `artistDisplayName`, `artistSuffix` (`(r. 1876–1909)`, `, Paris`), and `artistRole` (`Patron`, `Publisher`). Each is free text, `''` when absent, kept raw on the record; `artistDisplayName` stays the bare name and `constituents[].name` stays as sent (the Met writes the prefix into it, not the suffix). `content[]` joins them on the Artist line: the trimmed prefix and name with a space, the trimmed suffix directly after a leading comma and after a space otherwise, the bio in parentheses as before, then ` | **Artist role:** <role>` — `**Artist:** Style of Rembrandt (Dutch, ca. 1655) | **Artist role:** Artist` for `437403`, `**Artist:** Sultan Abdülhamid II (r. 1876–1909) | **Artist role:** Patron` for `456947`. The Artist dates line is unchanged: `artistBeginDate`/`artistEndDate` belong to the person `artistDisplayName` names (Rembrandt's 1606–1669 on the "Style of" work), which their descriptions say. In the Open Access CSV, 23% of records with an artist carry a prefix on their first-listed constituent, 2.3% a suffix, and 42% a role other than `Artist`.
- `rightsAndReproduction` (free text, so italic-stripped like other prose), `metadataDate`, and `accessionYear` pass through as strings, `''` when absent. The rights line names the holder of a copyrighted work (`488978`: `© 2026 Pollock-Krasner Foundation / Artists Rights Society (ARS), New York`); most non-public-domain records carry none, so an empty value is not a reuse grant. `metadataDate` is an ISO 8601 UTC timestamp sent as is — its fraction runs from none (`2025-03-06T04:54:30Z`) to three digits — and its UTC date is what `met_list_objects` `updatedSince` (`/v1/objects` `metadataDate`) compares, that day included, which the `updatedSince` description says. `accessionYear` is a year on nearly every record, a full date on a few (`286850`: `2005-02-15`), and on 18% of CSV records the credit line names a different year or none (`437403`: credit `…Timken, 1959`, `accessionYear` `1960`); neither date is reformatted. `content[]` renders `**Accession:** <number> | **Accession year:** <year>`, then Credit, `**Rights:**`, and `**Metadata date:**` lines, each `—` when empty.
- `departmentId` is resolved from `department` through a static exact-match map (`DEPARTMENT_ID_BY_NAME`): the 19 `met_list_departments` names plus the five names records carry instead (see the table under `met_list_departments`). A name the map does not hold, an empty one included, resolves to `null`, never a guess and never `0`: a `0` reads as an ID a caller can pass on, and fails `met_list_objects` input validation (`min(1)`) instead of saying the name was not recognized. Reading the 19 `/v1/objects?departmentIds=` lists would be exact without a map, but costs 19 requests per cache window, close to the burst that has drawn the firewall block (Decision #19). `content[]` renders `**departmentId:** <id>` on the Department line, `—` for `null`.
- Free-text fields can carry raw `<i>…</i>` pairs marking foreign terms (object `21814`'s title: `Sword guard (<i>Tsuba</i>) …`). The exact `<i>` and `</i>` tokens, either case, are removed from every free-text string of the record — URL-shaped fields, `accessionNumber`, `accessionYear`, `metadataDate`, `GalleryNumber`, and the artist date bounds excepted. Both surfaces are plain text and Markdown, never HTML, so this is presentation cleanup, not sanitization: any other `<` text stays literal and is escaped at render, and a value with no token is unchanged. For `constituents[].name` the entity decode runs first: the name arrives encoded as a whole, markup included, so its `<i>` pair reaches the server as `&lt;i&gt;` and is stripped once decoded.
- Upstream catalog text is escaped at the `content[]` render boundary (`escapeMarkdown`, `src/utils/markdown.ts`) — real titles carry complete Markdown sequences. `structuredContent` keeps the raw value.
- The nine URL-shaped fields (`objectURL`, `primaryImage`, `primaryImageSmall`, `additionalImages[]`, `objectWikidata_URL`, `tags[].AAT_URL`, `tags[].Wikidata_URL`, `constituents[].constituentULAN_URL`, `constituents[].constituentWikidata_URL`) are free catalog text, not identifiers — object `288322` sends `(not assigned)` in a constituent's ULAN field. Validate each with `isHttpUrl` before rendering: an `http`/`https` value becomes a link destination unescaped, anything else renders through the prose escaper. Escaping a destination is not an option — a backslash inside one breaks the link.
- The nine findspot fields beyond `country`/`region` ship as a nested `geography` block, each defaulting to `''` when absent (see Decision #7). `country` and `region` stay top-level and are not duplicated into the block.
- `measurements` is `null` on the wire when the Met records none — pass through as nullable like `tags`/`constituents`. Within a populated array, `elementDescription` is itself nullable on the wire (object `544683`'s `Overall` element) and normalizes to `''`; `elementMeasurements` is an open `Record<string, number>` because sibling elements of one record carry different axis keys, and its keys are upstream text, so `format()` escapes them alongside the element name and description.
- The records a single call returns are bounded by a cumulative budget on serialized `structuredContent` bytes (see Decision #12). The budget is spent in request order and admits whole records only; anything that does not fit is reported in `deferred[]` with its size, never truncated or dropped. `content[]` re-renders the admitted records, so the delivered response is roughly twice the budget — the disclosure states this rather than leaving the number to read as a response cap, and adds the count and base64 size of any attached image blocks (Decision #22).
- `includeImages` (default `false`) runs after budget admission (Decision #22). Among the returned records, in request order, the first 3 with `hasCC0Image: true` have `primaryImageSmall` fetched by `MetService.fetchImage()`; each one that arrives becomes a text block `Image of object <objectID> (primaryImageSmall)` followed by `ctx.content.image(data, mimeType)`, emitted after all three settle so `content[]` keeps request order. `images[]` gives every returned record `attached`, `no_cc0_image`, `over_cap`, or `unavailable`, rendered as `## Images` after the failed and deferred sections; deferred and failed IDs get no entry. A fetch that fails still spends its slot. Off, nothing is fetched and the response carries no `images` field and no caption or image block.
- `objectIDs` is de-duplicated before fetching, first occurrence keeping its position (see Decision #13), so a repeated ID is fetched once, charged to the budget once, and appears in exactly one of `objects[]`/`failed[]`/`deferred[]`.
- Every fetch in a call shares one `MET_CALL_DEADLINE_MS` budget (Decision #18). An ID whose fetch runs out of it, or starts after it is spent, lands in `failed[]`; when that is every ID, the call throws `retry_deadline_exceeded`. A caller cancellation ends the call as cancelled rather than as a partial success.
- A `failed[]` entry is the failure's message and its recovery, with one period between them. An `upstream_blocked` entry carries that reason's recovery instead of "Retry after a brief delay", and once one ID is blocked the IDs not yet started fail with it and send no request (Decision #19).
- An `upstream_unavailable` entry (a ladder that ended on HTTP 500/502/503/504) likewise carries that reason's recovery. Once one ID's ladder ends that way, the IDs not yet started wait for every fetch still in flight; if the Met has then answered no ID in the call — no record, no 404 — they fail with the outage and send no request, so a 5xx outage costs at most `MET_BATCH_CONCURRENCY` × 4 requests (20 at the default) however many IDs were asked for. A ladder whose last attempt timed out or was reset carries no status and engages no skip; the call deadline bounds that case. Any answer turns the skip off, one that lands after the first ladder ended included, since the 5xx may then belong to one record (Decision #20).
- When nothing was fetched, the call throws in this order: `all_not_found` (every ID a 404), `upstream_blocked` (any 403), `retry_deadline_exceeded` (every ID ran out of budget), `upstream_unavailable` (any 5xx outage), then `all_failed`.
- `GalleryNumber` is `""` (not null) when off display — preserve as-is; an empty string is meaningful ("not on display").

---

### `met_list_departments`

**Purpose:** Return the 19 curatorial departments with their numeric IDs and display names. Use to discover valid `departmentId` values before calling `met_search_collections` or `met_list_objects`.

**Upstream endpoint:** `GET /v1/departments`

**Input schema:** None (no parameters).

**Output schema:**

```ts
z.object({
  departments: z.array(z.object({
    departmentId: z.number().int()
      .describe('Numeric department ID for the departmentId parameter of met_search_collections and met_list_objects.'),
    displayName: z.string()
      .describe('Human-readable department name (e.g., "European Paintings", "Egyptian Art", "Arms and Armor").'),
  })).describe('All 19 curatorial departments at The Metropolitan Museum of Art.'),
})
```

**Error contract:** No domain failures — the endpoint is static data. Three infrastructure failures are declared, so each carries its recovery; the rest bubble as `ServiceUnavailable`.

```ts
errors: [
  {
    reason: 'upstream_blocked',
    code: JsonRpcErrorCode.ServiceUnavailable,
    retryable: false,
    thrownBy: 'service', // Decision #19
    when: "The Met API's firewall refused the request with HTTP 403 — it blocks this server's address, not one endpoint.",
    recovery: 'Wait several minutes before retrying, and send fewer requests.',
  },
  {
    reason: 'upstream_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    thrownBy: 'service', // Decision #20
    when: 'The Met API answered HTTP 500, 502, 503, or 504 until the retry ladder ran out — an outage on its side.',
    recovery: 'The Met API is failing on its side, so changing the request will not help. Wait a few minutes before retrying.',
  },
  {
    reason: 'retry_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    thrownBy: 'service', // Decision #18
    when: "The call's time budget ran out, retries and backoff included, before the Met API returned a successful response.",
    recovery: "The call's time budget ran out before the Met API returned a successful response, retries included. Retry after a short wait; if it keeps happening, the Met API is likely down or overloaded.",
  },
]
```

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

**Verified departments (live API, 2026-10-04):**

| ID | Name | Record `department` (object), where it differs |
|:---|:-----|:-----|
| 1 | American Decorative Arts | The American Wing (`512`) |
| 3 | Ancient West Asian Art | |
| 4 | Arms and Armor | |
| 5 | Arts of Africa, Oceania, and the Americas | The Michael C. Rockefeller Wing (`307454`) |
| 6 | Asian Art | |
| 7 | The Cloisters | |
| 8 | The Costume Institute | Costume Institute (`100153`) |
| 9 | Drawings and Prints | |
| 10 | Egyptian Art | |
| 11 | European Paintings | |
| 12 | European Sculpture and Decorative Arts | |
| 13 | Greek and Roman Art | |
| 14 | Islamic Art | |
| 15 | The Robert Lehman Collection | Robert Lehman Collection (`458994`) |
| 16 | The Libraries | |
| 17 | Medieval Art | |
| 18 | Musical Instruments | |
| 19 | Photographs | |
| 21 | Modern Art | Modern and Contemporary Art (`488978`) |

Note: ID 20 does not exist — the sequence is not contiguous. Each record name in the third column was read from a live record on that department's `/v1/objects?departmentIds=` list; `met_get_object` resolves all 24 names to `departmentId`.

**Implementation note:** The department list is stable (static catalogue taxonomy). `met_list_departments` fetches it live on each call to remain accurate if the Met reorganizes. `departmentId` validation reads the set of valid IDs through `MetService.getValidDepartmentIds()`, which caches it in memory for one hour.

---

## Domain Mapping

| Noun | Operations | API Endpoint | Tool |
|:-----|:-----------|:-------------|:-----|
| Object | search by keyword + filters | `GET /v1.1/search` | `met_search_collections` |
| Object | list IDs by department and/or update date | `GET /v1/objects` with `departmentIds` and `metadataDate` (inclusive: a record updated on that day is listed, verified live) | `met_list_objects` |
| Object | fetch by ID (single or batch) | `GET /v1/objects/{id}` | `met_get_object` |
| Department | list all | `GET /v1/departments` | `met_list_departments` |

---

## Workflow Analysis

**Common chain:** `met_list_departments` (once, to get ID) → `met_search_collections` (get IDs) → `met_get_object` (get records)

**Browse chain:** `met_list_departments` → `met_list_objects` (IDs by department and/or update date) → `met_get_object`

The object fetch is the only multi-upstream-call tool. For a batch of N IDs:

| # | Call | Purpose | Concurrency |
|:--|:-----|:--------|:------------|
| 1…N | `GET /v1/objects/{id}` | Fetch full record per ID | Up to `MET_BATCH_CONCURRENCY` in parallel |
| +1…3 | `GET https://images.metmuseum.org/…` (`includeImages` only) | `primaryImageSmall` of the first 3 returned CC0 records | All at once, after budget admission (Decision #22) |

A fixed pool of workers drains the IDs, each result written at its input position. Successes → `objects[]`. 404s, network errors, a spent call budget, a firewall block, and a 5xx outage → `failed[]`. If `failed` is non-empty but `objects` has results, return partial success. If nothing was fetched, throw, first match winning: `all_not_found` when every ID was a 404, `upstream_blocked` when any fetch met the firewall block, `retry_deadline_exceeded` when every ID ran out of the call's budget, `upstream_unavailable` when any fetch's ladder ended on HTTP 500/502/503/504, and `all_failed` otherwise.

---

## Decisions Log

### 1. Exclude `artistOrCulture` search filter

The Met API documents `artistOrCulture=true` as a flag that restricts keyword matching to artist name and culture fields. Live probing (2026-06-01) showed it returns `{ total: 0, objectIDs: null }` for every tested query — including `Rembrandt`, `Japanese`, `Dutch`, `Egyptian` — regardless of whether those terms clearly match artist or culture records. The baseline `q` query without the flag does return results for the same terms. Conclusion: the parameter is either broken or requires an undocumented query syntax. Excluded from the tool surface to prevent agents from hitting a dead end. If the Met fixes it in a future API version, adding it to `met_search_collections` input is a non-breaking addition. Re-confirmed returning zero results for all tested queries on 2026-06-08, and on `/v1.1/search` on 2026-09-24 and 2026-10-04 (`q=sunflower&artistOrCulture=true` → `{ total: 0, objectIDs: null }`), so it stays out of `matchField` (Decision #4).

### 2. Expose `medium` as a classification filter, not a materials filter

The Met API documents `medium` as a search filter parameter. Live probing showed that passing actual material descriptions ("Oil on canvas", "Watercolor") returns 0 results, but passing classification category names ("Paintings", "Drawings", "Prints", "Ceramics", "Sculpture", "Photographs", "Textiles") returns results correctly. The `medium` parameter maps to the `classification` field on the object, not the `medium` (materials/technique) text field — a naming mismatch in the API. The filter is included in `met_search_collections` with documentation that explains classification values are required.

**Addendum (2026-09-24, `/v1.1/search`).** The match is also case-sensitive and spelling-exact, and the Met's classification names are not uniformly plural: `q=sunflower` with `Paintings` → 11, `Painting` / `paintings` / `Oil on canvas` → 0; `q=horse` with `Sculpture` → 604, `Sculptures` → 0. The `medium` description says so, and the zero-match notice names `medium` with that correction whenever it was among the filters that removed a matching keyword's results (Decision #17). The Met exposes no classification list to validate against, so the value is not checked up front.

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

**Reversed (2026-10-04): `matchField`.** Both flags are exposed as one optional input, `matchField: 'title' | 'tags'`, sent as `title=true` or `tags=true` — a caller after a named work or a subject otherwise gets title and tag hits buried under incidental text matches. Each answers a subset of the unfiltered set and composes with the filters (`q=sunflower`: `title` 36, `tags` 23, `title` + `hasImages=true` 20, the intersection), and neither affects `q=*`. One enum rather than two `true`-only booleans named after the Met's parameters: with both flags the Met answers the title set alone (36 IDs, identical to `title=true`) and silently drops `tags`, so the enum puts the exclusivity in the schema instead of a handler check. The Met ignores `title=false` and `tags=false` (178), so there is no false arm. `artistOrCulture` stays out (Decision #1). `matchField` counts as a filter in the zero-match notice (Decision #17), while the keyword-only count stays all-fields.

### 5. Batch input on `met_get_object` (max 20)

The API has no batch endpoint — each object ID requires its own HTTP GET. The search-returns-IDs-only design of the Met API makes serial fetching impractical (a 20-result search would take 20 serial round trips). Batch input drained by a fixed pool of workers, each recording its ID's outcome, solves this cleanly. Max 20 per call is a practical cap: 20 × ~150ms = ~3s worst case at concurrency 1, or ~600ms at concurrency 5. Larger batches should be multiple tool calls.

The cap bounds *latency*, not response size — a record's cost is driven by its `constituents`/`tags`/`additionalImages`/`measurements` counts, so three composite objects can cost more than twenty sparse ones. Response size is bounded separately (Decision #12); the input cap stays at 20.

### 6. Exclude `/objects` (full corpus enumeration) from the tool surface

The endpoint returns every object ID (502,828 on 2026-09-24). There is no practical agent workflow that needs to enumerate the full collection — it's too large to consume and produces no useful output on its own. Search + department filtering covers all real use cases. The `/objects?departmentIds=&metadataDate=` variant (filtering by department and update date) is marginally useful but also excluded — an agent wanting "all Egyptian Art objects" should use `met_search_collections` with `departmentId=10`.

**Reversed (2026-09-30).** Search moved to `/v1.1` (Decision #15), which pages only the first 10,000 matches of a search, needs a keyword, and cannot filter by update date. `/objects` answers the questions search can't: every object in a department, and every record created or revised since a date. `met_list_objects` exposes it with one `departmentIds` value and `metadataDate`; with neither filter it lists the whole collection, paged with no depth limit.

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

**Extended (2026-10-04).** The flat fields now carry the attribution's qualifier and role too: `artistPrefix` (`Style of`, `Published by`), `artistSuffix` (`(r. 1876–1909)`, `, Paris`), and `artistRole` (`Patron`, `Publisher`), which the lead Artist line renders. With the bare name alone, both surfaces presented a "Style of" painting as the named artist's own work and a patron as its maker; the prefix survived only inside `constituents[].name`, and the suffix and role nowhere. `artistDisplayName` stays the bare name, since search, ULAN/Wikidata matching, and the dates key on it.

### 12. Bound the returned records by cumulative bytes, not by record count

`met_get_object` returns every field of up to 20 records, and the per-record cost is set by four upstream arrays with no length cap (`constituents`, `tags`, `additionalImages`, and now `measurements`). A live 20-ID batch produced a 159,464-byte response. Nothing in the tool bounded how large a correct response could get.

The alternatives each fail on their own terms: lowering the input cap narrows the advertised `inputSchema` for every existing caller while bounding a proxy rather than the driver; truncating the heavy arrays drops data with no retrieval path; a field selector leaves the default call unchanged and would require making every currently-required output field optional; and defaulting to a compact shape silently gives existing callers less than they asked for.

The framework's `outlineOnOverflow` is built for the *one fat document* case and defaults to a 24,000-byte budget per document — applied per Met record (the heaviest measured normalizes to about 5 KB) it would never fire. `spillover()` is for tabular rows staged to a queryable canvas, and `paginateArray` paginates by element count, the proxy the measurements rule out. So this is a pattern the tool establishes rather than one it adopts, borrowing the outline technique's disclosure vocabulary — per-item sizes, an explicit re-call instruction naming the budget — without its mechanism.

**Decision.** Assemble `objects[]` in request order, admitting whole records while a cumulative 60,000-byte budget lasts, and account for every ID that did not fit in a sibling `deferred[]` carrying its `objectID` and serialized size. Three boundaries:

- **Never a partial record.** A record goes in whole or is deferred whole, so nothing downstream reasons about a half-populated object — and the per-record shape is untouched by the bound.
- **The first successful record is admitted unconditionally**, even when it alone exceeds the budget. Without that, an unusually large object would be deferred by every call that requested it and become permanently unreachable.
- **Admission stops at the first record that does not fit**, rather than packing smaller later records around it. The returned set is then a prefix of the successes and a re-call with the deferred IDs continues where the response left off.

60,000 bytes is where the advertised 20-ID cap meets the measured record size: 60,000 / 20 = 3,000 bytes per record, between a typical normalized record (about 2.2 KB across 21 live records) and the heaviest sampled one (`21940`, 5,177 bytes). A full 20-ID batch of ordinary records therefore returns whole and unchanged; only a batch whose records run heavy spends the budget early. It is a code constant, not an env var — a deploy-tunable threshold would drift the tool's response shape between environments. The attribution, rights, acquisition, and `departmentId` fields (2026-10-04) add 136–243 bytes per record (mean 169 across 21 live records and the sparse shape; the high end is a record with a rights line), and the sizes above include them, so the budget stays 60,000.

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

**Reverses** `search_timeout` (issue #11), because the upstream endpoint changed: on `/v1` one search downloaded every matching ID (`q=*` is 1.3 MB compressed and took 14.7 s on 2026-09-24), so a timeout was deterministic for that query and was surfaced non-retryable. A `/v1.1` page is at most 500 IDs (1.6 KB compressed for `q=horse`), so a timeout says nothing about the size of the result set. The relabel is removed and `search_timeout` leaves the error contract; an upstream 504/408/425 and the request timer's own abort (`errorSource: 'FetchTimeout'`) are retried by `withRetry` like any transient failure and, if they persist, surface as the upstream error — a persistent 504 as `upstream_unavailable` (Decision #20). Keying the relabel on `FetchTimeout` alone was rejected: it fixes the 504 case but keeps a transient timer abort non-retryable with a misleading "narrow the query" hint.

### 17. Compose the zero-match guidance from the levers the call used

A zero result has two causes a caller fixes differently: the keyword matches nothing, or the filters removed every match. A hint keyed on which inputs were set misfires on the first cause — it tells the caller to fix a valid filter.

**Decision.** When a filtered search returns `total: 0`, the handler issues one extra `/v1.1/search?q=…&limit=1` request and reads the keyword-only `total`. Zero → a keyword hint naming no filter. Positive → a hint naming every filter the call set, in one sentence, so one retry clears it; `medium` adds its correction (case-sensitive classification as the Met spells it, not a material; Decision #2). If the extra request fails, the hint names the filters used — the caller did set them — and the call still answers; a caller abort during it is not such a failure and ends the call as cancelled. An unfiltered zero needs no extra request. The extra request is one attempt, not a retry ladder: it only words a hint for an answer that is already a miss.

**Reverses** the `isPublicDomain` recovery branch (issue #20): the filter is gone (Decision #3), and a branch keyed on the input alone fired even when the keyword itself matched nothing. Validating `medium` against a classification list up front was rejected: the Met exposes no classification endpoint, and a hardcoded list would go stale and reject values that work.

**Revised (2026-10-04): zero matches are a success.** Zero matches is a valid answer, and `met_list_objects` already returns its empty list as one; reporting it as `isError: true` (`no_results`, `-32001`) led a client that reads `isError` as a failed call to retry or report a failure. A `total` of 0 now returns `objectIDs: []` with the guidance above, wording unchanged, as `enrichment.notice`, and `no_results` leaves the error contract — breaking for a caller keyed on the reason or the code. The notice keys on the Met's `total: 0` alone, never on an empty page, so an `offset` past the end of a nonzero `total` stays an empty page without it, and `format()` marks a zero result `(complete)` at offset 0 and `(offset beyond result set)` only at a nonzero offset. `notice` is last-wins, so the handler collects every notice for a response and writes them once, joined. Every success also echoes the applied query as `enrichment.effectiveQuery` (declared optional, written on every success path: a required enrichment field fails output validation on any path that forgets it), on `met_list_objects` too, where it is the only way to tell a blank `updatedSince` read as unset from the filter the caller meant. `met_get_object`'s `all_not_found` stays an error: there the caller named the IDs, so not finding them is a genuine miss.

### 18. One wall-clock budget per tool call

Each `MetService` retry ladder makes 4 attempts at `MET_REQUEST_TIMEOUT_MS` plus 5.25–8.75 s of backoff, so an upstream that stops answering costs about 47 s per ladder, and `met_get_object` runs one ladder per ID in waves of `MET_BATCH_CONCURRENCY`. MCP TypeScript SDK clients time a request out at 60 s by default, so a hung upstream reached the caller as an opaque transport timeout instead of the server's classified error.

**Decision.** A tool call fixes one deadline, `MET_CALL_DEADLINE_MS` (default 30,000 ms) from its start, and every service method takes it as a required argument. Each ladder hands `withRetry` the time left as its `deadlineMs`, and each attempt's request timeout is capped by it. Expiry is `Timeout` (`-32004`) with `data.reason: 'retry_deadline_exceeded'`. A ladder that starts with the budget spent fails the same way without a request. `met_search_collections`, `met_list_objects`, and `met_list_departments` declare the reason (`thrownBy: 'service'`), so the expiry reaches their callers with a recovery hint. In `met_get_object` it lands the ID in `failed[]`. When nothing was fetched and every failure is the expiry — an ID whose fetch never started included — the handler throws one batch-level `retry_deadline_exceeded` with the same recovery, after the `all_not_found` and `upstream_blocked` checks: N copies of one spent budget are one timeout, not N upstream faults, so the caller gets the `Timeout` code and the budget's recovery rather than `all_failed`'s advice about failing IDs. A 404 or an upstream error beside the expiries takes the batch past the expiry, to `upstream_unavailable` when any failure was a 5xx outage (Decision #20) and to `all_failed` otherwise. The recovery says the budget ran out before a successful response, not that the API did not answer: a ladder of fast 5xx answers spends a short budget too. The keyword-only count stays one attempt, capped the same way and skipped when nothing is left. The default is half the SDK's 60 s and above the ~9 s a fast-failing ladder (an upstream 503) needs, so a fast failure still surfaces as the outage it is (`upstream_unavailable`) rather than as the expiry. The argument is required rather than defaulted: a default would quietly bring back per-ladder budgets.

Rejected: a budget per ladder, which stacks per wave (a 20-ID batch waits `ceil(20 / MET_BATCH_CONCURRENCY) ×` the budget); and a lower `maxRetries`, which bounds attempts, not time, and drops retries that succeed after a transient blip. A caller cancellation stays a cancellation: `met_get_object`'s per-ID catch rethrows once the call's signal has aborted, so a cancelled batch never returns as a partial success.

### 19. A 403 from the Met API is a firewall block, not a failed request

The Collection API takes no credentials, so a 403 is its firewall refusing this server's address. A burst of about 22 requests in 3 minutes drew a 403 HTML block page on every endpoint for about 20 minutes, far below the documented 80 requests per second. The trigger is undetermined. Passing the 403 through told `met_get_object` callers to "retry after a brief delay", which cannot succeed.

**Decision.** `MetService` classifies an HTTP 403 as `upstream_blocked` (`ServiceUnavailable`, `retryable: false`, so `withRetry` never retries it), with a message naming the firewall and no block page in `data`. Every tool declares it with one recovery: wait several minutes, and send fewer requests. It makes no claim that retrying extends the block, which is unmeasured. In `met_get_object`, a blocked ID's `failed[]` entry carries that recovery. Once any ID is blocked, the IDs not yet started fail with the same reason and send no request, since the block covers the server's address and the remaining requests could only add traffic. A batch that fetched nothing throws `upstream_blocked` when any failure was the block, after the `all_not_found` check.

### 20. A 5xx that outlasts the retry ladder is an outage, and `met_get_object` stops feeding it

Against an upstream answering 503 to everything, each ID in a `met_get_object` batch ran its own four-attempt ladder: 8 IDs sent 32 requests and 20 IDs sent about 80, stopped only by the 30 s budget — the kind of burst that has drawn the firewall block (Decision #19). The other tools passed the failure through unclassified, with the upstream error page in `data.body` and `data.responseBody`, and an all-5xx batch ended as `all_failed`, whose recovery pointed at the IDs.

**Decision.** `MetService.retry()` rethrows a ladder that ends on HTTP 500, 502, 503, or 504 — every attempt spent, or a `Retry-After` too long to wait — as `upstream_unavailable` (`ServiceUnavailable`, no `retryable` flag, since a later call can succeed). Its `data` is `{ reason, status }`, plus the upstream's `retryAfter` when it sent a `Retry-After`; the exhausted error, page included, rides as the `cause`, which reaches the log and never the caller. A persistent 504 moves from `-32004` to `-32000`, and the ladder itself is unchanged (Decision #16). 501 is permanent and 505 a protocol mismatch, so neither is an outage and both keep their own code and message (without the page, like every HTTP failure leaving the service). Every tool declares the reason with one recovery: the failure is the Met's, so changing the request will not help; wait a few minutes. In `met_get_object`, once an ID's ladder ends that way, the IDs not yet started wait for every fetch still in flight; if the Met has then answered no ID in the call — no record, no 404 — they fail with the outage and send no request, which bounds an outage at `MET_BATCH_CONCURRENCY` × 4 requests (20 at the default; both batches above now send 20). Any answer turns the skip off, one that lands after the first ladder ended included, so which answer arrives first never decides the outcome. A batch that fetched nothing throws `upstream_unavailable` after the `all_not_found`, `upstream_blocked`, and all-expiry checks, and before `all_failed`.

Rejected: one attempt per queued ID, which still adds a request per remaining ID into the outage; an unconditional skip, which would fail healthy IDs if a 5xx were ever specific to one record (none observed); and deciding the skip the moment the first ladder ends, which fails healthy queued IDs whenever another first-wave fetch answers a moment later, and lets arrival order pick the outcome. Accepted cost: a batch whose whole first wave hit record-level 5xx fails its remaining IDs unrequested.

### 21. Departments 7 and 17: filter each page by department membership, page in the combined space

`/v1.1/search` answers `departmentId` 7 (The Cloisters) and 17 (Medieval Art) with one set, the union of both, in the same order (2026-10-04: `q=tapestry` → 165 for either; `q=*` → 9,558 for either, first 500 identical). `/v1/objects` lists them apart — 2,350 and 7,129 IDs, no overlap — so a Cloisters search returned mostly Medieval Art, the Unicorn Tapestries came back under 17, and the `departmentId` description's one curatorial department was wrong for both. Departments 3, 15, 16, and 21, sampled, return only their own objects.

**Decision.** For 7 or 17, the handler keeps the page IDs on the requested department's `/v1/objects` list (`MetService.keepDepartmentMembers()`): the sorted, cached list `met_list_objects` pages — no new cache, one load per department per hour — checked by binary search (about 12 µs for a 500-ID page against 2,350 IDs, 62 µs against 7,129). `total` stays the Met's combined count, and `truncated`, `remaining`, and `nextOffset` advance by the combined positions the page read, so walking `nextOffset` reads every combined position once and a page can hold fewer than `limit` IDs, or none, with `truncated: true`. The zero-match notice keys on the Met's `total: 0` alone, never on an emptied page. Every 7/17 response carries a notice naming both departments, saying `total` counts both and a page can hold fewer than `limit` IDs, and pointing to `met_list_objects` for exact membership; it joins any other notice in one string (`notice` is last-wins). Every other `departmentId`, and a search with none, sends the same requests and returns the same IDs and paging fields as before, with no department notice.

The list is requested after the search, and only when the page holds IDs. Requested beside the search, it would put two requests in flight at once against a firewall that blocks small bursts (Decision #19), and a miss, an offset past the end, or a failed search would still send it; after the search, the call's requests stay sequential and those cases send none. The latency cost — one list request, 143 ms and 240 ms live — falls on the first 7/17 call per department per hour. The filter is best-effort: a list that cannot be loaded — a 5xx outage (`upstream_unavailable`), a firewall block (`upstream_blocked`), or a wait on the shared load longer than one request timeout — leaves the page unfiltered, with a notice saying the department filter was not applied. After a load fails, the filter sends no list request for that department for a minute (a later successful load, `met_list_objects`' included, ends the wait early): a list-only outage would otherwise cost every 7/17 search a full retry ladder, up to four requests and about 7 s, and a paging walk would send them as a burst. A call waits on the list for at most one request timeout (`MET_REQUEST_TIMEOUT_MS`); the shared load keeps going and caches for the next call. A failed search still fails the call, and a caller abort still cancels it.

Rejected: an exact per-department `total` and dense pages, which needs every page of the union in relevance order — up to 20 requests per call for `q=*`, near the ~22-request burst that drew the block, and still inexact, since tied relevance reorders between requests. Disclosure alone, which leaves three quarters of a Cloisters `tapestry` page in the wrong department. A hybrid that is exact when the union fits one page, which gives one `departmentId` two meanings depending on keyword breadth. Accepted costs: short and empty pages; search-index IDs on neither list drop out of 7/17 pages (`q=*`: 9,558 combined against 9,479 listed, so at least 79), though a sampled index-only ID returns 404 from `/v1/objects/{id}` and so could not be fetched anyway; and a list up to an hour stale.

### 22. Opt-in image content on `met_get_object`: 3 per call, one pinned host, `content[]` only

`met_get_object` returned image URLs only, so a vision-capable model could not look at the work it was describing without a fetch the client may not offer.

**Decision.** An `includeImages` input, default `false`, attaches the `primaryImageSmall` (web-large) rendition of the first 3 CC0 records among those budget admission returned, in request order, as `ctx.content` image blocks, each after a caption text block that carries no upstream text. An optional `images[]` output gives every returned record's outcome (`attached`, `no_cc0_image`, `over_cap`, `unavailable`), so both surfaces agree on what happened.

- **Cap 3, counted in images.** The rendition is pixel-bounded (five CC0 records, 2026-10-04: long edge 599–625 px, 25.5–184.9 KB, 34–247 KB as base64), so its vision cost is roughly fixed while bytes vary sevenfold; three images run about 295 KB of base64 at the sampled mean and 740 KB at the maximum, and are enough for a side-by-side comparison. A code constant, like Decision #12's budget. A fetch that fails keeps its slot, so which records are tried never depends on the network.
- **Host pin.** Image URLs are free catalog text (object `288322` carries `(not assigned)` in a URL field), so a server-side fetch of whatever the field holds would let a record steer the hosted server's requests. `MetService.fetchImage()` requests a URL only when its parsed origin is exactly `https://images.metmuseum.org`, with `redirect: 'error'` so no redirect leaves that host; any other value is `unavailable` without a request. One attempt, no retry, its timeout the per-request timeout capped by the time left in the call's budget (Decision #18). A non-2xx, a non-`image/*` body, a redirect, a timeout, or a spent budget is `unavailable` and logged, never a failed call; a 403 from the image host is about one file, not Decision #19's firewall block. A caller abort still cancels the call.
- **Bytes ride `content[]` only.** They never enter `structuredContent` or the 60,000-byte budget, which still measures `structuredContent` alone. A client that hands the model only `structuredContent` will not show them, which the input description says. Because the blocks do land in the response, the deferred notice adds their count and base64 size to the delivered size it states — Decision #12's phrasing is load-bearing, and up to ~740 KB of base64 would make "roughly twice that" understate it badly.

The 3 image fetches run concurrently: the cap bounds them, they go to the image CDN rather than the firewalled API, and running them in turn would stack their latencies inside the shared budget.

Rejected: a separate image tool, which leaves this contract untouched but costs every client one more tool definition, and costs each image a second call plus either a record fetch from the firewall-sensitive API or a URL input needing the same pin. A byte cap, which tracks the wrong cost driver for a pixel-bounded rendition. Out of scope: `additionalImages` and the full-resolution `primaryImage`.

---

## Known Limitations

- **Search relevance is basic keyword matching** — not semantic or ranked by quality. Very common terms return thousands of matches, most of which are peripheral. `departmentId` and `geoLocation` filters are more effective than longer keyword strings.
- **Paging reaches only the first 10,000 matches of a search** — `/v1.1/search` serves nothing past `offset + limit = 10,000`, so the rest of a larger result set is reachable only by narrowing it (filters, a more specific keyword). `total` still reports the full count, and the response says so in a `notice` (Decision #15).
- **Page boundaries can repeat or skip an ID** — tied relevance scores are ordered nondeterministically across requests; full 20-page walks of `q=horse` (500 per page) returned 9,995 and 9,997 unique IDs of 10,000 on 2026-09-24. Independent calls can't prevent it.
- **`geoLocation` takes one value** — `/v1.1` applies only the first repeated value, so the schema accepts a single location. The filter matches artist nationality and other text fields, not just the object's geography fields.
- **`artistOrCulture` is not exposed** — it still answers zero for every query (Decisions Log #1); `title` and `tags` are, as `matchField` (#4). `medium` works but maps to `classification`, case-sensitively, not material descriptions.
- **No public-domain search filter** — `/v1.1/search` ignores `isPublicDomain`. CC0 status is read per object from `isPublicDomain`/`hasCC0Image` on `met_get_object`; `hasImages=true` is the nearest search narrowing and includes copyrighted works.
- **Non-public-domain objects have no image URLs** — the Met restricts images for works still under copyright. `primaryImage` and `primaryImageSmall` are empty strings; agents cannot display images for these works.
- **Attached images reach only `content[]`** — `includeImages` puts at most 3 web-large renditions per call in `content[]`, never `structuredContent`, so a client that hands the model only `structuredContent` shows none of them; `images[]` still reports each outcome (Decision #22).
- **An unknown or blank filter value widens the search upstream** — `/v1.1/search` ignores it and answers unfiltered, which is why `departmentId` is validated and blank values are rejected before any request (Decisions Log #3a).
- **Departments 7 and 17 page through one combined result set** — `/v1.1/search` answers The Cloisters (7) and Medieval Art (17) with the union of both. Each page keeps only the requested department's IDs while `total` and paging count both, so a page can hold fewer than `limit` IDs, or none, while more remain. Search-index IDs on neither department's `/v1/objects` list drop out (at least 79 for `q=*`). If the department list cannot be loaded, the page comes back unfiltered with a notice (Decision #21).
- **Object-ID lists are cached for an hour** — `met_list_objects`, and the department filter `met_search_collections` applies for 7 and 17, read each filter set's list from a cache for up to an hour, so a record created or revised very recently may not appear yet.

---

## API Reference

**Collection root:** `https://collectionapi.metmuseum.org/public/collection/` — each endpoint carries its own version

**Endpoints used:**

| Endpoint | Method | Purpose |
|:---------|:-------|:--------|
| `/v1.1/search` | GET | Search — one `offset`/`limit` page, returns `{ total, objectIDs }` |
| `/v1/objects` | GET | Every object ID matching `departmentIds` / `metadataDate` (every public object with neither), returns `{ total, objectIDs }` |
| `/v1/objects/{id}` | GET | Single object record |
| `/v1/departments` | GET | Static list of departments |

**`/v1/objects`:**
- Returns the whole matching ID set in one response, with no paging — 3.4 MB of JSON for the whole collection.
- Answers an empty result as `objectIDs: []`, not `null`, and `total` equals the array's length.
- `metadataDate` before `1753-01-01` answers `total: 0` (`1752-12-31`, `1000-01-01`, `0001-01-01`), and `metadataDate=1753-01-01` answers exactly the unfiltered ID set, so `met_list_objects` sends an earlier date as `1753-01-01`.
- The order differs on every call, so the server sorts the list before paging it.

**Error responses:**
- 404: `{ "message": "ObjectID not found" }` — object does not exist
- 403 with an HTML block page — the Met's firewall refusing this server's address, on every endpoint, for minutes at a time (Decision #19)
- 500, 502, 503, 504 with an HTML error page — an outage on the Met's side; retried, then classified as `upstream_unavailable` with the page kept out of the error (Decision #20). 501 and 505 are passed through unclassified.
- Every HTTP failure carries its page into `fetchWithTimeout`'s error as `data.body` and `data.responseBody`. No error leaving `MetService` keeps either: a 501, a 505, or a 4xx other than 403 reaches the caller with its status-mapped code, its message, and `data.status`, the page riding only on the logged `cause` (2026-10-04).
- 200 with `{ total, objectIDs: null }` — an empty search page: zero matches, or an `offset` at or past the reachable window (not an HTTP error)

**Rate limit.** The documented limit is 80 requests per second, but the firewall has blocked a burst far below it (Decision #19). Treat the API with care: no more than 5 parallel requests (handled by `MET_BATCH_CONCURRENCY`).

**No auth.** No API key. No OAuth. Plain HTTPS GET.
