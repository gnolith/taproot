export class TaprootError extends Error {
  readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.name
      .replace(/Error$/u, '')
      .replace(/([a-z])([A-Z])/gu, '$1_$2')
      .toUpperCase();
  }
}

export class EntityNotFoundError extends TaprootError {}
export class EntityAlreadyExistsError extends TaprootError {}
export class RevisionConflictError extends TaprootError {}
export class InvalidEntityError extends TaprootError {}
export class InvalidStatementError extends InvalidEntityError {}
export class InvalidDatatypeError extends InvalidEntityError {}
export class PropertyNotFoundError extends TaprootError {}
export class PropertyDatatypeMismatchError extends InvalidEntityError {}
export class DuplicateStatementIdError extends InvalidStatementError {}
export class EntityTooLargeError extends InvalidEntityError {}
export class QuadPatchTooLargeError extends TaprootError {}
export class SchemaMismatchError extends TaprootError {}
export class InvalidCursorError extends TaprootError {}
export class IntegrityError extends TaprootError {}
export class BulkLimitError extends TaprootError {}
export class InvalidBaseIriError extends TaprootError {}
export class BaseIriMismatchError extends TaprootError {}
export class TaprootMigrationStateError extends SchemaMismatchError {}
export class InvalidAuthorizationError extends TaprootError {}
export class AuthorizationDeniedError extends TaprootError {}
