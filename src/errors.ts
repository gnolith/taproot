export class TaprootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
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
