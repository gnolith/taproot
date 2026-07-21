import {
  DuplicateStatementIdError,
  EntityTooLargeError,
  InvalidDatatypeError,
  InvalidEntityError,
  InvalidStatementError,
} from './errors.js';
import {
  ENTITY_DATATYPES,
  type AliasMap,
  type DataValueValue,
  type EntityDatatype,
  type EntityId,
  type EntityIdValue,
  type GlobeCoordinateValue,
  type LanguageMap,
  type PropertyId,
  type MonolingualTextValue,
  type QuantityValue,
  type Reference,
  type Snak,
  type Statement,
  type TimeValue,
  type WikibaseEntity,
} from './types.js';

export const MAX_ENTITY_BYTES = 1_800_000;
const idPattern = /^(?:Q|P)[1-9][0-9]*$/u;
const propertyPattern = /^P[1-9][0-9]*$/u;
const languagePattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const ranks = new Set(['preferred', 'normal', 'deprecated']);
const snakTypes = new Set(['value', 'somevalue', 'novalue']);
const datatypes = new Set<string>(ENTITY_DATATYPES);

export function parseEntityJson(json: string): WikibaseEntity {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new InvalidEntityError('Entity JSON is not valid JSON', {
      cause,
    });
  }
  validateEntity(value);
  return canonicalizeEntity(value);
}

export function validateEntity(
  value: unknown,
): asserts value is WikibaseEntity {
  if (!isRecord(value)) {
    throw new InvalidEntityError('Entity must be an object');
  }
  const { id, type } = value;
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new InvalidEntityError('Entity id must be a positive Q or P id');
  }
  if (type !== 'item' && type !== 'property') {
    throw new InvalidEntityError('Entity type must be item or property');
  }
  if ((type === 'item') !== id.startsWith('Q')) {
    throw new InvalidEntityError('Entity id prefix does not match its type');
  }
  if (type === 'property') {
    assertDatatype(value.datatype);
  } else if (!isRecord(value.sitelinks)) {
    throw new InvalidEntityError('Items require a sitelinks object');
  }
  validateLanguageMap(value.labels, 'labels');
  validateLanguageMap(value.descriptions, 'descriptions');
  validateAliases(value.aliases);
  if (!Number.isSafeInteger(value.lastrevid) || Number(value.lastrevid) < 0) {
    throw new InvalidEntityError(
      'lastrevid must be a non-negative safe integer',
    );
  }
  if (typeof value.modified !== 'string' || !isTimestamp(value.modified)) {
    throw new InvalidEntityError('modified must be an ISO 8601 timestamp');
  }
  if (!isRecord(value.claims)) {
    throw new InvalidEntityError('claims must be an object');
  }

  const statementIds = new Set<string>();
  for (const [property, statements] of Object.entries(value.claims)) {
    if (!propertyPattern.test(property) || !Array.isArray(statements)) {
      throw new InvalidStatementError(`Invalid claim group ${property}`);
    }
    for (const statement of statements) {
      validateStatement(statement, property as PropertyId, id as EntityId);
      if (statementIds.has(statement.id)) {
        throw new DuplicateStatementIdError(
          `Duplicate statement id ${statement.id}`,
        );
      }
      statementIds.add(statement.id);
    }
  }
  if (type === 'item') {
    validateSitelinks(value.sitelinks);
  }
}

export function exportEntityJson(
  entity: WikibaseEntity,
  maxBytes = MAX_ENTITY_BYTES,
): string {
  validateEntity(entity);
  const json = JSON.stringify(canonicalizeEntity(entity));
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > maxBytes) {
    throw new EntityTooLargeError(
      `Canonical entity JSON is ${bytes} bytes; maximum is ${maxBytes}`,
    );
  }
  return json;
}

export function canonicalizeEntity(entity: WikibaseEntity): WikibaseEntity {
  const base = {
    id: entity.id,
    type: entity.type,
    ...(entity.type === 'property' ? { datatype: entity.datatype } : {}),
    labels: sortLanguageMap(entity.labels),
    descriptions: sortLanguageMap(entity.descriptions),
    aliases: sortAliases(entity.aliases),
    claims: sortRecord(entity.claims, (statements) =>
      statements.map(canonicalizeStatement),
    ),
    ...(entity.type === 'item'
      ? {
          sitelinks: sortRecord(entity.sitelinks, (sitelink) => ({
            site: sitelink.site,
            title: sitelink.title,
            badges: [...sitelink.badges],
            ...(sitelink.url === undefined ? {} : { url: sitelink.url }),
          })),
        }
      : {}),
    lastrevid: entity.lastrevid,
    modified: entity.modified,
  };
  return structuredClone(base) as WikibaseEntity;
}

function canonicalizeStatement(statement: Statement): Statement {
  return {
    id: statement.id,
    type: 'statement',
    text: statement.text,
    rank: statement.rank,
    mainsnak: canonicalizeSnak(statement.mainsnak),
    qualifiers: sortRecord(statement.qualifiers, (snaks) =>
      snaks.map(canonicalizeSnak),
    ),
    'qualifiers-order': [...statement['qualifiers-order']],
    references: statement.references.map((reference) => ({
      hash: reference.hash,
      snaks: sortRecord(reference.snaks, (snaks) =>
        snaks.map(canonicalizeSnak),
      ),
      'snaks-order': [...reference['snaks-order']],
    })),
  };
}

function canonicalizeSnak(snak: Snak): Snak {
  return {
    snaktype: snak.snaktype,
    property: snak.property,
    ...(snak.hash === undefined ? {} : { hash: snak.hash }),
    ...(snak.datavalue === undefined
      ? {}
      : {
          datavalue: {
            value: canonicalizeDataValue(snak.datatype, snak.datavalue.value),
            type: snak.datavalue.type,
          },
        }),
    datatype: snak.datatype,
  };
}

function canonicalizeDataValue(
  datatype: EntityDatatype,
  value: DataValueValue,
): DataValueValue {
  if (typeof value === 'string') return value;
  switch (datatype) {
    case 'wikibase-item':
    case 'wikibase-property':
    case 'wikibase-lexeme':
    case 'wikibase-form':
    case 'wikibase-sense':
    case 'entity-schema': {
      const entityValue = value as EntityIdValue;
      return {
        'entity-type': entityValue['entity-type'],
        ...(entityValue['numeric-id'] === undefined
          ? {}
          : { 'numeric-id': entityValue['numeric-id'] }),
        id: entityValue.id,
      };
    }
    case 'monolingualtext': {
      const text = value as MonolingualTextValue;
      return { text: text.text, language: text.language };
    }
    case 'time': {
      const time = value as TimeValue;
      return {
        time: time.time,
        timezone: time.timezone,
        before: time.before,
        after: time.after,
        precision: time.precision,
        calendarmodel: time.calendarmodel,
      };
    }
    case 'quantity': {
      const quantity = value as QuantityValue;
      return {
        amount: quantity.amount,
        unit: quantity.unit,
        ...(quantity.lowerBound === undefined
          ? {}
          : { lowerBound: quantity.lowerBound }),
        ...(quantity.upperBound === undefined
          ? {}
          : { upperBound: quantity.upperBound }),
      };
    }
    case 'globe-coordinate': {
      const coordinate = value as GlobeCoordinateValue;
      return {
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        altitude: coordinate.altitude,
        precision: coordinate.precision,
        globe: coordinate.globe,
      };
    }
    default:
      return structuredClone(value);
  }
}

function validateStatement(
  value: unknown,
  claimProperty: PropertyId,
  entityId: EntityId,
): asserts value is Statement {
  if (!isRecord(value) || value.type !== 'statement') {
    throw new InvalidStatementError('Statement must have type=statement');
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new InvalidStatementError('Statement id is required');
  }
  assertAuthoredStatementText(value.text, String(value.id));
  if (!value.id.startsWith(`${entityId}$`)) {
    throw new InvalidStatementError(
      `Statement ${value.id} is not owned by ${entityId}`,
    );
  }
  if (typeof value.rank !== 'string' || !ranks.has(value.rank)) {
    throw new InvalidStatementError(`Invalid rank on ${value.id}`);
  }
  validateSnak(value.mainsnak);
  if (value.mainsnak.property !== claimProperty) {
    throw new InvalidStatementError(
      `Statement ${value.id} is grouped under the wrong property`,
    );
  }
  validateSnakGroup(
    value.qualifiers,
    value['qualifiers-order'],
    `qualifiers on ${value.id}`,
  );
  if (!Array.isArray(value.references)) {
    throw new InvalidStatementError(
      `references on ${value.id} must be an array`,
    );
  }
  const hashes = new Set<string>();
  for (const reference of value.references) {
    validateReference(reference);
    if (hashes.has(reference.hash)) {
      throw new InvalidStatementError(
        `Duplicate reference hash ${reference.hash}`,
      );
    }
    hashes.add(reference.hash);
  }
}

function validateReference(value: unknown): asserts value is Reference {
  if (
    !isRecord(value) ||
    typeof value.hash !== 'string' ||
    value.hash.length === 0
  ) {
    throw new InvalidStatementError('Reference hash is required');
  }
  validateSnakGroup(
    value.snaks,
    value['snaks-order'],
    `reference ${value.hash}`,
  );
}

function validateSnakGroup(
  value: unknown,
  order: unknown,
  context: string,
): void {
  if (!isRecord(value) || !Array.isArray(order)) {
    throw new InvalidStatementError(`${context} requires snaks and an order`);
  }
  const keys = Object.keys(value);
  if (
    order.some(
      (key) => typeof key !== 'string' || !propertyPattern.test(key),
    ) ||
    new Set(order).size !== order.length ||
    order.length !== keys.length ||
    keys.some((key) => !order.includes(key))
  ) {
    throw new InvalidStatementError(
      `${context} order does not match its snaks`,
    );
  }
  for (const [property, snaks] of Object.entries(value)) {
    if (!propertyPattern.test(property) || !Array.isArray(snaks)) {
      throw new InvalidStatementError(
        `Invalid snak group ${property} in ${context}`,
      );
    }
    for (const snak of snaks) {
      validateSnak(snak);
      if (snak.property !== property) {
        throw new InvalidStatementError(
          `Snak is grouped under the wrong property`,
        );
      }
    }
  }
}

export function validateSnak(value: unknown): asserts value is Snak {
  if (
    !isRecord(value) ||
    typeof value.property !== 'string' ||
    !propertyPattern.test(value.property)
  ) {
    throw new InvalidStatementError('Snak property must be a P id');
  }
  if (typeof value.snaktype !== 'string' || !snakTypes.has(value.snaktype)) {
    throw new InvalidStatementError('Invalid snak type');
  }
  assertDatatype(value.datatype);
  if (value.hash !== undefined && typeof value.hash !== 'string') {
    throw new InvalidStatementError('Snak hash must be a string');
  }
  if (value.snaktype === 'value') {
    if (
      !isRecord(value.datavalue) ||
      typeof value.datavalue.type !== 'string'
    ) {
      throw new InvalidStatementError('Value snaks require a datavalue');
    }
    const expectedType = dataValueType(value.datatype);
    if (value.datavalue.type !== expectedType) {
      throw new InvalidDatatypeError(
        `${value.datatype} datavalues require type=${expectedType}`,
      );
    }
    validateDataValue(value.datatype, value.datavalue.value);
  } else if (value.datavalue !== undefined) {
    throw new InvalidStatementError(
      'Special-value snaks cannot have a datavalue',
    );
  }
}

function dataValueType(datatype: EntityDatatype): string {
  if (
    [
      'wikibase-item',
      'wikibase-property',
      'wikibase-lexeme',
      'wikibase-form',
      'wikibase-sense',
      'entity-schema',
    ].includes(datatype)
  ) {
    return 'wikibase-entityid';
  }
  if (
    datatype === 'string' ||
    datatype === 'external-id' ||
    datatype === 'url' ||
    datatype === 'commonsMedia' ||
    datatype === 'math' ||
    datatype === 'musical-notation' ||
    datatype === 'geo-shape' ||
    datatype === 'tabular-data'
  ) {
    return 'string';
  }
  return datatype;
}

function validateDataValue(datatype: EntityDatatype, value: unknown): void {
  if (
    [
      'string',
      'external-id',
      'url',
      'commonsMedia',
      'math',
      'musical-notation',
      'geo-shape',
      'tabular-data',
    ].includes(datatype)
  ) {
    if (
      typeof value !== 'string' ||
      (datatype === 'url' && !isAbsoluteUrl(value))
    )
      invalidDataValue(datatype);
    return;
  }
  if (!isRecord(value)) invalidDataValue(datatype);
  switch (datatype) {
    case 'wikibase-item':
    case 'wikibase-property':
    case 'wikibase-lexeme':
    case 'wikibase-form':
    case 'wikibase-sense':
    case 'entity-schema': {
      const shape = {
        'wikibase-item': { pattern: /^Q[1-9]\d*$/u, type: 'item' },
        'wikibase-property': { pattern: /^P[1-9]\d*$/u, type: 'property' },
        'wikibase-lexeme': { pattern: /^L[1-9]\d*$/u, type: 'lexeme' },
        'wikibase-form': { pattern: /^L[1-9]\d*-F[1-9]\d*$/u, type: 'form' },
        'wikibase-sense': { pattern: /^L[1-9]\d*-S[1-9]\d*$/u, type: 'sense' },
        'entity-schema': { pattern: /^E[1-9]\d*$/u, type: 'entity-schema' },
      }[datatype];
      if (
        typeof value.id !== 'string' ||
        !shape.pattern.test(value.id) ||
        (value['numeric-id'] !== undefined &&
          (!Number.isSafeInteger(value['numeric-id']) ||
            value['numeric-id'] !==
              Number(value.id.match(/^\D*(\d+)/u)?.[1]))) ||
        value['entity-type'] !== shape.type
      )
        invalidDataValue(datatype);
      break;
    }
    case 'monolingualtext':
      if (
        typeof value.text !== 'string' ||
        typeof value.language !== 'string' ||
        !value.language
      )
        invalidDataValue(datatype);
      break;
    case 'time':
      if (
        typeof value.time !== 'string' ||
        !/^[+-]\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value.time) ||
        !Number.isInteger(value.timezone) ||
        Number(value.timezone) < -840 ||
        Number(value.timezone) > 840 ||
        !Number.isInteger(value.before) ||
        !Number.isInteger(value.after) ||
        !Number.isInteger(value.precision) ||
        Number(value.precision) < 0 ||
        Number(value.precision) > 14 ||
        Number(value.before) < 0 ||
        Number(value.after) < 0 ||
        typeof value.calendarmodel !== 'string' ||
        !isAbsoluteUrl(value.calendarmodel)
      )
        invalidDataValue(datatype);
      break;
    case 'quantity':
      if (
        typeof value.amount !== 'string' ||
        typeof value.unit !== 'string' ||
        (value.unit !== '1' && !isAbsoluteUrl(value.unit)) ||
        !isDecimal(value.amount) ||
        (value.lowerBound !== undefined &&
          (typeof value.lowerBound !== 'string' ||
            !isDecimal(value.lowerBound))) ||
        (value.upperBound !== undefined &&
          (typeof value.upperBound !== 'string' ||
            !isDecimal(value.upperBound)))
      )
        invalidDataValue(datatype);
      break;
    case 'globe-coordinate':
      if (
        typeof value.latitude !== 'number' ||
        !Number.isFinite(value.latitude) ||
        value.latitude < -90 ||
        value.latitude > 90 ||
        typeof value.longitude !== 'number' ||
        !Number.isFinite(value.longitude) ||
        value.longitude < -180 ||
        value.longitude > 180 ||
        (value.altitude !== null &&
          (typeof value.altitude !== 'number' ||
            !Number.isFinite(value.altitude))) ||
        (value.precision !== null &&
          (typeof value.precision !== 'number' ||
            !Number.isFinite(value.precision) ||
            value.precision < 0)) ||
        typeof value.globe !== 'string' ||
        !isAbsoluteUrl(value.globe)
      )
        invalidDataValue(datatype);
      break;
  }
}

function invalidDataValue(datatype: EntityDatatype): never {
  throw new InvalidDatatypeError(`Invalid ${datatype} datavalue`);
}

function assertDatatype(value: unknown): asserts value is EntityDatatype {
  if (typeof value !== 'string' || !datatypes.has(value)) {
    throw new InvalidDatatypeError(`Unsupported datatype ${String(value)}`);
  }
}

function validateLanguageMap(
  value: unknown,
  context: string,
): asserts value is LanguageMap {
  if (!isRecord(value))
    throw new InvalidEntityError(`${context} must be an object`);
  for (const [language, term] of Object.entries(value)) {
    if (
      !languagePattern.test(language) ||
      !isRecord(term) ||
      term.language !== language ||
      typeof term.value !== 'string'
    )
      throw new InvalidEntityError(`Invalid ${context} entry for ${language}`);
  }
}

function validateAliases(value: unknown): asserts value is AliasMap {
  if (!isRecord(value))
    throw new InvalidEntityError('aliases must be an object');
  for (const [language, aliases] of Object.entries(value)) {
    if (!languagePattern.test(language) || !Array.isArray(aliases)) {
      throw new InvalidEntityError(`Invalid aliases for ${language}`);
    }
    for (const alias of aliases) {
      if (
        !isRecord(alias) ||
        alias.language !== language ||
        typeof alias.value !== 'string'
      ) {
        throw new InvalidEntityError(`Invalid alias for ${language}`);
      }
    }
  }
}

function validateSitelinks(value: unknown): void {
  if (!isRecord(value))
    throw new InvalidEntityError('sitelinks must be an object');
  for (const [site, sitelink] of Object.entries(value)) {
    if (
      !isRecord(sitelink) ||
      sitelink.site !== site ||
      typeof sitelink.title !== 'string' ||
      !Array.isArray(sitelink.badges) ||
      sitelink.badges.some(
        (badge) => typeof badge !== 'string' || !/^Q[1-9]\d*$/u.test(badge),
      ) ||
      (sitelink.url !== undefined &&
        (typeof sitelink.url !== 'string' || !isAbsoluteUrl(sitelink.url)))
    )
      throw new InvalidEntityError(`Invalid sitelink ${site}`);
  }
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isDecimal(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value);
}

function sortLanguageMap(value: LanguageMap): LanguageMap {
  return sortRecord(value, (term) => ({ ...term }));
}

function sortAliases(value: AliasMap): AliasMap {
  return sortRecord(value, (aliases) => aliases.map((alias) => ({ ...alias })));
}

function sortRecord<T, U>(
  value: Record<string, T>,
  map: (item: T) => U,
): Record<string, U> {
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, map(value[key] as T)]),
  );
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function entityNumericId(id: EntityId): number {
  return Number(id.slice(1));
}

export function cloneEntity(entity: WikibaseEntity): WikibaseEntity {
  return structuredClone(entity);
}

export function cloneDataValue(value: DataValueValue): DataValueValue {
  return structuredClone(value);
}

export function createStatement(
  entityId: EntityId,
  mainsnak: Snak,
  text: string,
  options: { id?: string; rank?: Statement['rank'] } = {},
): Statement {
  validateSnak(mainsnak);
  assertAuthoredStatementText(text);
  return {
    id: options.id ?? `${entityId}$${crypto.randomUUID()}`,
    type: 'statement',
    text,
    rank: options.rank ?? 'normal',
    mainsnak: structuredClone(mainsnak),
    qualifiers: {},
    'qualifiers-order': [],
    references: [],
  };
}

export function assertAuthoredStatementText(
  text: unknown,
  statementId?: string,
): asserts text is string {
  if (typeof text !== 'string' || text.trim().length === 0)
    throw new InvalidStatementError(
      `Statement${statementId ? ` ${statementId}` : ''} text must be explicitly authored and non-empty`,
    );
}

export function createReference(
  snaks: Record<PropertyId, Snak[]>,
  hash = crypto.randomUUID().replace(/-/gu, ''),
): Reference {
  const order = Object.keys(snaks).sort() as PropertyId[];
  const reference = {
    hash,
    snaks: structuredClone(snaks),
    'snaks-order': order,
  };
  validateReference(reference);
  return reference;
}
