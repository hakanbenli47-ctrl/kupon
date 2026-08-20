import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";

const root = process.cwd();
const source = path.join(root, "data", "kupon.db");
const backupDir = path.join(root, "data", "backups");
const remoteUrl = process.env.TURSO_DATABASE_URL;

if (!remoteUrl && !fs.existsSync(source)) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "Veritabanı henüz oluşmadı." }));
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let target;
if (remoteUrl) {
  target = path.join(backupDir, `kupon-turso-${stamp}.json`);
  const client = createClient({
    url: remoteUrl,
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });
  try {
    const schema = await client.execute(`
      SELECT name, type, sql
      FROM sqlite_master
      WHERE type IN ('table','index','trigger','view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name
    `);
    const tables = schema.rows.filter((row) => row.type === "table" && row.name);
    const data = {};
    for (const table of tables) {
      const escapedName = String(table.name).replaceAll('"', '""');
      const rows = await client.execute(`SELECT * FROM "${escapedName}"`);
      data[String(table.name)] = rows.rows;
    }
    fs.writeFileSync(target, JSON.stringify({
      format: "kupon-turso-logical-backup-v1",
      createdAt: new Date().toISOString(),
      schema: schema.rows,
      tables: data,
    }, null, 2), "utf8");
  } finally {
    client.close();
  }
} else {
  target = path.join(backupDir, `kupon-${stamp}.db`);
  const escapedTarget = target.replaceAll("'", "''");
  const db = new DatabaseSync(source);
  try {
    db.exec(`VACUUM INTO '${escapedTarget}'`);
  } finally {
    db.close();
  }
}

const backups = fs.readdirSync(backupDir)
  .filter((name) => /^kupon-(?:turso-.*\.json|.*\.db)$/.test(name))
  .map((name) => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);

for (const old of backups.slice(12)) {
  fs.rmSync(path.join(backupDir, old.name));
}

console.log(JSON.stringify({ ok: true, backup: target, retained: Math.min(backups.length, 12) }, null, 2));
