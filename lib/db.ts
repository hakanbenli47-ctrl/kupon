import "server-only";

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type InArgs, type InStatement, type Transaction } from "@libsql/client";

type Executor = Pick<Client, "execute" | "batch"> | Pick<Transaction, "execute" | "batch">;

export type DbResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export class SqliteDb {
  constructor(private readonly executor: Executor) {}

  async all(sql: string, args: InArgs = []) {
    const result = await this.executor.execute({ sql, args });
    return result.rows as unknown as Record<string, unknown>[];
  }

  async get(sql: string, args: InArgs = []) {
    const rows = await this.all(sql, args);
    return rows[0];
  }

  async run(sql: string, args: InArgs = []): Promise<DbResult> {
    const result = await this.executor.execute({ sql, args });
    return {
      changes: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid ?? 0,
    };
  }

  async batch(statements: InStatement[]) {
    return this.executor.batch(statements);
  }
}

let client: Client | null = null;
let initialized: Promise<void> | null = null;

function databaseUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const dbFile = process.env.KUPON_DB_PATH || path.join(process.cwd(), "data", "kupon.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  return pathToFileURL(dbFile).href;
}

function getClient() {
  if (client) return client;
  client = createClient({
    url: databaseUrl(),
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });
  return client;
}

async function initializeSchema(activeClient: Client) {
  if (!initialized) {
    initialized = (async () => {
      const schema = fs.readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8")
        .replace(/^PRAGMA\s+journal_mode\s*=.*;\s*$/gim, "")
        .replace(/^PRAGMA\s+foreign_keys\s*=.*;\s*$/gim, "");
      await activeClient.executeMultiple(schema);
    })().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  await initialized;
}

export async function getDb() {
  const activeClient = getClient();
  await initializeSchema(activeClient);
  return new SqliteDb(activeClient);
}

export async function withTransaction<T>(work: (db: SqliteDb) => Promise<T>): Promise<T> {
  const activeClient = getClient();
  await initializeSchema(activeClient);
  const transaction = await activeClient.transaction("write");
  try {
    const value = await work(new SqliteDb(transaction));
    await transaction.commit();
    return value;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}
