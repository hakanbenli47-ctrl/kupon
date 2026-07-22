import seed from "@/data/imports/uefa-2026-07-22.generated.json";
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
      if (Number(count?.total || 0) > 0) return;

      const fixtures = seed.fixtures;
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
              status=excluded.status,
              home_goals=excluded.home_goals,
              away_goals=excluded.away_goals,
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
      `, [now, now, fixtures.length, fixtures.length, "İlk Turso veri yüklemesi"]);
    })().catch((error) => {
      seeding = null;
      throw error;
    });
  }
  await seeding;
}
