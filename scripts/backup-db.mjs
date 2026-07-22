import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const source = path.join(root, "data", "kupon.db");
const backupDir = path.join(root, "data", "backups");

if (!fs.existsSync(source)) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "Veritabanı henüz oluşmadı." }));
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupDir, `kupon-${stamp}.db`);
const escapedTarget = target.replaceAll("'", "''");

const db = new DatabaseSync(source);
try {
  db.exec(`VACUUM INTO '${escapedTarget}'`);
} finally {
  db.close();
}

const backups = fs.readdirSync(backupDir)
  .filter((name) => /^kupon-.*\.db$/.test(name))
  .map((name) => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);

for (const old of backups.slice(12)) {
  fs.rmSync(path.join(backupDir, old.name));
}

console.log(JSON.stringify({ ok: true, backup: target, retained: Math.min(backups.length, 12) }, null, 2));
