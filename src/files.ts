/**
 * Saved change sets (milestone 4; gate A, ADR 0023 decision 19): live diff, and saved change sets as well. CI saves
 * each reviewed change set as a file in the application's repository, and every database replays the files it hasn't
 * applied, in order, so each runs exactly the reviewed steps.
 *
 * A file holds the change set and the schema it leads to. The schema makes each file checkable on its own: before a
 * file runs, the database must have the previous file's schema (or none, before the first), or it has drifted from
 * the history and the replay stops; after the last, any difference from its schema is reported as drift. A checksum
 * of both catches a file edited after it was saved, and the history table records each file's name and checksum, so
 * a file changed after it was applied is refused too.
 *
 * Files are given as their names and text: reading a directory is the caller's (`node:fs` in Node, a bundler's glob,
 * a fetch), so smaltts stays free of any runtime's file API.
 */
import type { Backend } from './backend.js';
import { type ApplyPolicy, type ChangeSet, HISTORY_TABLE, apply, checksum, diff, ensureHistory, jsonSafe } from './changes.js';
import * as P from 'smaltdb/plan';
import type { SchemaSpec } from './spec.js';

/** A saved change set: what `changeSetFile` returns, and what a file's text parses to. */
export interface ChangeSetFile {
  readonly format: 'smaltts.changeset';
  readonly version: 1;
  /** The change set, as reviewed. */
  readonly changes: ChangeSet;
  /** The schema the database has once the change set has run: the next file is checked against it. */
  readonly schema: SchemaSpec;
  /** A checksum of `changes` and `schema`: a file edited after it was saved no longer matches it. */
  readonly checksum: string;
}

/** A file to replay: its name (files run in name order) and its text. */
export interface NamedFile {
  readonly name: string;
  readonly text: string;
}

export interface Migrated {
  /** The files this call applied, in order. */
  readonly applied: readonly string[];
  /** The files the history says were applied before. */
  readonly skipped: readonly string[];
  /** What separates the database from the last file's schema: no steps when the history and the catalog agree. */
  readonly drift: ChangeSet;
}

const fileChecksum = (changes: ChangeSet, schema: SchemaSpec): string => checksum(JSON.stringify({ steps: changes.steps, schema }, jsonSafe));

/** A change set as a file to save, with the schema it leads to (the `desired` it was diffed against). */
export function changeSetFile(changes: ChangeSet, schema: SchemaSpec): ChangeSetFile {
  // Through JSON, so the checksum is of what the file holds.
  const saved = JSON.parse(JSON.stringify({ changes, schema }, jsonSafe)) as { changes: ChangeSet; schema: SchemaSpec };
  return { format: 'smaltts.changeset', version: 1, changes: saved.changes, schema: saved.schema, checksum: fileChecksum(saved.changes, saved.schema) };
}

/** A file's text as a change-set file, refusing one that isn't, or one edited since it was saved. */
export function parseChangeSetFile(text: string, name = 'change set'): ChangeSetFile {
  let f: ChangeSetFile;
  try {
    f = JSON.parse(text) as ChangeSetFile;
  } catch (e) {
    throw new Error(`${name}: not JSON (${(e as Error).message})`);
  }
  if (f?.format !== 'smaltts.changeset' || f.version !== 1 || !f.changes || !f.schema) throw new Error(`${name}: not a smaltts change-set file (version 1)`);
  if (fileChecksum(f.changes, f.schema) !== f.checksum || checksum(JSON.stringify(f.changes.steps, jsonSafe)) !== f.changes.checksum) {
    throw new Error(`${name}: edited after it was saved (its checksum doesn't match): save it again from a new diff`);
  }
  return f;
}

/**
 * Replay the files the database hasn't applied, in name order, each in its own transaction with its history row.
 * Refuses an edited file, a file changed since it was applied, a file older than one applied already, and a database
 * that has drifted from the history (it doesn't have the previous file's schema). `policy` limits what may run; by
 * default, whatever the reviewed files do.
 */
export async function migrateFiles(db: Backend, files: readonly NamedFile[], policy: ApplyPolicy = { allowDataLoss: 'certain' }): Promise<Migrated> {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parsed = sorted.map((f) => ({ name: f.name, file: parseChangeSetFile(f.text, f.name) }));
  const history = await appliedFiles(db);

  const applied: string[] = [];
  const skipped: string[] = [];
  let previous: SchemaSpec = { tables: [] };
  for (const [i, { name, file }] of parsed.entries()) {
    const done = history.get(name);
    if (done !== undefined) {
      if (done !== file.checksum) throw new Error(`${name}: changed since it was applied (checksum ${file.checksum}, applied ${done})`);
      skipped.push(name);
      previous = file.schema;
      continue;
    }
    const later = parsed.slice(i + 1).find((p) => history.has(p.name));
    if (later) throw new Error(`${name}: not applied, but the later ${later.name} is: a file was added out of order`);
    const drift = await diff(db, previous, { prune: true });
    if (drift.steps.length) {
      throw new Error(`${name}: the database has drifted from the history (it doesn't have ${i ? `${parsed[i - 1]!.name}'s` : 'an empty'} schema): ${drift.steps.map((s) => `${s.action} ${s.object}`).join(', ')}`);
    }
    await apply(db, file.changes, { label: name, ...policy }, { name, checksum: file.checksum });
    applied.push(name);
    previous = file.schema;
  }
  return { applied, skipped, drift: await diff(db, previous, { prune: true }) };
}

/** The files the history records as applied: name to checksum. */
async function appliedFiles(db: Backend): Promise<Map<string, string>> {
  const find = async () => (await db.catalog()).tables.find((x) => x.name.toLowerCase() === HISTORY_TABLE);
  if (!(await find())) return new Map();
  await ensureHistory(db);
  const t = (await find())!;
  const cols = ['file', 'file_checksum'].map((c) => t.columns.findIndex((x) => x.name === c));
  const r = await db.run({ kind: 'query', plan: P.scan(HISTORY_TABLE, cols) });
  return new Map(r.rows.filter((row) => row[0] !== null).map((row) => [String(row[0]), String(row[1])]));
}
