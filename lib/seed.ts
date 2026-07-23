import currentSeed from "@/data/imports/uefa-2026-07-22.generated.json";
import historySeed from "@/data/imports/uefa-2025-26-history.generated.json";
import domesticSeed from "@/data/imports/domestic-2025-26-history.generated.json";
import scheduleSeed from "@/data/imports/official-domestic-2026-27.generated.json";
import type { SqliteDb } from "./db";

let seeding: Promise<void> | null = null;

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function ensureSeedData(db: SqliteDb) {
  if (!seeding) {
    seeding = (async () => {
      const count = await db.get("SELECT COUNT(*) AS total FROM fixtures") as { total?: number } | undefined;
      const historyCount = await db.get("SELECT COUNT(*) AS total FROM fixtures WHERE external_id LIKE 'uefa-history-%'") as { total?: number } | undefined;
      const domesticCount = await db.get("SELECT COUNT(*) AS total FROM fixtures WHERE external_id LIKE 'openfootball-%'") as { total?: number } | undefined;
      const scheduleCount = await db.get("SELECT COUNT(*) AS total FROM fixtures WHERE external_id LIKE 'official-%'") as { total?: number } | undefined;
      const fixtures = [
        ...(Number(count?.total || 0) === 0 ? currentSeed.fixtures : []),
        ...(Number(historyCount?.total || 0) < historySeed.fixtures.length ? historySeed.fixtures : []),
        ...(Number(domesticCount?.total || 0) < domesticSeed.fixtures.length ? domesticSeed.fixtures : []),
        ...(Number(scheduleCount?.total || 0) < scheduleSeed.fixtures.length ? scheduleSeed.fixtures : []),
      ];
      if (!fixtures.length) return;

      await db.batch(domesticSeed.competitions.map((competition) => ({
        sql: "INSERT OR IGNORE INTO competitions(code, name, country) VALUES (?, ?, ?)",
        args: [competition.code, competition.name, competition.country],
      })));
      const teamNames = [...new Set(fixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team]))];
      for (const group of chunks(teamNames, 80)) {
        await db.batch(group.map((name) => ({
          sql: "INSERT OR IGNORE INTO teams(name) VALUES (?)",
          args: [name],
        })));
      }

      const teamRows = await db.all("SELECT id, name FROM teams") as Array<{ id: number; name: string }>;
      const teamIds = new Map(teamRows.map((team) => [team.name, Number(team.id)]));
      for (const group of chunks(fixtures, 60)) {
        await db.batch(group.map((fixture) => ({
          sql: `
            INSERT INTO fixtures(
              external_id, competition_code, kickoff_utc, home_team_id, away_team_id,
              status, home_goals, away_goals, stage, source_name, source_url, source_checked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(external_id) DO UPDATE SET
              kickoff_utc=excluded.kickoff_utc,
              status=CASE
                WHEN EXISTS (SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id=fixtures.id)
                THEN fixtures.status ELSE excluded.status END,
              home_goals=CASE
                WHEN EXISTS (SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id=fixtures.id)
                THEN fixtures.home_goals ELSE excluded.home_goals END,
              away_goals=CASE
                WHEN EXISTS (SELECT 1 FROM manual_fixture_results mr WHERE mr.fixture_id=fixtures.id)
                THEN fixtures.away_goals ELSE excluded.away_goals END,
              stage=excluded.stage,
              source_url=excluded.source_url,
              source_checked_at=excluded.source_checked_at,
              updated_at=CURRENT_TIMESTAMP
          `,
          args: [
            fixture.external_id,
            fixture.competition_code,
            fixture.kickoff_utc,
            teamIds.get(fixture.home_team) ?? 0,
            teamIds.get(fixture.away_team) ?? 0,
            fixture.status,
            fixture.home_goals,
            fixture.away_goals,
            fixture.stage,
            fixture.source_name,
            fixture.source_url,
            fixture.source_checked_at,
          ],
        })));
      }

      const now = new Date().toISOString();
      await db.run(`
        INSERT INTO sync_runs(started_at, finished_at, status, fixtures_added, fixtures_updated, sources_checked, notes)
        VALUES (?, ?, 'SUCCESS', ?, 0, ?, ?)
      `, [now, now, fixtures.length, fixtures.length, "UEFA, ulusal lig geçmişi ve 2026/27 resmi lig fikstürleri"]);
    })().catch((error) => {
      seeding = null;
      throw error;
    });
  }
  await seeding;
}
