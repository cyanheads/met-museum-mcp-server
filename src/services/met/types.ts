/**
 * @fileoverview Raw API response types for the Met Collection API.
 * @module services/met/types
 */

/** Raw search response from GET /search */
export interface RawSearchResponse {
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
  measurements: unknown[] | null;
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
  name: string;
  role: string;
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
