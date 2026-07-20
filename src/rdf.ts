import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { withoutTrailingSlashes } from './iri.js';
import { exportEntityJson } from './canonical.js';
import type {
  DataValueValue,
  EntityDatatype,
  MappingOptions,
  PropertyId,
  Snak,
  Statement,
  WikibaseEntity,
} from './types.js';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const SCHEMA = 'http://schema.org/';
const WIKIBASE = 'http://wikiba.se/ontology#';
const GEO = 'http://www.opengis.net/ont/geosparql#';
const PROV = 'http://www.w3.org/ns/prov#';

interface Namespaces {
  entity: string;
  statement: string;
  value: string;
  reference: string;
  direct: string;
  claim: string;
  statementProperty: string;
  statementValue: string;
  qualifier: string;
  qualifierValue: string;
  referenceProperty: string;
  referenceValue: string;
  novalue: string;
  vocab: string;
}

/** Builds the complete deterministic RDF closure owned by one entity. */
export function buildEntityQuads(
  entity: WikibaseEntity,
  options: MappingOptions,
): RDF.Quad[] {
  entity = JSON.parse(exportEntityJson(entity)) as WikibaseEntity;
  const factory = options.factory ?? new DataFactory();
  const ns = namespaces(options.baseIri);
  const quads: RDF.Quad[] = [];
  const subject = factory.namedNode(`${ns.entity}${entity.id}`);
  const quad = (s: RDF.Quad_Subject, p: string, o: RDF.Quad_Object) =>
    quads.push(factory.quad(s, factory.namedNode(p), o));

  quad(
    subject,
    `${RDF_NS}type`,
    factory.namedNode(
      `${WIKIBASE}${entity.type === 'item' ? 'Item' : 'Property'}`,
    ),
  );
  quad(
    subject,
    `${ns.vocab}revision`,
    typedLiteral(factory, String(entity.lastrevid), `${XSD}integer`),
  );
  quad(
    subject,
    `${ns.vocab}mappingVersion`,
    factory.literal(options.mappingVersion ?? '2'),
  );
  for (const term of Object.values(entity.labels)) {
    quad(subject, `${RDFS}label`, factory.literal(term.value, term.language));
    quad(subject, `${SCHEMA}name`, factory.literal(term.value, term.language));
    quad(
      subject,
      `${SKOS}prefLabel`,
      factory.literal(term.value, term.language),
    );
  }
  for (const term of Object.values(entity.descriptions)) {
    quad(
      subject,
      `${SCHEMA}description`,
      factory.literal(term.value, term.language),
    );
  }
  for (const aliases of Object.values(entity.aliases)) {
    for (const term of aliases) {
      quad(
        subject,
        `${SKOS}altLabel`,
        factory.literal(term.value, term.language),
      );
    }
  }
  if (entity.type === 'property') {
    addPropertyDeclarations(
      entity.id,
      entity.datatype,
      subject,
      factory,
      ns,
      quad,
    );
  }

  for (const [property, statements] of Object.entries(entity.claims) as Array<
    [PropertyId, Statement[]]
  >) {
    const preferred = statements.filter(({ rank }) => rank === 'preferred');
    const best = preferred.length
      ? new Set(preferred)
      : new Set(statements.filter(({ rank }) => rank === 'normal'));
    for (const statement of statements) {
      addStatement(
        statement,
        subject,
        property,
        best.has(statement),
        factory,
        ns,
        quad,
      );
    }
  }
  return deduplicateAndSort(quads);
}

function addPropertyDeclarations(
  property: PropertyId,
  datatype: EntityDatatype,
  subject: RDF.NamedNode,
  factory: RDF.DataFactory,
  ns: Namespaces,
  quad: (s: RDF.Quad_Subject, p: string, o: RDF.Quad_Object) => void,
): void {
  const declarations: Array<[string, string]> = [
    ['directClaim', ns.direct],
    ['claim', ns.claim],
    ['statementProperty', ns.statementProperty],
    ['statementValue', ns.statementValue],
    ['qualifier', ns.qualifier],
    ['qualifierValue', ns.qualifierValue],
    ['reference', ns.referenceProperty],
    ['referenceValue', ns.referenceValue],
    ['novalue', ns.novalue],
  ];
  for (const [predicate, namespace] of declarations) {
    quad(
      subject,
      `${WIKIBASE}${predicate}`,
      factory.namedNode(`${namespace}${property}`),
    );
  }
  quad(
    factory.namedNode(`${ns.novalue}${property}`),
    `${RDF_NS}type`,
    factory.namedNode('http://www.w3.org/2002/07/owl#Class'),
  );
  quad(
    subject,
    `${WIKIBASE}propertyType`,
    factory.namedNode(`${WIKIBASE}${datatypeClass(datatype)}`),
  );
}

function addStatement(
  statement: Statement,
  entity: RDF.NamedNode,
  property: PropertyId,
  bestRank: boolean,
  factory: RDF.DataFactory,
  ns: Namespaces,
  quad: (s: RDF.Quad_Subject, p: string, o: RDF.Quad_Object) => void,
): void {
  const statementNode = factory.namedNode(
    `${ns.statement}${encodeURIComponent(statement.id.replaceAll('$', '-'))}`,
  );
  quad(entity, `${ns.claim}${property}`, statementNode);
  quad(
    statementNode,
    `${RDF_NS}type`,
    factory.namedNode(`${WIKIBASE}Statement`),
  );
  quad(
    statementNode,
    `${WIKIBASE}rank`,
    factory.namedNode(`${WIKIBASE}${capitalize(statement.rank)}Rank`),
  );
  if (bestRank)
    quad(
      statementNode,
      `${RDF_NS}type`,
      factory.namedNode(`${WIKIBASE}BestRank`),
    );
  addSnak(
    statement.mainsnak,
    statementNode,
    ns.statementProperty,
    ns.statementValue,
    `statement:${statement.id}:main`,
    factory,
    ns,
    quad,
  );
  if (bestRank) {
    addTruthySnak(
      statement.mainsnak,
      entity,
      `statement:${statement.id}:truthy`,
      factory,
      ns,
      quad,
    );
  }

  for (const propertyId of statement['qualifiers-order']) {
    for (const [index, snak] of (
      statement.qualifiers[propertyId] ?? []
    ).entries()) {
      addSnak(
        snak,
        statementNode,
        ns.qualifier,
        ns.qualifierValue,
        `statement:${statement.id}:qualifier:${propertyId}:${index}`,
        factory,
        ns,
        quad,
      );
    }
  }
  for (const reference of statement.references) {
    const referenceNode = factory.namedNode(
      `${ns.reference}${encodeURIComponent(reference.hash)}`,
    );
    quad(statementNode, `${SCHEMA}isBasedOn`, referenceNode);
    quad(statementNode, `${PROV}wasDerivedFrom`, referenceNode);
    quad(
      referenceNode,
      `${RDF_NS}type`,
      factory.namedNode(`${WIKIBASE}Reference`),
    );
    for (const propertyId of reference['snaks-order']) {
      for (const [index, snak] of (
        reference.snaks[propertyId] ?? []
      ).entries()) {
        addSnak(
          snak,
          referenceNode,
          ns.referenceProperty,
          ns.referenceValue,
          `reference:${reference.hash}:${propertyId}:${index}`,
          factory,
          ns,
          quad,
        );
      }
    }
  }
}

function addTruthySnak(
  snak: Snak,
  subject: RDF.NamedNode,
  scope: string,
  factory: RDF.DataFactory,
  ns: Namespaces,
  quad: (s: RDF.Quad_Subject, p: string, o: RDF.Quad_Object) => void,
): void {
  if (snak.snaktype === 'novalue') {
    quad(
      subject,
      `${RDF_NS}type`,
      factory.namedNode(`${ns.novalue}${snak.property}`),
    );
    return;
  }
  const object = snakObject(snak, scope, factory, ns);
  quad(subject, `${ns.direct}${snak.property}`, object);
}

function addSnak(
  snak: Snak,
  subject: RDF.NamedNode,
  simpleNamespace: string,
  valueNamespace: string,
  scope: string,
  factory: RDF.DataFactory,
  ns: Namespaces,
  quad: (s: RDF.Quad_Subject, p: string, o: RDF.Quad_Object) => void,
): void {
  if (snak.snaktype === 'novalue') {
    quad(
      subject,
      `${RDF_NS}type`,
      factory.namedNode(`${ns.novalue}${snak.property}`),
    );
    return;
  }
  const object = snakObject(snak, scope, factory, ns);
  quad(subject, `${simpleNamespace}${snak.property}`, object);
  if (snak.snaktype === 'value' && isFullValueDatatype(snak.datatype)) {
    const valueNode = fullValueNode(snak, factory, ns);
    quad(subject, `${valueNamespace}${snak.property}`, valueNode);
    addFullValue(snak, valueNode, factory, quad);
  }
}

function snakObject(
  snak: Snak,
  scope: string,
  factory: RDF.DataFactory,
  ns: Namespaces,
): RDF.Quad_Object {
  if (snak.snaktype === 'somevalue') {
    return factory.namedNode(
      `${ns.value}somevalue-${stableId(`${scope}:${snak.property}`)}`,
    );
  }
  if (!snak.datavalue)
    throw new TypeError('Validated value snak lacks datavalue');
  return simpleValue(snak.datatype, snak.datavalue.value, factory, ns);
}

function simpleValue(
  datatype: EntityDatatype,
  value: DataValueValue,
  factory: RDF.DataFactory,
  ns: Namespaces,
): RDF.Quad_Object {
  switch (datatype) {
    case 'wikibase-item':
    case 'wikibase-property':
    case 'wikibase-lexeme':
    case 'wikibase-form':
    case 'wikibase-sense':
    case 'entity-schema':
      return factory.namedNode(`${ns.entity}${(value as { id: string }).id}`);
    case 'url':
      return factory.namedNode(value as string);
    case 'commonsMedia':
      return factory.namedNode(
        `http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(value as string)}`,
      );
    case 'geo-shape':
    case 'tabular-data':
      return factory.namedNode(
        `http://commons.wikimedia.org/data/${encodeURIComponent(value as string)}`,
      );
    case 'monolingualtext': {
      const text = value as { text: string; language: string };
      return factory.literal(text.text, text.language);
    }
    case 'time':
      return typedLiteral(
        factory,
        normalizeTime((value as { time: string }).time),
        `${XSD}dateTime`,
      );
    case 'quantity':
      return typedLiteral(
        factory,
        (value as { amount: string }).amount.replace(/^\+/u, ''),
        `${XSD}decimal`,
      );
    case 'globe-coordinate': {
      const point = value as { longitude: number; latitude: number };
      return typedLiteral(
        factory,
        `Point(${point.longitude} ${point.latitude})`,
        `${GEO}wktLiteral`,
      );
    }
    default:
      return factory.literal(value as string);
  }
}

function fullValueNode(
  snak: Snak,
  factory: RDF.DataFactory,
  ns: Namespaces,
): RDF.NamedNode {
  return factory.namedNode(
    `${ns.value}${stableId(JSON.stringify({ datatype: snak.datatype, value: snak.datavalue?.value }))}`,
  );
}

function addFullValue(
  snak: Snak,
  node: RDF.NamedNode,
  factory: RDF.DataFactory,
  quad: (s: RDF.Quad_Subject, p: string, o: RDF.Quad_Object) => void,
): void {
  const value = snak.datavalue?.value;
  if (!value || typeof value !== 'object') return;
  if (snak.datatype === 'time') {
    const time = value as {
      time: string;
      timezone: number;
      before: number;
      after: number;
      precision: number;
      calendarmodel: string;
    };
    quad(node, `${RDF_NS}type`, factory.namedNode(`${WIKIBASE}TimeValue`));
    quad(
      node,
      `${WIKIBASE}timeValue`,
      typedLiteral(factory, normalizeTime(time.time), `${XSD}dateTime`),
    );
    quad(
      node,
      `${WIKIBASE}timeTimezone`,
      typedLiteral(factory, String(time.timezone), `${XSD}integer`),
    );
    quad(
      node,
      `${WIKIBASE}timeBefore`,
      typedLiteral(factory, String(time.before), `${XSD}integer`),
    );
    quad(
      node,
      `${WIKIBASE}timeAfter`,
      typedLiteral(factory, String(time.after), `${XSD}integer`),
    );
    quad(
      node,
      `${WIKIBASE}timePrecision`,
      typedLiteral(factory, String(time.precision), `${XSD}integer`),
    );
    quad(
      node,
      `${WIKIBASE}timeCalendarModel`,
      factory.namedNode(time.calendarmodel),
    );
  } else if (snak.datatype === 'quantity') {
    const quantity = value as {
      amount: string;
      unit: string;
      lowerBound?: string;
      upperBound?: string;
    };
    quad(node, `${RDF_NS}type`, factory.namedNode(`${WIKIBASE}QuantityValue`));
    quad(
      node,
      `${WIKIBASE}quantityAmount`,
      typedLiteral(
        factory,
        quantity.amount.replace(/^\+/u, ''),
        `${XSD}decimal`,
      ),
    );
    quad(
      node,
      `${WIKIBASE}quantityUnit`,
      quantity.unit === '1'
        ? factory.literal('1')
        : factory.namedNode(quantity.unit),
    );
    if (quantity.lowerBound !== undefined)
      quad(
        node,
        `${WIKIBASE}quantityLowerBound`,
        typedLiteral(
          factory,
          quantity.lowerBound.replace(/^\+/u, ''),
          `${XSD}decimal`,
        ),
      );
    if (quantity.upperBound !== undefined)
      quad(
        node,
        `${WIKIBASE}quantityUpperBound`,
        typedLiteral(
          factory,
          quantity.upperBound.replace(/^\+/u, ''),
          `${XSD}decimal`,
        ),
      );
  } else if (snak.datatype === 'globe-coordinate') {
    const coordinate = value as {
      latitude: number;
      longitude: number;
      altitude: number | null;
      precision: number | null;
      globe: string;
    };
    quad(
      node,
      `${RDF_NS}type`,
      factory.namedNode(`${WIKIBASE}GlobeCoordinateValue`),
    );
    quad(
      node,
      `${WIKIBASE}geoLatitude`,
      typedLiteral(factory, String(coordinate.latitude), `${XSD}double`),
    );
    quad(
      node,
      `${WIKIBASE}geoLongitude`,
      typedLiteral(factory, String(coordinate.longitude), `${XSD}double`),
    );
    if (coordinate.altitude !== null)
      quad(
        node,
        `${WIKIBASE}geoAltitude`,
        typedLiteral(factory, String(coordinate.altitude), `${XSD}double`),
      );
    if (coordinate.precision !== null)
      quad(
        node,
        `${WIKIBASE}geoPrecision`,
        typedLiteral(factory, String(coordinate.precision), `${XSD}double`),
      );
    quad(node, `${WIKIBASE}geoGlobe`, factory.namedNode(coordinate.globe));
  }
}

function namespaces(baseIri: string): Namespaces {
  const base = withoutTrailingSlashes(baseIri);
  if (!/^https?:\/\//u.test(base))
    throw new TypeError('baseIri must be an absolute HTTP(S) IRI');
  return {
    entity: `${base}/entity/`,
    statement: `${base}/entity/statement/`,
    value: `${base}/value/`,
    reference: `${base}/reference/`,
    direct: `${base}/prop/direct/`,
    claim: `${base}/prop/`,
    statementProperty: `${base}/prop/statement/`,
    statementValue: `${base}/prop/statement/value/`,
    qualifier: `${base}/prop/qualifier/`,
    qualifierValue: `${base}/prop/qualifier/value/`,
    referenceProperty: `${base}/prop/reference/`,
    referenceValue: `${base}/prop/reference/value/`,
    novalue: `${base}/prop/novalue/`,
    vocab: `${base}/vocab/`,
  };
}

export function wikibasePrefixes(baseIri: string): Record<string, string> {
  const ns = namespaces(baseIri);
  return {
    wd: ns.entity,
    wds: ns.statement,
    wdv: ns.value,
    wdref: ns.reference,
    wdt: ns.direct,
    p: ns.claim,
    ps: ns.statementProperty,
    psv: ns.statementValue,
    pq: ns.qualifier,
    pqv: ns.qualifierValue,
    pr: ns.referenceProperty,
    prv: ns.referenceValue,
    wdno: ns.novalue,
    wikibase: WIKIBASE,
  };
}

function datatypeClass(datatype: EntityDatatype): string {
  return {
    'wikibase-item': 'WikibaseItem',
    'wikibase-property': 'WikibaseProperty',
    'wikibase-lexeme': 'WikibaseLexeme',
    'wikibase-form': 'WikibaseForm',
    'wikibase-sense': 'WikibaseSense',
    'entity-schema': 'EntitySchema',
    string: 'String',
    'external-id': 'ExternalId',
    url: 'Url',
    commonsMedia: 'CommonsMedia',
    monolingualtext: 'Monolingualtext',
    time: 'Time',
    quantity: 'Quantity',
    'globe-coordinate': 'GlobeCoordinate',
    math: 'Math',
    'musical-notation': 'MusicalNotation',
    'geo-shape': 'GeoShape',
    'tabular-data': 'TabularData',
  }[datatype];
}

function isFullValueDatatype(datatype: EntityDatatype): boolean {
  return (
    datatype === 'time' ||
    datatype === 'quantity' ||
    datatype === 'globe-coordinate'
  );
}

function typedLiteral(
  factory: RDF.DataFactory,
  value: string,
  datatype: string,
): RDF.Literal {
  return factory.literal(value, factory.namedNode(datatype));
}

function normalizeTime(value: string): string {
  return value.replace(/^\+/u, '');
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function stableId(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function deduplicateAndSort(quads: RDF.Quad[]): RDF.Quad[] {
  const entries = new Map<string, RDF.Quad>();
  for (const quad of quads) entries.set(quadKey(quad), quad);
  return [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, quad]) => quad);
}

function quadKey(quad: RDF.Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph]
    .map(
      (term) =>
        `${term.termType}:${term.value}:${'language' in term ? term.language : ''}:${'datatype' in term ? term.datatype.value : ''}`,
    )
    .join('|');
}
