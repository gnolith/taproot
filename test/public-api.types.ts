import {
  createItem,
  type D1DatabaseLike,
  type TaprootHostWriteCapability,
  type InstallationAuthorizationGuard,
  type AuthorizationContext,
  type TaprootWriteOptions,
} from '../src/index.js';
// @ts-expect-error Raw canonical repositories are not package exports.
import { TaprootRepository } from '../src/index.js';

declare const db: D1DatabaseLike;
declare const capability: TaprootHostWriteCapability;
declare const guard: InstallationAuthorizationGuard;
declare const context: AuthorizationContext;
const authorization = {
  installationId: 'installation-1',
  workspaceId: null,
  ownerPrincipalId: 'principal-1',
  visibility: { version: 1 as const, clauses: [] },
  statementRestrictions: {},
  expectedAuthorizationRevision: 1,
};

const forbiddenOptions: TaprootWriteOptions = {
  baseIri: 'https://types.example',
  // @ts-expect-error Public writes cannot install canonical-state observers.
  validators: [],
};
const forbiddenFactory: TaprootWriteOptions = {
  baseIri: 'https://types.example',
  // @ts-expect-error Public writes cannot inject RDF factories over canonical state.
  factory: {},
};
const forbiddenSizeProbe: TaprootWriteOptions = {
  baseIri: 'https://types.example',
  // @ts-expect-error Public writes cannot customize canonical size probes.
  maxEntityBytes: 1,
};
void createItem(db, forbiddenOptions, guard, context, {
  id: 'Q1',
  authorization,
});
// @ts-expect-error A bootstrap host token is not a normal-write guard.
void createItem(db, forbiddenOptions, capability, context, {
  id: 'Q1',
  authorization,
});
// @ts-expect-error Normal writes cannot omit explicit canonical policy.
void createItem(db, forbiddenOptions, guard, context, { id: 'Q1' });
void forbiddenFactory;
void forbiddenSizeProbe;
void TaprootRepository;
