/**
 * What smaltts stores as its objects' source text, with no engine import: the language's name, and a view's source.
 */
import type { RelNode } from './rel.js';

/** The language name sources record. */
export const LANGUAGE = 'smaltts';

/** A view's source: its relation, as JSON. */
export interface ViewSource {
  readonly kind: 'view';
  readonly rel: RelNode;
}
