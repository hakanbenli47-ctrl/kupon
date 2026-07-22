import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const dbPath = process.env.KUPON_DB_PATH || path.join(root, "data", "kupon.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(root, "lib", "schema.sql"), "utf8"));
const summary = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM fixtures) AS fixtures,
    (SELECT COUNT(*) FROM fixtures WHERE status = 'FINISHED') AS finished,
    (SELECT COUNT(*) FROM fixtures WHERE status IN ('SCHEDULED','TIMED','TBC')) AS upcoming,
    (SELECT COUNT(*) FROM predictions WHERE is_active = 1) AS active_predictions
`).get();
console.log(JSON.stringify({ ok: true, database: dbPath, ...summary }, null, 2));
db.close();
console.log("Not: Asıl olasılık analizi paneldeki 'Analizi çalıştır' düğmesinden veya /api/analyze uç noktasından yürütülür.");
