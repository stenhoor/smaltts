/**
 * The conversion table (DESIGN.md 8.3): how a value of one column type becomes a value of another when a rebuild
 * copies it, and whether that is lossless. Decided by the types alone, never by the data a database holds.
 *
 * The engine's `append` copies a column's run-time value as it is: an integer under a temporal type is copied as the
 * integer (a `date`'s day count would become a `datetime`'s µs). So a rebuild converts each column whose type changes
 * with the engine's cast for the pair, and a pair the table does not name has no conversion: the change set reports
 * it as an error instead of copying values that would mean something else.
 *
 * Owned here until the engine publishes its own table (smaltdb proposal E10).
 */
import type { StorageType } from './spec.js';

export interface Conversion {
  /** `none`: exact for every value of the old type. `possible`: some values change or fail (the copy then fails). */
  readonly loss: 'none' | 'possible';
  /** The engine operation that converts; absent: the value is copied as it is. */
  readonly fn?: string;
}

const T = (fn: string, loss: Conversion['loss'] = 'none'): Conversion => ({ fn, loss });
const RAW: Conversion = { loss: 'none' };

/** Conversions by old type, then new type. A pair that is not here has no conversion. */
const TABLE: Partial<Record<StorageType, Partial<Record<StorageType, Conversion>>>> = {
  INTEGER: { NUMERIC: RAW, ANY: RAW, TEXT: T('cast_text'), REAL: T('cast_real', 'possible') },
  REAL: { NUMERIC: RAW, ANY: RAW, TEXT: T('cast_text'), INTEGER: T('cast_integer_strict', 'possible') },
  NUMERIC: { ANY: RAW, TEXT: T('cast_text'), REAL: T('cast_real_strict', 'possible'), INTEGER: T('cast_integer_strict', 'possible') },
  TEXT: {
    ANY: RAW,
    BLOB: T('cast_blob'),
    NUMERIC: T('cast_numeric', 'possible'),
    INTEGER: T('cast_integer_strict', 'possible'),
    REAL: T('cast_real_strict', 'possible'),
    DATE: T('cast_date', 'possible'),
    DATETIME: T('cast_datetime', 'possible'),
    TIME: T('cast_time', 'possible'),
  },
  BLOB: { ANY: RAW },
  BOOLEAN: { INTEGER: RAW, NUMERIC: RAW, REAL: RAW, ANY: RAW, TEXT: T('cast_text') },
  DATE: { DATETIME: T('cast_datetime'), TEXT: T('cast_text'), ANY: T('cast_text') },
  DATETIME: { TEXT: T('cast_text'), ANY: T('cast_text'), DATE: T('cast_date', 'possible') },
  TIME: { TEXT: T('cast_text'), ANY: T('cast_text') },
  DURATION: { TEXT: T('cast_text'), ANY: T('cast_text') },
  ANY: { TEXT: T('cast_text', 'possible'), NUMERIC: RAW },
};

/** How a value of type `from` becomes one of type `to`; undefined when there is no conversion. */
export function conversion(from: StorageType, to: StorageType): Conversion | undefined {
  if (from === to) return RAW;
  return TABLE[from]?.[to];
}
