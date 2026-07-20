import type * as RDF from '@rdfjs/types';

export const ENTITY_DATATYPES = [
  'wikibase-item',
  'wikibase-property',
  'string',
  'external-id',
  'url',
  'commonsMedia',
  'monolingualtext',
  'time',
  'quantity',
  'globe-coordinate',
] as const;

export type EntityDatatype = (typeof ENTITY_DATATYPES)[number];
export type EntityId = `Q${number}` | `P${number}`;
export type PropertyId = `P${number}`;
export type EntityType = 'item' | 'property';
export type Rank = 'preferred' | 'normal' | 'deprecated';
export type SnakType = 'value' | 'somevalue' | 'novalue';

export interface LanguageValue {
  language: string;
  value: string;
}

export type LanguageMap = Record<string, LanguageValue>;
export type AliasMap = Record<string, LanguageValue[]>;

export interface EntityIdValue {
  'entity-type': 'item' | 'property';
  'numeric-id'?: number;
  id: EntityId;
}

export interface MonolingualTextValue {
  language: string;
  text: string;
}

export interface TimeValue {
  time: string;
  timezone: number;
  before: number;
  after: number;
  precision: number;
  calendarmodel: string;
}

export interface QuantityValue {
  amount: string;
  unit: string;
  lowerBound?: string;
  upperBound?: string;
}

export interface GlobeCoordinateValue {
  latitude: number;
  longitude: number;
  altitude: number | null;
  precision: number | null;
  globe: string;
}

export type DataValueValue =
  | string
  | EntityIdValue
  | MonolingualTextValue
  | TimeValue
  | QuantityValue
  | GlobeCoordinateValue;

export interface DataValue {
  value: DataValueValue;
  type: string;
}

export interface Snak {
  snaktype: SnakType;
  property: PropertyId;
  hash?: string;
  datatype: EntityDatatype;
  datavalue?: DataValue;
}

export interface Reference {
  hash: string;
  snaks: Record<PropertyId, Snak[]>;
  'snaks-order': PropertyId[];
}

export interface Statement {
  id: string;
  type: 'statement';
  rank: Rank;
  mainsnak: Snak;
  qualifiers: Record<PropertyId, Snak[]>;
  'qualifiers-order': PropertyId[];
  references: Reference[];
}

export interface Sitelink {
  site: string;
  title: string;
  badges: EntityId[];
  url?: string;
}

interface EntityBase {
  id: EntityId;
  labels: LanguageMap;
  descriptions: LanguageMap;
  aliases: AliasMap;
  claims: Record<PropertyId, Statement[]>;
  lastrevid: number;
  modified: string;
}

export interface Item extends EntityBase {
  id: `Q${number}`;
  type: 'item';
  sitelinks: Record<string, Sitelink>;
}

export interface Property extends EntityBase {
  id: `P${number}`;
  type: 'property';
  datatype: EntityDatatype;
}

export type WikibaseEntity = Item | Property;

export interface MappingOptions {
  baseIri: string;
  mappingVersion?: string;
  factory?: RDF.DataFactory;
}

export interface EditMetadata {
  actor?: string;
  editSummary?: string;
}

export interface ExpectedRevision extends EditMetadata {
  expectedRevision: number;
}

export interface WriteResult {
  entityId: EntityId;
  previousRevision: number | null;
  newRevision: number;
  entity: WikibaseEntity;
  quadPatch: { deleted: number; inserted: number };
}

export interface StoredEntity {
  entity: WikibaseEntity;
  deletedAt: string | null;
  redirectTo: EntityId | null;
}

export interface RevisionEntry {
  entityId: EntityId;
  revision: number;
  entity: WikibaseEntity;
  actor: string | null;
  editSummary: string | null;
  createdAt: string;
}

export interface SearchResult {
  entityId: EntityId;
  entityType: EntityType;
  language: string;
  termType: 'label' | 'description' | 'alias';
  value: string;
}

export interface TaprootOptions extends MappingOptions {
  maxEntityBytes?: number;
}
