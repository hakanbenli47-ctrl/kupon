import "server-only";

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type Statement = {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
};

export type SqliteDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
};

let singleton: SqliteDb | null = null;

export function databasePath() {
  return process.env.KUPON_DB_PATH || path.join(process.cwd(), "data", "kupon.db");
}

export function getDb(): SqliteDb {
  if (singleton) return singleton;

  const dbFile = databasePath();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile) as unknown as SqliteDb;
  const schema = fs.readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8");
  db.exec(schema);
  singleton = db;
  return db;
}

export function withTransaction<T>(work: (db: SqliteDb) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work(db);
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
