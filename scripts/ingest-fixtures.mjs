import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Kullanım: node scripts/ingest-fixtures.mjs <fixtures.json>");
  process.exit(1);
}

const root = process.cwd();
const dbPath = process.env.KUPON_DB_PATH || path.join(root, "data", "kupon.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(root, "lib", "schema.sql"), "utf8"));
for (const [column, type] of [
  ["home_attacks", "INTEGER"], ["away_attacks", "INTEGER"],
  ["home_pass_accuracy", "REAL"], ["away_pass_accuracy", "REAL"],
  ["home_passes_completed", "INTEGER"], ["away_passes_completed", "INTEGER"],
  ["home_passes_attempted", "INTEGER"], ["away_passes_attempted", "INTEGER"],
  ["home_balls_recovered", "INTEGER"], ["away_balls_recovered", "INTEGER"],
  ["home_saves", "INTEGER"], ["away_saves", "INTEGER"],
  ["home_big_chances", "INTEGER"], ["away_big_chances", "INTEGER"],
  ["home_xg", "REAL"], ["away_xg", "REAL"],
]) {
  if (!db.prepare("PRAGMA table_info(match_stats)").all().some((item) => item.name === column)) {
    db.exec(`ALTER TABLE match_stats ADD COLUMN ${column} ${type}`);
  }
}

const payload = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
const fixtures = Array.isArray(payload) ? payload : payload.fixtures;
if (!Array.isArray(fixtures)) throw new Error("JSON içinde fixtures dizisi bulunamadı.");

const allowedCompetitions = new Set(["CL", "EL", "ECL", "PL", "TSL", "LL"]);
const allowedStatuses = new Set(["SCHEDULED", "TIMED", "FINISHED", "POSTPONED", "CANCELLED", "TBC"]);
const upsertTeam = db.prepare("INSERT INTO teams(name, country) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET country = COALESCE(excluded.country, teams.country)");
const teamId = db.prepare("SELECT id FROM teams WHERE name = ?");
const findFixture = db.prepare("SELECT id FROM fixtures WHERE external_id = ?");
const insertFixture = db.prepare(`
  INSERT INTO fixtures(external_id, competition_code, kickoff_utc, home_team_id, away_team_id, status, home_goals, away_goals, stage, source_name, source_url, source_checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateFixture = db.prepare(`
  UPDATE fixtures SET competition_code = ?, kickoff_utc = ?, home_team_id = ?, away_team_id = ?, status = ?,
    home_goals = ?, away_goals = ?, stage = ?, source_name = ?, source_url = ?, source_checked_at = ?, updated_at = CURRENT_TIMESTAMP
  WHERE external_id = ? AND NOT EXISTS (
    SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id = fixtures.id
  )
`);
const insertPlayer = db.prepare(`
  INSERT INTO player_availability(fixture_id, team_id, player_name, availability, reason, attack_impact, defense_impact, source_url, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fixture_id, team_id, player_name) DO UPDATE SET
    availability = excluded.availability, reason = excluded.reason, attack_impact = excluded.attack_impact,
    defense_impact = excluded.defense_impact, source_url = excluded.source_url, checked_at = excluded.checked_at
`);
const upsertStats = db.prepare(`
  INSERT INTO match_stats(
    fixture_id, home_shots, away_shots, home_shots_on_target, away_shots_on_target,
    home_corners, away_corners, home_possession, away_possession, home_fouls, away_fouls,
    home_yellow_cards, away_yellow_cards, home_red_cards, away_red_cards,
    home_attacks, away_attacks, home_pass_accuracy, away_pass_accuracy,
    home_passes_completed, away_passes_completed, home_passes_attempted, away_passes_attempted,
    home_balls_recovered, away_balls_recovered, home_saves, away_saves,
    home_big_chances, away_big_chances, home_xg, away_xg, source_url, checked_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fixture_id) DO UPDATE SET
    home_shots=excluded.home_shots, away_shots=excluded.away_shots,
    home_shots_on_target=excluded.home_shots_on_target, away_shots_on_target=excluded.away_shots_on_target,
    home_corners=excluded.home_corners, away_corners=excluded.away_corners,
    home_possession=excluded.home_possession, away_possession=excluded.away_possession,
    home_fouls=excluded.home_fouls, away_fouls=excluded.away_fouls,
    home_yellow_cards=excluded.home_yellow_cards, away_yellow_cards=excluded.away_yellow_cards,
    home_red_cards=excluded.home_red_cards, away_red_cards=excluded.away_red_cards,
    home_attacks=excluded.home_attacks, away_attacks=excluded.away_attacks,
    home_pass_accuracy=excluded.home_pass_accuracy, away_pass_accuracy=excluded.away_pass_accuracy,
    home_passes_completed=excluded.home_passes_completed, away_passes_completed=excluded.away_passes_completed,
    home_passes_attempted=excluded.home_passes_attempted, away_passes_attempted=excluded.away_passes_attempted,
    home_balls_recovered=excluded.home_balls_recovered, away_balls_recovered=excluded.away_balls_recovered,
    home_saves=excluded.home_saves, away_saves=excluded.away_saves,
    home_big_chances=excluded.home_big_chances, away_big_chances=excluded.away_big_chances,
    home_xg=excluded.home_xg, away_xg=excluded.away_xg,
    source_url=excluded.source_url, checked_at=excluded.checked_at
`);
const deleteGoalEvents = db.prepare("DELETE FROM goal_events WHERE fixture_id = ?");
const upsertGoalEventSet = db.prepare(`
  INSERT INTO goal_event_sets(fixture_id, event_count, is_complete, source_name, source_url, checked_at)
  VALUES (?, ?, 1, ?, ?, ?)
  ON CONFLICT(fixture_id) DO UPDATE SET
    event_count=excluded.event_count, is_complete=1, source_name=excluded.source_name,
    source_url=excluded.source_url, checked_at=excluded.checked_at
`);
const insertGoalEvent = db.prepare(`
  INSERT INTO goal_events(
    fixture_id, source_event_id, scoring_team_id, minute, added_time, period,
    player_name, event_type, is_own_goal, is_penalty, source_url, checked_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GOAL', ?, ?, ?, ?)
`);

let added = 0;
let updated = 0;
const startedAt = new Date().toISOString();
db.exec("BEGIN IMMEDIATE");
try {
  for (const item of fixtures) {
    const competitionCode = String(item.competition_code || "").toUpperCase();
    if (!allowedCompetitions.has(competitionCode)) throw new Error(`Desteklenmeyen lig: ${competitionCode}`);
    const kickoff = new Date(item.kickoff_utc);
    if (Number.isNaN(kickoff.getTime())) throw new Error(`Geçersiz tarih: ${item.kickoff_utc}`);
    const homeName = String(item.home_team || "").trim();
    const awayName = String(item.away_team || "").trim();
    if (!homeName || !awayName || homeName === awayName) throw new Error("Ev/deplasman takımları geçersiz.");
    const status = String(item.status || "TIMED").toUpperCase();
    if (!allowedStatuses.has(status)) throw new Error(`Geçersiz durum: ${status}`);
    const sourceUrl = String(item.source_url || "").trim();
    if (!/^https:\/\//i.test(sourceUrl)) throw new Error("Her maç için HTTPS kaynak bağlantısı zorunludur.");
    const checkedAt = new Date(item.source_checked_at || Date.now()).toISOString();
    const stableKey = item.external_id || `${competitionCode}|${item.season || kickoff.getUTCFullYear()}|${item.stage || ""}|${homeName}|${awayName}`;
    const externalId = crypto.createHash("sha256").update(stableKey).digest("hex").slice(0, 32);

    upsertTeam.run(homeName, item.home_country || null);
    upsertTeam.run(awayName, item.away_country || null);
    const homeId = Number(teamId.get(homeName).id);
    const awayId = Number(teamId.get(awayName).id);
    const existing = findFixture.get(externalId);
    const values = [
      competitionCode,
      kickoff.toISOString(),
      homeId,
      awayId,
      status,
      Number.isInteger(item.home_goals) ? item.home_goals : null,
      Number.isInteger(item.away_goals) ? item.away_goals : null,
      item.stage || null,
      String(item.source_name || "Resmî kaynak"),
      sourceUrl,
      checkedAt,
    ];
    let fixtureId;
    if (existing) {
      updateFixture.run(...values, externalId);
      fixtureId = Number(existing.id);
      updated += 1;
    } else {
      const result = insertFixture.run(externalId, ...values);
      fixtureId = Number(result.lastInsertRowid);
      added += 1;
    }

    if (item.stats) {
      const value = (key) => Number.isFinite(Number(item.stats[key])) ? Number(item.stats[key]) : null;
      upsertStats.run(
        fixtureId,
        value("home_shots"), value("away_shots"), value("home_shots_on_target"), value("away_shots_on_target"),
        value("home_corners"), value("away_corners"), value("home_possession"), value("away_possession"),
        value("home_fouls"), value("away_fouls"), value("home_yellow_cards"), value("away_yellow_cards"),
        value("home_red_cards"), value("away_red_cards"),
        value("home_attacks"), value("away_attacks"), value("home_pass_accuracy"), value("away_pass_accuracy"),
        value("home_passes_completed"), value("away_passes_completed"),
        value("home_passes_attempted"), value("away_passes_attempted"),
        value("home_balls_recovered"), value("away_balls_recovered"),
        value("home_saves"), value("away_saves"), value("home_big_chances"), value("away_big_chances"),
        value("home_xg"), value("away_xg"), String(item.stats.source_url || sourceUrl),
        new Date(item.stats.checked_at || checkedAt).toISOString(),
      );
    }

    if (Array.isArray(item.goal_events) && Number.isInteger(item.home_goals) && Number.isInteger(item.away_goals)) {
      const goals = item.goal_events.map((event, index) => {
        const side = String(event.team || "").toLowerCase();
        const minute = Number(event.minute);
        const addedTime = Number(event.added_time || 0);
        if (!["home", "away"].includes(side) || !Number.isInteger(minute) || minute < 1 || minute > 130
          || !Number.isInteger(addedTime) || addedTime < 0 || addedTime > 30) {
          throw new Error(`${homeName} - ${awayName} maçında geçersiz gol olayı.`);
        }
        return {
          sourceEventId: String(event.source_event_id || `${side}-${minute}-${addedTime}-${index + 1}`),
          teamId: side === "home" ? homeId : awayId,
          side,
          minute,
          addedTime,
          period: event.period ? String(event.period) : null,
          playerName: event.player_name ? String(event.player_name) : null,
          ownGoal: event.is_own_goal ? 1 : 0,
          penalty: event.is_penalty ? 1 : 0,
          sourceUrl: String(event.source_url || item.goal_events_source_url || sourceUrl),
          checkedAt: new Date(event.checked_at || item.goal_events_checked_at || checkedAt).toISOString(),
        };
      });
      const homeGoalCount = goals.filter((goal) => goal.side === "home").length;
      const awayGoalCount = goals.filter((goal) => goal.side === "away").length;
      if (homeGoalCount !== item.home_goals || awayGoalCount !== item.away_goals) {
        throw new Error(`${homeName} - ${awayName} gol olayları skorla eşleşmiyor; eksik veri kaydedilmedi.`);
      }
      deleteGoalEvents.run(fixtureId);
      for (const goal of goals) {
        insertGoalEvent.run(
          fixtureId, goal.sourceEventId, goal.teamId, goal.minute, goal.addedTime, goal.period,
          goal.playerName, goal.ownGoal, goal.penalty, goal.sourceUrl, goal.checkedAt,
        );
      }
      upsertGoalEventSet.run(
        fixtureId, goals.length, String(item.goal_events_source_name || item.source_name || "Resmî kaynak"),
        String(item.goal_events_source_url || sourceUrl),
        new Date(item.goal_events_checked_at || checkedAt).toISOString(),
      );
    }

    for (const player of item.player_availability || []) {
      const playerTeam = player.team === "home" ? homeId : player.team === "away" ? awayId : null;
      if (!playerTeam || !player.name || !player.source_url) continue;
      insertPlayer.run(
        fixtureId,
        playerTeam,
        String(player.name).trim(),
        String(player.availability || "DOUBT").toUpperCase(),
        player.reason || null,
        Math.max(0, Math.min(0.15, Number(player.attack_impact || 0))),
        Math.max(0, Math.min(0.15, Number(player.defense_impact || 0))),
        String(player.source_url),
        new Date(player.checked_at || checkedAt).toISOString(),
      );
    }
  }
  const finishedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_runs(started_at, finished_at, status, fixtures_added, fixtures_updated, sources_checked, notes)
    VALUES (?, ?, 'SUCCESS', ?, ?, ?, ?)
  `).run(startedAt, finishedAt, added, updated, new Set(fixtures.map((item) => item.source_url)).size, `Dosya: ${path.basename(inputPath)}`);
  db.exec("COMMIT");
  console.log(JSON.stringify({ ok: true, added, updated, total: fixtures.length }, null, 2));
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
