/**
 * @fileoverview Cross-tool guard: no `format()` in this server may interpolate
 * an upstream text value into `content[]` unescaped.
 *
 * The fixture is derived from each tool's own `output` schema rather than
 * hand-listed, so a rendered text field added later is probed automatically —
 * a per-tool spot check would silently skip it.
 *
 * @module tests/format-escaping.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metGetObject } from '@/mcp-server/tools/definitions/met-get-object.tool.js';
import { metListDepartments } from '@/mcp-server/tools/definitions/met-list-departments.tool.js';
import { metSearchCollections } from '@/mcp-server/tools/definitions/met-search-collections.tool.js';
import { initMetService } from '@/services/met/met-service.js';
import { escapeMarkdown } from '@/utils/markdown.js';

/** Every character in the escape set, so any missed field shows up. */
const PROBE_METACHARACTERS = '[*_`\\<]';

/**
 * Upstream string leaves that reach `content[]` as a link destination when — and
 * only when — they parse as an `http`/`https` URL.
 *
 * They arrive from the Met API like every prose field and none is reliably a
 * URL, so a backslash-escaped destination is not the fix (it breaks the link)
 * and passing the value through untouched is not either. Both halves are
 * exercised below: a parsing value must survive verbatim, a non-parsing one must
 * come through the prose escaper.
 */
const URL_SHAPED_PATHS = new Set([
  'objects[].objectURL',
  'objects[].primaryImage',
  'objects[].primaryImageSmall',
  'objects[].additionalImages[]',
  'objects[].objectWikidata_URL',
  'objects[].tags[].AAT_URL',
  'objects[].tags[].Wikidata_URL',
  'objects[].constituents[].constituentULAN_URL',
  'objects[].constituents[].constituentWikidata_URL',
]);

/** Composed by the handler, not carried from upstream — nothing to escape. */
const SERVER_COMPOSED_PATHS = new Set(['failed[].error']);

/** Path-derived tag so a mis-rendered field names itself in the failure. */
function tagFor(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, 'Q');
}

/** An underscore in the path makes an accidental escape visible in the URL too. */
function urlFor(path: string): string {
  return `https://example.com/u_${tagFor(path)}`;
}

function probeFor(path: string): string {
  return `PROBE${tagFor(path)}${PROBE_METACHARACTERS}`;
}

/**
 * A URL-shaped value that is not a URL: it closes the server's own link
 * destination early and opens an attacker-controlled one, then trails emphasis.
 */
function hostileFor(path: string): string {
  return `a) [go](https://evil.example/${tagFor(path)})_*`;
}

/**
 * The value a path carries whenever it is expected to render as escaped prose —
 * a plain probe for a prose field, the hostile look-alike for a URL-shaped one.
 */
function proseValueFor(path: string): string {
  return URL_SHAPED_PATHS.has(path) ? hostileFor(path) : probeFor(path);
}

type ZodDef = {
  type: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
  valueType?: unknown;
};

function zodDef(schema: unknown): ZodDef | undefined {
  return (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;
}

interface Synthetic {
  /** Paths whose value is a probe that must appear escaped in the render. */
  probes: string[];
  /** Paths whose value is a real URL that must appear verbatim in the render. */
  urls: string[];
  value: unknown;
}

/**
 * How the URL-shaped leaves are populated for one pass: `'valid'` gives each a
 * real https URL (which must reach `content[]` untouched), `'hostile'` gives it
 * a value that only looks like one (which must reach `content[]` escaped).
 */
type UrlMode = 'valid' | 'hostile';

/**
 * Build a fully populated synthetic result from an output schema, tagging every
 * string leaf as a probe (upstream prose, must render escaped), a URL (must
 * render verbatim), or server-composed (rendered as-is, nothing to assert).
 * Optional/nullable/default wrappers are transparent — parity is about what
 * `format()` does with a value that IS present.
 */
function synthesize(
  schema: unknown,
  urlMode: UrlMode,
  path = '',
  numberSeed = { n: 0 },
): Synthetic {
  let node = schema;
  for (let i = 0; i < 10; i++) {
    const type = zodDef(node)?.type;
    if (type !== 'optional' && type !== 'nullable' && type !== 'default') break;
    node = zodDef(node)?.innerType;
  }

  const def = zodDef(node);
  switch (def?.type) {
    case 'object': {
      const value: Record<string, unknown> = {};
      const probes: string[] = [];
      const urls: string[] = [];
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        const childPath = path ? `${path}.${key}` : key;
        const result = synthesize(child, urlMode, childPath, numberSeed);
        value[key] = result.value;
        probes.push(...result.probes);
        urls.push(...result.urls);
      }
      return { value, probes, urls };
    }
    case 'array': {
      const result = synthesize(def.element, urlMode, `${path}[]`, numberSeed);
      return { value: [result.value], probes: result.probes, urls: result.urls };
    }
    /**
     * An open map's KEYS are upstream text too — `measurements[].elementMeasurements`
     * is keyed by whatever axis names the Met sends — so the key carries the probe,
     * not just the value. Without this case the walk falls to `default:` and hands
     * `format()` a null, leaving both the key and the value unexercised.
     */
    case 'record': {
      const keyPath = `${path}{key}`;
      const value = synthesize(def.valueType, urlMode, `${path}{value}`, numberSeed);
      return {
        value: { [proseValueFor(keyPath)]: value.value },
        probes: [keyPath, ...value.probes],
        urls: value.urls,
      };
    }
    case 'string': {
      if (SERVER_COMPOSED_PATHS.has(path)) return { value: urlFor(path), probes: [], urls: [] };
      if (URL_SHAPED_PATHS.has(path) && urlMode === 'valid') {
        return { value: urlFor(path), probes: [], urls: [path] };
      }
      return { value: proseValueFor(path), probes: [path], urls: [] };
    }
    case 'number':
    case 'int':
      return { value: 1000 + numberSeed.n++, probes: [], urls: [] };
    case 'boolean':
      return { value: true, probes: [], urls: [] };
    default:
      return { value: null, probes: [], urls: [] };
  }
}

/**
 * Concatenate a tool's rendered `content[]` text. Deliberately untyped in the
 * result position — this harness drives every tool's `format()` through one
 * call site, and each carries its own output type.
 */
function render(format: unknown, value: unknown): string {
  const blocks = (format as (result: unknown) => { text?: string }[])(value);
  return blocks.map((block) => block.text ?? '').join('\n');
}

const tools = [
  { name: 'met_get_object', def: metGetObject },
  { name: 'met_list_departments', def: metListDepartments },
  { name: 'met_search_collections', def: metSearchCollections },
] as const;

describe('content[] escaping — every tool, every rendered upstream text field', () => {
  for (const { name, def } of tools) {
    describe(name, () => {
      const valid = synthesize(def.output, 'valid');
      const validText = render(def.format!, valid.value);

      const hostile = synthesize(def.output, 'hostile');
      const hostileText = render(def.format!, hostile.value);

      it('renders every upstream text field escaped, and none of them raw', () => {
        const unescaped = valid.probes.filter((path) => validText.includes(proseValueFor(path)));
        expect(unescaped, 'these output paths reach content[] unescaped').toEqual([]);

        const missing = valid.probes.filter(
          (path) => !validText.includes(escapeMarkdown(proseValueFor(path))),
        );
        expect(missing, 'these output paths render neither raw nor escaped').toEqual([]);
      });

      it('renders a URL-shaped field verbatim when it parses as an http URL', () => {
        const corrupted = valid.urls.filter((path) => !validText.includes(urlFor(path)));
        expect(corrupted, 'these URL paths were altered before rendering').toEqual([]);
      });

      it('escapes a URL-shaped field whose value is not an http URL', () => {
        // Same paths, a value that only looks like a destination. Rendered raw
        // it would close the server's own `[label](` early and open its own.
        const injected = hostile.probes.filter((path) => hostileText.includes(proseValueFor(path)));
        expect(injected, 'these paths render a non-URL value as a live destination').toEqual([]);

        const missing = hostile.probes.filter(
          (path) => !hostileText.includes(escapeMarkdown(proseValueFor(path))),
        );
        expect(missing, 'these paths render neither raw nor escaped').toEqual([]);
      });

      it('leaves the server-written Markdown scaffolding unescaped', () => {
        // Bold labels and the link wrapper are the server's own syntax, never
        // routed through the escape helper.
        expect(validText).not.toContain('\\*\\*');
        expect(validText).not.toContain('\\#\\#');
      });
    });
  }
});

describe('structuredContent is untouched by the render-boundary escaping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('met_get_object handler output keeps raw upstream values byte-identical', async () => {
    const rawTitle = '[Group of 122 Stereograph Views] *of* Egypt_1 <b>';
    /** Object 288322's constituent 92583 really carries this in its ULAN field. */
    const rawUlan = '(not assigned)';
    const record = {
      objectID: 288322,
      title: rawTitle,
      isPublicDomain: false,
      primaryImage: '',
      primaryImageSmall: '',
      additionalImages: [],
      objectURL: 'https://www.metmuseum.org/art/collection/search/288322',
      department: 'Photographs',
      objectName: 'Photographs',
      classification: 'Photographs',
      isHighlight: false,
      isTimelineWork: false,
      artistDisplayName: '',
      artistDisplayBio: '',
      artistNationality: '',
      artistBeginDate: '',
      artistEndDate: '',
      constituents: [
        {
          constituentID: 92583,
          role: 'Artist',
          name: 'Truman Ward Ingersoll',
          constituentULAN_URL: rawUlan,
          constituentWikidata_URL: 'https://www.wikidata.org/wiki/Q59238987',
          gender: '',
        },
      ],
      objectDate: '1860s–80s',
      objectBeginDate: 1860,
      objectEndDate: 1889,
      medium: 'Albumen silver prints',
      dimensions: 'Various',
      culture: '',
      period: '',
      dynasty: '',
      accessionNumber: '2005.100.1191 (1–122)',
      creditLine: 'Gilman Collection, Purchase, 2005',
      country: '',
      region: '',
      tags: null,
      objectWikidata_URL: '',
      GalleryNumber: '',
    };

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json' } }),
        ),
    );
    initMetService({} as AppConfig, createInMemoryStorage());

    const ctx = createMockContext({ errors: metGetObject.errors });
    const input = metGetObject.input.parse({ objectIDs: [288322] });
    const result = await metGetObject.handler(input, ctx);

    // The machine surface carries the raw value; only content[] is escaped.
    expect(result.objects[0]?.title).toBe(rawTitle);
    expect(render(metGetObject.format!, result)).toContain(escapeMarkdown(rawTitle));

    // URL-shaped fields are validated at the render boundary too, so the raw
    // value must survive on the machine surface whether it parsed or not.
    expect(result.objects[0]?.constituents?.[0]?.constituentULAN_URL).toBe(rawUlan);
    expect(result.objects[0]?.objectURL).toBe(
      'https://www.metmuseum.org/art/collection/search/288322',
    );
  });
});
