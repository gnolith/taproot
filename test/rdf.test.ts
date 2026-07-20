import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as RDF from '@rdfjs/types';
import {
  buildEntityQuads,
  exportEntityJson,
  parseEntityJson,
  type EntityDatatype,
  type Snak,
  type Statement,
  type WikibaseEntity,
} from '../src/index.js';

const baseIri = 'https://knowledge.example';

function statement(
  id: string,
  property: `P${number}`,
  datatype: EntityDatatype,
  value?: unknown,
  rank: Statement['rank'] = 'normal',
): Statement {
  const mainsnak: Snak =
    value === undefined
      ? { snaktype: 'somevalue', property, datatype }
      : {
          snaktype: 'value',
          property,
          datatype,
          datavalue: {
            type: [
              'wikibase-item',
              'wikibase-property',
              'wikibase-lexeme',
              'wikibase-form',
              'wikibase-sense',
              'entity-schema',
            ].includes(datatype)
              ? 'wikibase-entityid'
              : [
                    'string',
                    'external-id',
                    'url',
                    'commonsMedia',
                    'math',
                    'musical-notation',
                    'geo-shape',
                    'tabular-data',
                  ].includes(datatype)
                ? 'string'
                : datatype,
            value: value as never,
          },
        };
  return {
    id,
    type: 'statement',
    rank,
    mainsnak,
    qualifiers: {},
    'qualifiers-order': [],
    references: [],
  };
}

describe('canonical JSON and RDF projection', () => {
  it('matches the documented Wikibase JSON/RDF fixture', () => {
    const json = readFileSync(
      new URL('./fixtures/wikibase-item.json', import.meta.url),
      'utf8',
    );
    const expected = readFileSync(
      new URL('./fixtures/wikibase-item.nq', import.meta.url),
      'utf8',
    )
      .trim()
      .split(/\r?\n/u)
      .sort();
    const quads = buildEntityQuads(parseEntityJson(json), { baseIri })
      .map(toNQuad)
      .sort();
    expect(quads).toEqual(expected);
  });

  it('round-trips canonical Wikibase-shaped JSON', () => {
    const entity: WikibaseEntity = {
      id: 'Q1',
      type: 'item',
      labels: { en: { language: 'en', value: 'Douglas Adams' } },
      descriptions: {},
      aliases: { en: [{ language: 'en', value: 'DNA' }] },
      claims: {},
      sitelinks: {
        enwiki: { site: 'enwiki', title: 'Douglas Adams', badges: [] },
      },
      lastrevid: 7,
      modified: '2026-07-20T00:00:00.000Z',
    };
    const json = exportEntityJson(entity);
    expect(exportEntityJson(parseEntityJson(json))).toBe(json);
  });

  it('normalizes every statement-id separator and trailing base slash', () => {
    const entity: WikibaseEntity = {
      id: 'Q1',
      type: 'item',
      labels: {},
      descriptions: {},
      aliases: {},
      claims: { P1: [statement('Q1$part$two', 'P1', 'string', 'value')] },
      sitelinks: {},
      lastrevid: 1,
      modified: '2026-07-20T00:00:00.000Z',
    };
    const quads = buildEntityQuads(entity, { baseIri: `${baseIri}////` });
    expect(
      quads.some(
        ({ subject }) =>
          subject.termType === 'NamedNode' &&
          subject.value ===
            'https://knowledge.example/entity/statement/Q1-part-two',
      ),
    ).toBe(true);
  });

  it('maps every required datatype and full-value fields deterministically', () => {
    const values: Array<[EntityDatatype, unknown]> = [
      ['wikibase-item', { 'entity-type': 'item', 'numeric-id': 2, id: 'Q2' }],
      [
        'wikibase-property',
        { 'entity-type': 'property', 'numeric-id': 2, id: 'P2' },
      ],
      [
        'wikibase-lexeme',
        { 'entity-type': 'lexeme', 'numeric-id': 2, id: 'L2' },
      ],
      ['wikibase-form', { 'entity-type': 'form', id: 'L2-F1' }],
      ['wikibase-sense', { 'entity-type': 'sense', id: 'L2-S1' }],
      ['entity-schema', { 'entity-type': 'entity-schema', id: 'E2' }],
      ['string', 'hello'],
      ['external-id', 'ABC-123'],
      ['url', 'https://example.test/resource'],
      ['commonsMedia', 'Example.jpg'],
      ['math', 'E = mc^2'],
      ['musical-notation', "c'4 d'4"],
      ['geo-shape', 'Data:Example.map'],
      ['tabular-data', 'Data:Example.tab'],
      ['monolingualtext', { language: 'en', text: 'hello' }],
      [
        'time',
        {
          time: '+1952-03-11T00:00:00Z',
          timezone: 0,
          before: 0,
          after: 0,
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
      ],
      [
        'quantity',
        {
          amount: '+42',
          unit: 'http://www.wikidata.org/entity/Q11573',
          lowerBound: '+41.5',
          upperBound: '+42.5',
        },
      ],
      [
        'globe-coordinate',
        {
          latitude: 51.5,
          longitude: -0.1,
          altitude: null,
          precision: 0.01,
          globe: 'http://www.wikidata.org/entity/Q2',
        },
      ],
    ];
    const claims = Object.fromEntries(
      values.map(([datatype, value], index) => {
        const property: `P${number}` = `P${index + 1}`;
        return [
          property,
          [statement(`Q1$s${index}`, property, datatype, value)],
        ];
      }),
    );
    const entity: WikibaseEntity = {
      id: 'Q1',
      type: 'item',
      labels: {},
      descriptions: {},
      aliases: {},
      claims,
      sitelinks: {},
      lastrevid: 1,
      modified: '2026-07-20T00:00:00.000Z',
    };
    const first = buildEntityQuads(entity, { baseIri });
    const second = buildEntityQuads(parseEntityJson(exportEntityJson(entity)), {
      baseIri,
    });
    expect(first.map(String)).toEqual(second.map(String));
    expect(
      first.some(
        (quad) =>
          quad.predicate.value === 'http://wikiba.se/ontology#timePrecision',
      ),
    ).toBe(true);
    expect(
      first.some(
        (quad) =>
          quad.predicate.value ===
          'http://wikiba.se/ontology#quantityLowerBound',
      ),
    ).toBe(true);
    expect(
      first.some(
        (quad) => quad.predicate.value === 'http://wikiba.se/ontology#geoGlobe',
      ),
    ).toBe(true);
  });

  it('canonicalizes nested datavalue field order before hashing or export', () => {
    const firstTime = {
      time: '+1952-03-11T00:00:00Z',
      timezone: 0,
      before: 0,
      after: 0,
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    };
    const secondTime = {
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      precision: 11,
      after: 0,
      before: 0,
      timezone: 0,
      time: '+1952-03-11T00:00:00Z',
    };
    const entity = (value: typeof firstTime): WikibaseEntity => ({
      id: 'Q1',
      type: 'item',
      labels: {},
      descriptions: {},
      aliases: {},
      claims: { P1: [statement('Q1$time', 'P1', 'time', value)] },
      sitelinks: {},
      lastrevid: 1,
      modified: '2026-07-20T00:00:00.000Z',
    });
    expect(exportEntityJson(entity(firstTime))).toBe(
      exportEntityJson(entity(secondTime)),
    );
    expect(
      buildEntityQuads(entity(firstTime), { baseIri }).map(String),
    ).toEqual(buildEntityQuads(entity(secondTime), { baseIri }).map(String));
  });

  it('implements best-rank truthy projection and special values', () => {
    const normal = statement('Q1$normal', 'P1', 'string', 'normal', 'normal');
    const preferred = statement(
      'Q1$preferred',
      'P1',
      'string',
      'preferred',
      'preferred',
    );
    const deprecated = statement(
      'Q1$deprecated',
      'P1',
      'string',
      'deprecated',
      'deprecated',
    );
    const noValue: Statement = {
      ...statement('Q1$novalue', 'P2', 'string'),
      mainsnak: { snaktype: 'novalue', property: 'P2', datatype: 'string' },
    };
    const someValue = statement('Q1$somevalue', 'P3', 'string');
    const entity: WikibaseEntity = {
      id: 'Q1',
      type: 'item',
      labels: {},
      descriptions: {},
      aliases: {},
      claims: {
        P1: [normal, preferred, deprecated],
        P2: [noValue],
        P3: [someValue],
      },
      sitelinks: {},
      lastrevid: 1,
      modified: '2026-07-20T00:00:00.000Z',
    };
    const quads = buildEntityQuads(entity, { baseIri });
    const truthy = quads.filter(
      (quad) => quad.predicate.value === `${baseIri}/prop/direct/P1`,
    );
    expect(truthy).toHaveLength(1);
    expect(truthy[0]?.object.value).toBe('preferred');
    expect(
      quads.some((quad) => quad.object.value === `${baseIri}/prop/novalue/P2`),
    ).toBe(true);
    expect(quads.some((quad) => quad.object.value.includes('somevalue-'))).toBe(
      true,
    );
  });
});

function toNQuad(quad: RDF.Quad): string {
  return `${term(quad.subject)} ${term(quad.predicate)} ${term(quad.object)} .`;
}

function term(value: RDF.Term): string {
  if (value.termType === 'NamedNode') return `<${value.value}>`;
  if (value.termType === 'Literal') {
    const lexical = JSON.stringify(value.value);
    if (value.language) return `${lexical}@${value.language}`;
    if (value.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
      return `${lexical}^^<${value.datatype.value}>`;
    }
    return lexical;
  }
  throw new TypeError(`Fixture serializer does not support ${value.termType}`);
}
