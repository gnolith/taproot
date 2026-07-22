import {
  createItem,
  type D1DatabaseLike,
  type TaprootWriteOptions,
} from '../src/index.js';
// @ts-expect-error Raw canonical repositories are not package exports.
import { TaprootRepository } from '../src/index.js';

declare const db: D1DatabaseLike;

const forbiddenOptions: TaprootWriteOptions = {
  baseIri: 'https://types.example',
  // @ts-expect-error Public writes cannot install canonical-state observers.
  validators: [],
};
void createItem(db, forbiddenOptions, { id: 'Q1' });
void TaprootRepository;
