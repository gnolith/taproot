import type * as RDF from '@rdfjs/types';

export const ENTITY_DATATYPES = [
  'wikibase-item',
  'wikibase-property',
  'wikibase-lexeme',
  'wikibase-form',
  'wikibase-sense',
  'entity-schema',
  'string',
  'external-id',
  'url',
  'commonsMedia',
  'monolingualtext',
  'time',
  'quantity',
  'globe-coordinate',
  'math',
  'musical-notation',
  'geo-shape',
  'tabular-data',
] as const;

export type EntityDatatype = (typeof ENTITY_DATATYPES)[number];
export type EntityId = `Q${number}` | `P${number}`;
export type ReferencedEntityId =
  | EntityId
  | `L${number}`
  | `L${number}-F${number}`
  | `L${number}-S${number}`
  | `E${number}`;
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
  'entity-type':
    'item' | 'property' | 'lexeme' | 'form' | 'sense' | 'entity-schema';
  'numeric-id'?: number;
  id: ReferencedEntityId;
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
  /** Authored natural-language description of this exact statement revision. */
  text: string;
  rank: Rank;
  mainsnak: Snak;
  qualifiers: Record<PropertyId, Snak[]>;
  'qualifiers-order': PropertyId[];
  references: Reference[];
}

export interface Sitelink {
  site: string;
  title: string;
  badges: Array<`Q${number}`>;
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

export type ActorKind = 'human' | 'agent' | 'import' | 'system';

export interface Attribution {
  id: string;
  kind: ActorKind;
  name?: string;
  organization?: string;
  tool?: string;
  url?: string;
}

export interface EditMetadata {
  /** @deprecated Use attribution. Kept for source compatibility. */
  actor?: string;
  attribution?: Attribution;
  editSummary?: string;
  tags?: string[];
  requestId?: string;
  /** Canonical authorization policy for the exact post-mutation revision. */
  authorization?: CanonicalAuthorizationPolicyInput;
  /** Package-internal normalized caller context injected by the guarded surface. */
  authorizationContext?: AuthorizationContext;
}

export interface AuthorizationContext {
  installationId: string;
  principalId: string;
  activeWorkspaceId: string | null;
  workspaceIds: readonly string[];
  capabilities: readonly string[];
  authorizationRevision: number;
}

export type VisibilityAtomV1 =
  | { kind: 'public' }
  | { kind: 'principal'; principalId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'capability'; capability: string };

export interface VisibilityScopeV1 {
  version: 1;
  /** AND of clauses; each clause is an OR of its atoms. Empty means public. */
  clauses: readonly (readonly VisibilityAtomV1[])[];
}

/**
 * Explicit complete policy for the exact post-mutation entity revision.
 * Statement keys must exactly match the statements in that revision. Each
 * value is a list of additional restrictions intersected with the entity.
 */
export interface CanonicalAuthorizationPolicyInput {
  installationId: string;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibility: VisibilityScopeV1;
  statementRestrictions: Readonly<Record<string, readonly VisibilityScopeV1[]>>;
  expectedAuthorizationRevision: number;
}

export type AuthorizedEditMetadata = Omit<EditMetadata, 'authorization'> & {
  authorization: CanonicalAuthorizationPolicyInput;
};

export interface ExpectedRevision extends EditMetadata {
  expectedRevision: number;
}

/** Explicit authored text for every statement carried into a whole-entity revision. */
export interface StatementRevisionEdit extends ExpectedRevision {
  statementTexts: Readonly<Record<string, string>>;
}

export interface WriteResult {
  entityId: EntityId;
  previousRevision: number | null;
  newRevision: number;
  entity: WikibaseEntity;
  quadPatch: { deleted: number; inserted: number };
  eventId: string;
  contentHash: string;
  authorizationRevision?: number;
  searchGeneration?: number;
}

export interface StoredEntity {
  entity: WikibaseEntity;
  deletedAt: string | null;
  redirectTo: EntityId | null;
}

export interface ResolvedEntity extends StoredEntity {
  requestedId: EntityId;
  resolvedId: EntityId;
  redirects: EntityId[];
}

export interface RevisionEntry {
  entityId: EntityId;
  revision: number;
  entity: WikibaseEntity;
  actor: string | null;
  attribution: Attribution | null;
  editSummary: string | null;
  tags: string[];
  eventId: string;
  contentHash: string;
  parentHash: string | null;
  deletedAt: string | null;
  redirectTo: EntityId | null;
  createdAt: string;
}

export type AuditEventType =
  | 'create'
  | 'update'
  | 'revert'
  | 'delete'
  | 'restore'
  | 'redirect'
  | 'import'
  | 'repair';

export interface AuditEvent {
  sequence: number;
  eventId: string;
  entityId: EntityId;
  revision: number;
  type: AuditEventType;
  attribution: Attribution | null;
  editSummary: string | null;
  tags: string[];
  requestId: string | null;
  contentHash: string;
  parentHash: string | null;
  lifecycle: { deletedAt: string | null; redirectTo: EntityId | null };
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export interface EntityListEntry extends StoredEntity {
  entityId: EntityId;
}

export interface IntegrityIssue {
  code:
    | 'current-revision-mismatch'
    | 'revision-json-mismatch'
    | 'content-hash-mismatch'
    | 'audit-event-missing'
    | 'term-projection-mismatch'
    | 'rdf-projection-mismatch';
  message: string;
}

export interface EntityIntegrityReport {
  entityId: EntityId;
  revision: number;
  valid: boolean;
  issues: IntegrityIssue[];
}

export interface BulkImportResult {
  succeeded: WriteResult[];
  failed: Array<{ index: number; entityId?: EntityId; error: Error }>;
}

export interface TaprootObservation {
  operation: string;
  outcome: 'success' | 'error';
  durationMs: number;
  entityId?: EntityId;
  revision?: number;
  error?: unknown;
}

export type EntityCommand =
  | { type: 'set-label'; language: string; value: string }
  | { type: 'remove-label'; language: string }
  | { type: 'set-description'; language: string; value: string }
  | { type: 'remove-description'; language: string }
  | { type: 'add-alias'; language: string; value: string }
  | { type: 'remove-alias'; language: string; ordinal: number }
  | { type: 'set-sitelink'; site: string; value: Sitelink }
  | { type: 'remove-sitelink'; site: string }
  | { type: 'add-statement'; statement: Statement }
  | { type: 'replace-statement'; statementId: string; statement: Statement }
  | { type: 'remove-statement'; statementId: string }
  | {
      type: 'set-statement-rank';
      statementId: string;
      rank: Rank;
      text: string;
    }
  | { type: 'add-qualifier'; statementId: string; snak: Snak; text: string }
  | {
      type: 'remove-qualifier';
      statementId: string;
      property: PropertyId;
      ordinal: number;
      text: string;
    }
  | {
      type: 'add-reference';
      statementId: string;
      reference: Reference;
      text: string;
    }
  | {
      type: 'replace-reference';
      statementId: string;
      hash: string;
      reference: Reference;
      text: string;
    }
  | {
      type: 'remove-reference';
      statementId: string;
      hash: string;
      text: string;
    };

export type TaprootValidator = (
  entity: WikibaseEntity,
  context: { previous: WikibaseEntity | null; metadata: EditMetadata },
) => void | Promise<void>;

export interface SearchResult {
  entityId: EntityId;
  entityType: EntityType;
  language: string;
  termType: 'label' | 'description' | 'alias';
  value: string;
}

export interface TaprootOptions extends MappingOptions {
  maxEntityBytes?: number;
  maxBulkEntities?: number;
  clock?: () => Date;
  createId?: () => string;
  validators?: TaprootValidator[];
  observe?: (observation: TaprootObservation) => void | Promise<void>;
  requireAttribution?: boolean;
}
