/**
 * @fileoverview Raw API response types for the Met Collection API.
 * @module services/met/types
 */

/**
 * Raw search response from GET /v1.1/search — one `offset`/`limit` page.
 * `objectIDs` is null when the page is empty: no match, or an `offset` at or past
 * the reachable result set. `total` is the full match count either way.
 */
export interface RawSearchResponse {
  objectIDs: number[] | null;
  total: number;
}

/**
 * Raw ID list from GET /v1/objects — every matching ID in one response, in an
 * order that changes from call to call. `total` equals `objectIDs.length`, and a
 * filter set that matches nothing answers `objectIDs: []` (observed for a
 * `metadataDate` after the newest update).
 */
export interface RawObjectsResponse {
  /**
   * `[]` is the only empty answer observed here, but the Met's search endpoint
   * answers an empty result with `null`, so `null` is typed and read as the
   * empty list rather than failing the call.
   */
  objectIDs: number[] | null;
  total: number;
}

/** Raw object record from GET /objects/{id} */
export interface RawObjectRecord {
  accessionNumber: string;
  accessionYear: string;
  additionalImages: string[];
  artistAlphaSort: string;
  artistBeginDate: string;
  artistDisplayBio: string;
  artistDisplayName: string;
  artistEndDate: string;
  artistGender: string;
  artistNationality: string;
  artistPrefix: string;
  artistRole: string;
  artistSuffix: string;
  artistULAN_URL: string;
  artistWikidata_URL: string;
  city: string;
  classification: string;
  constituents: RawConstituent[] | null;
  country: string;
  county: string;
  creditLine: string;
  culture: string;
  department: string;
  dimensions: string;
  dynasty: string;
  excavation: string;
  GalleryNumber: string;
  geographyType: string;
  isHighlight: boolean;
  isPublicDomain: boolean;
  isTimelineWork: boolean;
  linkResource: string;
  locale: string;
  locus: string;
  measurements: RawMeasurementElement[] | null;
  medium: string;
  metadataDate: string;
  objectBeginDate: number;
  objectDate: string;
  objectEndDate: number;
  objectID: number;
  objectName: string;
  objectURL: string;
  objectWikidata_URL: string;
  period: string;
  portfolio: string;
  primaryImage: string;
  primaryImageSmall: string;
  region: string;
  reign: string;
  repository: string;
  rightsAndReproduction: string;
  river: string;
  state: string;
  subregion: string;
  tags: RawTag[] | null;
  title: string;
}

export interface RawConstituent {
  constituentID: number;
  constituentULAN_URL: string;
  constituentWikidata_URL: string;
  gender: string;
  /**
   * Entity-encoded on the wire (`Tiffany &amp; Co.`, `World&#39;s Views
   * Series`), unlike `artistDisplayName` on the same record, which carries the
   * decoded spelling. No other field the tool returns arrives encoded.
   */
  name: string;
  role: string;
}

/**
 * One measured element of an object. `elementDescription` is nullable on the
 * wire — the Met sends `null` for the unqualified element (object `544683`'s
 * `Overall` beside two described `Other` elements) — and `elementMeasurements`
 * is an open map because the keys vary per element: `Height`/`Width`/`Depth`/
 * `Thickness`/`Length` all appear, and two elements of the same record can
 * carry different ones. Spatial values are centimeters, weights kilograms.
 */
export interface RawMeasurementElement {
  elementDescription: string | null;
  elementMeasurements: Record<string, number>;
  elementName: string;
}

/**
 * The two URL fields are nullable on the wire — the Met sends `null`, not `""`,
 * for a term with no Getty/Wikidata record (confirmed on object 487659's
 * `Bow and Arrow` tag). `RawConstituent`'s sibling URL fields are not: upstream
 * sends `""` there, so a guard would be a fallback for an unobserved state.
 */
export interface RawTag {
  AAT_URL: string | null;
  term: string;
  Wikidata_URL: string | null;
}

/** Raw departments response from GET /departments */
export interface RawDepartmentsResponse {
  departments: RawDepartment[];
}

export interface RawDepartment {
  departmentId: number;
  displayName: string;
}
