# met-museum-mcp-server — idea

The Metropolitan Museum of Art's open collection — 470,000+ artworks with full metadata (artist, date, medium, culture, provenance, dimensions) and Open Access (CC0) high-resolution images for the ~400K public-domain works. Keyless.

An encyclopedic art-history corpus spanning 5,000 years, all released under CC0. The standout is the image layer: direct, reusable high-res image URLs for public-domain works, alongside rich descriptive metadata.

**Audience:** Art lovers, educators, students, designers sourcing CC0 imagery, researchers, and agents answering "show me Van Gogh's work at the Met" or "what Egyptian objects are in the collection?"

## User Goals

- Search the collection by keyword, artist, culture, medium, or department
- Get full metadata and images for a specific artwork
- Filter to objects with open-access images (CC0, reusable)
- Browse by curatorial department
- Find works by a given artist or from a given culture/period

## API Surface

Keyless REST at `collectionapi.metmuseum.org/public/collection/v1/`. Search returns **object IDs only** — detail requires a per-ID fetch, so a batch-fetch path matters.

| Endpoint | Purpose | Notes |
|:---------|:--------|:------|
| `/search?q=` | Search → matching object IDs | Filters: `hasImages`, `departmentId`, `medium`, `geoLocation`, `dateBegin`/`dateEnd`, `isHighlight`, `title`, `artistOrCulture` |
| `/objects/{id}` | Full object record | Title, artist, date, medium, dimensions, culture, period, classification, accession, `isPublicDomain`, image URLs, tags, `objectURL` |
| `/objects` | All object IDs + total | Full enumeration (large) |
| `/departments` | 19 curatorial departments | `departmentId` for scoping searches |

Image URLs (`primaryImage`, `primaryImageSmall`, `additionalImages[]`) are direct CC0 links for public-domain works; non-public-domain objects return metadata but no open image.

## Tool Surface (sketch)

```
met_search          — search the collection. q + filters: hasImages (CC0 only),
                      departmentId, medium, geoLocation, dateBegin/dateEnd, isHighlight,
                      artistOrCulture, title. Returns total + matched object IDs.
                      Note in description: search returns IDs only — chain to met_get_object.

met_get_object      — full record for one or more object IDs (batch-friendly to avoid
                      N+1 after a search). Title, artist (+ bio dates, nationality), date,
                      medium, dimensions, culture, period, classification, accession,
                      isPublicDomain, image URLs, gallery, tags, and the Met museum page
                      URL. The hub for acting on a search hit.

met_list_departments — the 19 curatorial departments (id + name): European Paintings,
                      Egyptian Art, Asian Art, Arms and Armor, etc. Use to scope a search
                      by departmentId. Small stable list.
```

## Design Notes

- Low complexity — clean keyless REST. The one real pattern is **search-returns-IDs**: `/search` gives object IDs, not records, so `met_get_object` should accept an array and batch-fetch (with a concurrency limit + partial-success) to turn a search into displayable results without N+1 agony.
- **Lead with `hasImages`/`isPublicDomain`.** The CC0 open-access images are the standout — surface whether an object has a reusable image prominently, and return the direct image URLs so agents can embed or hand them off.
- Search relevance is basic (keyword match across fields) and can be noisy; document that `departmentId` + `artistOrCulture` filters sharpen results far more than a longer `q`.
- Return `objectURL` (the metmuseum.org page) on every object for human follow-up.
- Attribution: the Met provides the data/images under CC0 (no attribution legally required), but crediting "The Metropolitan Museum of Art" is courteous — note in README.
- Composes with `smithsonian` (search both open collections at once for a subject) and `wikidata`/`wikipedia` (enrich an artist/work with biography, movements, and context the Met record omits).
- Moonshot: a "virtual exhibition" workflow — take a theme, search, filter to CC0 images, and return a curated set with captions assembled from the metadata.

**README one-liner:** "470K+ artworks from The Met — metadata, provenance, and open-access high-res images, no key."
