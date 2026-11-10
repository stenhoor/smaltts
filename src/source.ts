/**
 * What smaltts stores as its objects' source text, with no engine import: the language's name, and a view's source.
 */
import type { RelNode } from './rel.js';

/** The language name sources record. */
export const LANGUAGE = 'smaltts';

/**
 * A view's source: its relation, as JSON. An interface view (DESIGN.md section 8.1) also has `columns`, its declared
 * column names in order; its relation then ends in a selection of exactly those columns, so a column added underneath
 * or renamed doesn't change its output. A view without `columns` reflects the tables it reads.
 */
export interface ViewSource {
  readonly kind: 'view';
  readonly rel: RelNode;
  readonly columns?: readonly string[];
}
