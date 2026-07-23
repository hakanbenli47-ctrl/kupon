import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const source = process.argv[2];
const competitionCode = String(process.argv[3] || "").toUpperCase();
if (!source || !["PL", "TSL", "LL"].includes(competitionCode)) {
  console.error("Kullanım: node scripts/import-football-data.mjs <csv-url-veya-dosya> <PL|TSL|LL>");
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header.trim(), values[index]?.trim() || ""])));
}

function parseDate(value) {
  const [day, month, yearRaw] = value.split("/").map(Number);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

const text = /^https:\/\//i.test(source)
  ? await fetch(source).then((response) => { if (!response.ok) throw new Error(`CSV alınamadı: ${response.status}`); return response.text(); })
  : fs.readFileSync(path.resolve(source), "utf8");
const rows = parseCsv(text).filter((row) => row.HomeTeam && row.AwayTeam && row.FTHG !== "" && row.FTAG !== "");

const root = process.cwd();
const dbPath = process.env.KUPON_DB_PATH || path.join(root, "data", "kupon.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(root, "lib", "schema.sql"), "utf8"));
const teamUpsert = db.prepare("INSERT OR IGNORE INTO teams(name) VALUES (?)");
const teamId = db.prepare("SELECT id FROM teams WHERE name = ?");
const insert = db.prepare(`
  INSERT INTO fixtures(external_id, competition_code, kickoff_utc, home_team_id, away_team_id, status, home_goals, away_goals, source_name, source_url, source_checked_at)
  VALUES (?, ?, ?, ?, ?, 'FINISHED', ?, ?, 'football-data.co.uk', ?, ?)
  ON CONFLICT(external_id) DO UPDATE SET
    home_goals = CASE WHEN EXISTS (SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id=fixtures.id) THEN fixtures.home_goals ELSE excluded.home_goals END,
    away_goals = CASE WHEN EXISTS (SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id=fixtures.id) THEN fixtures.away_goals ELSE excluded.away_goals END,
    status = CASE WHEN EXISTS (SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id=fixtures.id) THEN fixtures.status ELSE 'FINISHED' END,
    source_checked_at = excluded.source_checked_at, updated_at = CURRENT_TIMESTAMP
`);
const fixtureIdByKey = db.prepare("SELECT id FROM fixtures WHERE external_id = ?");
const upsertStats = db.prepare(`
  INSERT INTO match_stats(
    fixture_id, home_shots, away_shots, home_shots_on_target, away_shots_on_target,
    home_corners, away_corners, home_fouls, away_fouls, home_yellow_cards, away_yellow_cards,
    home_red_cards, away_red_cards, source_url, checked_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fixture_id) DO UPDATE SET
    home_shots=excluded.home_shots, away_shots=excluded.away_shots,
    home_shots_on_target=excluded.home_shots_on_target, away_shots_on_target=excluded.away_shots_on_target,
    home_corners=excluded.home_corners, away_corners=excluded.away_corners,
    home_fouls=excluded.home_fouls, away_fouls=excluded.away_fouls,
    home_yellow_cards=excluded.home_yellow_cards, away_yellow_cards=excluded.away_yellow_cards,
    home_red_cards=excluded.home_red_cards, away_red_cards=excluded.away_red_cards,
    source_url=excluded.source_url, checked_at=excluded.checked_at
`);
const integerOrNull = (value) => value === "" || value == null ? null : Number(value);
const checkedAt = new Date().toISOString();
db.exec("BEGIN IMMEDIATE");
try {
  for (const row of rows) {
    const kickoff = parseDate(row.Date);
    if (Number.isNaN(kickoff.getTime())) continue;
    teamUpsert.run(row.HomeTeam);
    teamUpsert.run(row.AwayTeam);
    const homeId = Number(teamId.get(row.HomeTeam).id);
    const awayId = Number(teamId.get(row.AwayTeam).id);
    const key = crypto.createHash("sha256").update(`fd|${competitionCode}|${row.Date}|${row.HomeTeam}|${row.AwayTeam}`).digest("hex").slice(0, 32);
    insert.run(key, competitionCode, kickoff.toISOString(), homeId, awayId, Number(row.FTHG), Number(row.FTAG), source, checkedAt);
    const fixtureId = Number(fixtureIdByKey.get(key).id);
    if ([row.HS, row.AS, row.HST, row.AST, row.HC, row.AC].some((value) => value !== "" && value != null)) {
      upsertStats.run(
        fixtureId,
        integerOrNull(row.HS), integerOrNull(row.AS), integerOrNull(row.HST), integerOrNull(row.AST),
        integerOrNull(row.HC), integerOrNull(row.AC), integerOrNull(row.HF), integerOrNull(row.AF),
        integerOrNull(row.HY), integerOrNull(row.AY), integerOrNull(row.HR), integerOrNull(row.AR),
        source, checkedAt,
      );
    }
  }
  db.exec("COMMIT");
  console.log(JSON.stringify({ ok: true, imported: rows.length, competition: competitionCode }, null, 2));
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally { db.close(); }
