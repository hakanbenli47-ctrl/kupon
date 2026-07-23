import "server-only";

import { getDb, type SqliteDb } from "./db";
import { ensureSeedData } from "./seed";
import { runAnalysis } from "./analysis";

type SyncFixture = {
  id: number;
  external_id: string;
  competition_code: string;
  kickoff_utc: string;
  status: string;
  home_goals: number | null;
  away_goals: number | null;
  home_team_id: number;
  away_team_id: number;
  home_team: string;
  away_team: string;
  source_url: string;
  has_manual_result: number;
  has_complete_goals: number;
};

type NormalizedGoal = {
  sourceEventId: string;
  scoringTeamId: number;
  minute: number;
  addedTime: number;
  period: string | null;
  playerName: string | null;
  ownGoal: boolean;
  penalty: boolean;
};

type ProviderResult = {
  sourceName: string;
  sourceUrl: string;
  status?: "FINISHED" | "TIMED" | "SCHEDULED" | "POSTPONED" | "CANCELLED";
  homeGoals?: number;
  awayGoals?: number;
  goals?: NormalizedGoal[];
  stats?: Record<string, number | null>;
};

const STAT_COLUMNS = [
  "home_shots", "away_shots", "home_shots_on_target", "away_shots_on_target",
  "home_corners", "away_corners", "home_possession", "away_possession",
  "home_fouls", "away_fouls", "home_yellow_cards", "away_yellow_cards",
  "home_red_cards", "away_red_cards", "home_attacks", "away_attacks",
  "home_pass_accuracy", "away_pass_accuracy", "home_passes_completed", "away_passes_completed",
  "home_passes_attempted", "away_passes_attempted", "home_balls_recovered", "away_balls_recovered",
  "home_saves", "away_saves", "home_big_chances", "away_big_chances", "home_xg", "away_xg",
] as const;

function dateKeyIstanbul(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeName(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\b(fc|cf|fk|sk|afc|club|futbol|football)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function teamsMatch(expected: string, actual: unknown) {
  const left = normalizeName(expected);
  const right = normalizeName(actual);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

async function fetchJson(url: string, timeoutMs = 8_000) {
  const response = await fetch(url, {
    headers: { "User-Agent": "KuponAnaliz/2.1 (+https://kupon-eight.vercel.app)" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function numeric(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value ?? "").replace("%", "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapUefaStats(raw: unknown, homeUefaId: string, awayUefaId: string) {
  if (!Array.isArray(raw)) return undefined;
  const values: Record<string, number | null> = {};
  const aliases: Record<string, string> = {
    totalattempts: "shots",
    attempts: "shots",
    shotstotal: "shots",
    shotstarget: "shots_on_target",
    shotson: "shots_on_target",
    shotsontarget: "shots_on_target",
    corners: "corners",
    possession: "possession",
    foulssuffered: "fouls",
    foulscommitted: "fouls",
    yellowcards: "yellow_cards",
    redcards: "red_cards",
    attacking: "attacks",
    attacks: "attacks",
    passingaccuracy: "pass_accuracy",
    passescompleted: "passes_completed",
    passesattempted: "passes_attempted",
    ballsrecovered: "balls_recovered",
    saves: "saves",
    bigchances: "big_chances",
    expectedgoals: "xg",
    xg: "xg",
  };
  for (const teamBlock of raw as Array<Record<string, unknown>>) {
    const teamId = String(teamBlock.teamId || "");
    const side = teamId === homeUefaId ? "home" : teamId === awayUefaId ? "away" : null;
    if (!side || !Array.isArray(teamBlock.statistics)) continue;
    for (const item of teamBlock.statistics as Array<Record<string, unknown>>) {
      const key = aliases[normalizeName(item.name)];
      const value = numeric(item.value);
      if (key && value !== null) values[`${side}_${key}`] = value;
    }
  }
  return Object.keys(values).length ? values : undefined;
}

async function syncFromUefa(fixture: SyncFixture): Promise<ProviderResult | null> {
  const matchId = fixture.source_url.match(/\/match\/(\d+)/)?.[1]
    || fixture.external_id.match(/uefa-(?:history-)?[A-Z]+-(\d+)/)?.[1];
  if (!matchId) return null;
  const matchUrl = `https://match.uefa.com/v5/matches?matchId=${matchId}`;
  const matchRaw = await fetchJson(matchUrl);
  const match = Array.isArray(matchRaw) ? matchRaw[0] as Record<string, unknown> : null;
  if (!match) return null;
  const homeTeam = match.homeTeam as Record<string, unknown> | undefined;
  const awayTeam = match.awayTeam as Record<string, unknown> | undefined;
  if (!homeTeam || !awayTeam
    || !teamsMatch(fixture.home_team, homeTeam.internationalName)
    || !teamsMatch(fixture.away_team, awayTeam.internationalName)) return null;

  const statusMap: Record<string, ProviderResult["status"]> = {
    FINISHED: "FINISHED",
    UPCOMING: "TIMED",
    LIVE: "TIMED",
    CURRENT: "TIMED",
    ABANDONED: "POSTPONED",
    CANCELED: "CANCELLED",
  };
  const score = (match.score as Record<string, unknown> | undefined)?.regular as Record<string, unknown> | undefined;
  const result: ProviderResult = {
    sourceName: "UEFA Match Centre",
    sourceUrl: fixture.source_url,
    status: statusMap[String(match.status || "")],
  };
  if (numeric(score?.home) !== null && numeric(score?.away) !== null) {
    result.homeGoals = Number(score?.home);
    result.awayGoals = Number(score?.away);
  }
  if (result.status !== "FINISHED" || result.homeGoals === undefined || result.awayGoals === undefined) return result;

  const [eventsRaw, statsRaw] = await Promise.all([
    fetchJson(`https://match.uefa.com/v5/matches/${matchId}/events?filter=LINEUP&order=ASC&limit=100&offset=0`).catch(() => []),
    fetchJson(`https://matchstats.uefa.com/v1/team-statistics/${matchId}`).catch(() => []),
  ]);
  const homeUefaId = String(homeTeam.id);
  const awayUefaId = String(awayTeam.id);
  const events = Array.isArray(eventsRaw) ? eventsRaw as Array<Record<string, unknown>> : [];
  const goals = events.filter((event) => event.type === "GOAL").map((event, index) => {
    const actor = event.primaryActor as Record<string, unknown> | undefined;
    const actorTeam = actor?.team as Record<string, unknown> | undefined;
    let scoringUefaId = String(actorTeam?.id || "");
    const subtype = String(event.subType || event.detail || "").toUpperCase();
    const ownGoal = subtype.includes("OWN");
    if (ownGoal) scoringUefaId = scoringUefaId === homeUefaId ? awayUefaId : homeUefaId;
    const time = event.time as Record<string, unknown> | undefined;
    const scoringTeamId = scoringUefaId === homeUefaId
      ? fixture.home_team_id
      : scoringUefaId === awayUefaId
        ? fixture.away_team_id
        : 0;
    return {
      sourceEventId: String(event.id || `uefa-${matchId}-${index + 1}`),
      scoringTeamId,
      minute: Number(time?.minute || 0),
      addedTime: Number(time?.injuryMinute || 0),
      period: event.phase ? String(event.phase) : null,
      playerName: actor?.person ? String((actor.person as Record<string, unknown>).internationalName || "") || null : null,
      ownGoal,
      penalty: subtype.includes("PENALTY"),
    };
  }).filter((goal) => goal.scoringTeamId && goal.minute >= 1 && goal.minute <= 130);
  const homeCount = goals.filter((goal) => goal.scoringTeamId === fixture.home_team_id).length;
  const awayCount = goals.filter((goal) => goal.scoringTeamId === fixture.away_team_id).length;
  if (homeCount === result.homeGoals && awayCount === result.awayGoals) result.goals = goals;
  result.stats = mapUefaStats(statsRaw, homeUefaId, awayUefaId);
  return result;
}

function mapTheSportsDbStats(raw: unknown, eventId: string) {
  const root = raw as Record<string, unknown> | null;
  const rows = Array.isArray(root?.eventstats) ? root.eventstats as Array<Record<string, unknown>> : [];
  const values: Record<string, number | null> = {};
  const aliases: Record<string, string> = {
    shotstotal: "shots",
    totalshots: "shots",
    shotsongoal: "shots_on_target",
    shotsontarget: "shots_on_target",
    corners: "corners",
    ballpossession: "possession",
    fouls: "fouls",
    yellowcards: "yellow_cards",
    redcards: "red_cards",
    saves: "saves",
    bigchances: "big_chances",
    expectedgoals: "xg",
  };
  for (const row of rows) {
    if (row.idEvent && String(row.idEvent) !== eventId) continue;
    const key = aliases[normalizeName(row.strStat || row.strStatistic)];
    if (!key) continue;
    const home = numeric(row.intHome ?? row.strHome ?? row.home);
    const away = numeric(row.intAway ?? row.strAway ?? row.away);
    if (home !== null) values[`home_${key}`] = home;
    if (away !== null) values[`away_${key}`] = away;
  }
  return Object.keys(values).length ? values : undefined;
}

async function syncFromTheSportsDb(fixture: SyncFixture): Promise<ProviderResult | null> {
  const key = process.env.THESPORTSDB_API_KEY || "123";
  const eventName = `${fixture.home_team}_vs_${fixture.away_team}`;
  const date = dateKeyIstanbul(new Date(fixture.kickoff_utc));
  const searchUrl = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/searchevents.php?e=${encodeURIComponent(eventName)}&d=${date}`;
  const searchRaw = await fetchJson(searchUrl);
  const events = (searchRaw as Record<string, unknown> | null)?.event;
  if (!Array.isArray(events)) return null;
  const match = (events as Array<Record<string, unknown>>).find((event) =>
    teamsMatch(fixture.home_team, event.strHomeTeam) && teamsMatch(fixture.away_team, event.strAwayTeam));
  if (!match) return null;
  const eventId = String(match.idEvent || "");
  const homeGoals = numeric(match.intHomeScore);
  const awayGoals = numeric(match.intAwayScore);
  const kickoffPassed = new Date(fixture.kickoff_utc).getTime() < Date.now() - 2 * 60 * 60 * 1000;
  const finished = homeGoals !== null && awayGoals !== null
    && (["Match Finished", "FT", "Finished"].includes(String(match.strStatus || "")) || kickoffPassed);
  const result: ProviderResult = {
    sourceName: "TheSportsDB",
    sourceUrl: `https://www.thesportsdb.com/event/${eventId}`,
    status: finished ? "FINISHED" : "TIMED",
  };
  if (!finished || !eventId) return result;
  result.homeGoals = Number(homeGoals);
  result.awayGoals = Number(awayGoals);
  const [timelineRaw, statsRaw] = await Promise.all([
    fetchJson(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/lookuptimeline.php?id=${eventId}`).catch(() => null),
    fetchJson(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/lookupeventstats.php?id=${eventId}`).catch(() => null),
  ]);
  const timeline = (timelineRaw as Record<string, unknown> | null)?.timeline;
  const goals = (Array.isArray(timeline) ? timeline as Array<Record<string, unknown>> : [])
    .filter((event) => /goal/i.test(String(event.strTimeline || event.strEvent || "")))
    .map((event, index) => {
      const teamId = String(event.idTeam || "");
      const side = teamId === String(match.idHomeTeam) ? "home" : teamId === String(match.idAwayTeam) ? "away" : "";
      const minuteText = String(event.intTime || event.strTime || "");
      const parts = minuteText.match(/(\d+)(?:\+(\d+))?/);
      return {
        sourceEventId: String(event.idTimeline || `tsdb-${eventId}-${index + 1}`),
        scoringTeamId: side === "home" ? fixture.home_team_id : side === "away" ? fixture.away_team_id : 0,
        minute: Number(parts?.[1] || 0),
        addedTime: Number(parts?.[2] || 0),
        period: null,
        playerName: event.strPlayer ? String(event.strPlayer) : null,
        ownGoal: /own/i.test(String(event.strTimelineDetail || "")),
        penalty: /pen/i.test(String(event.strTimelineDetail || "")),
      };
    }).filter((goal) => goal.scoringTeamId && goal.minute >= 1 && goal.minute <= 130);
  const homeCount = goals.filter((goal) => goal.scoringTeamId === fixture.home_team_id).length;
  const awayCount = goals.filter((goal) => goal.scoringTeamId === fixture.away_team_id).length;
  if (homeCount === result.homeGoals && awayCount === result.awayGoals) result.goals = goals;
  result.stats = mapTheSportsDbStats(statsRaw, eventId);
  return result;
}

async function persistResult(db: SqliteDb, fixture: SyncFixture, result: ProviderResult) {
  const checkedAt = new Date().toISOString();
  if (!fixture.has_manual_result && result.status) {
    const fixtureArgs = [
      result.status,
      result.homeGoals ?? fixture.home_goals,
      result.awayGoals ?? fixture.away_goals,
      result.sourceName,
      result.sourceUrl,
      checkedAt,
      fixture.id,
    ];
    const invalidNumber = fixtureArgs.find((value) => typeof value === "number" && !Number.isFinite(value));
    if (invalidNumber !== undefined) {
      throw new Error(`Fikstür ${fixture.id} için sağlayıcı sonucununda geçersiz sayı bulundu.`);
    }
    await db.run(`
      UPDATE fixtures SET status = ?, home_goals = ?, away_goals = ?,
        source_name = ?, source_url = ?, source_checked_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, fixtureArgs);
  }
  if (result.stats && Object.keys(result.stats).length) {
    const values = STAT_COLUMNS.map((column) => result.stats?.[column] ?? null);
    const assignments = STAT_COLUMNS.map((column) => `${column}=excluded.${column}`).join(",");
    await db.run(`
      INSERT INTO match_stats(fixture_id, ${STAT_COLUMNS.join(",")}, source_url, checked_at)
      VALUES (?, ${STAT_COLUMNS.map(() => "?").join(",")}, ?, ?)
      ON CONFLICT(fixture_id) DO UPDATE SET ${assignments}, source_url=excluded.source_url, checked_at=excluded.checked_at
    `, [fixture.id, ...values, result.sourceUrl, checkedAt]);
  }
  if (result.goals && result.homeGoals !== undefined && result.awayGoals !== undefined) {
    const acceptedHomeGoals = fixture.has_manual_result ? fixture.home_goals : result.homeGoals;
    const acceptedAwayGoals = fixture.has_manual_result ? fixture.away_goals : result.awayGoals;
    const homeCount = result.goals.filter((goal) => goal.scoringTeamId === fixture.home_team_id).length;
    const awayCount = result.goals.filter((goal) => goal.scoringTeamId === fixture.away_team_id).length;
    if (homeCount === acceptedHomeGoals && awayCount === acceptedAwayGoals) {
      await db.run("DELETE FROM goal_events WHERE fixture_id = ?", [fixture.id]);
      for (const goal of result.goals) {
        await db.run(`
          INSERT INTO goal_events(
            fixture_id, source_event_id, scoring_team_id, minute, added_time, period,
            player_name, event_type, is_own_goal, is_penalty, source_url, checked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GOAL', ?, ?, ?, ?)
        `, [
          fixture.id, goal.sourceEventId, goal.scoringTeamId, goal.minute, goal.addedTime,
          goal.period, goal.playerName, goal.ownGoal ? 1 : 0, goal.penalty ? 1 : 0,
          result.sourceUrl, checkedAt,
        ]);
      }
      await db.run(`
        INSERT INTO goal_event_sets(fixture_id, event_count, is_complete, source_name, source_url, checked_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(fixture_id) DO UPDATE SET event_count=excluded.event_count, is_complete=1,
          source_name=excluded.source_name, source_url=excluded.source_url, checked_at=excluded.checked_at
      `, [fixture.id, result.goals.length, result.sourceName, result.sourceUrl, checkedAt]);
    }
  }
}

export async function runDailyCloudSync() {
  const db = await getDb();
  await ensureSeedData(db);
  const runKey = `daily-${dateKeyIstanbul()}`;
  const lock = await db.run(`
    INSERT OR IGNORE INTO cloud_sync_locks(run_key, started_at, status)
    VALUES (?, ?, 'RUNNING')
  `, [runKey, new Date().toISOString()]);
  if (!lock.changes) {
    const retry = await db.run(`
      UPDATE cloud_sync_locks
      SET started_at = ?, finished_at = NULL, status = 'RUNNING', notes = NULL
      WHERE run_key = ? AND (
        status = 'FAILED' OR (status = 'RUNNING' AND datetime(started_at) < datetime('now', '-30 minutes'))
      )
    `, [new Date().toISOString(), runKey]);
    if (!retry.changes) {
      const existing = await db.get("SELECT status, notes FROM cloud_sync_locks WHERE run_key = ?", [runKey]);
      return { ok: true, alreadyRun: true, runKey, existing };
    }
  }

  const syncStarted = new Date().toISOString();
  const syncRun = await db.run(`
    INSERT INTO sync_runs(started_at, status, notes) VALUES (?, 'RUNNING', ?)
  `, [syncStarted, "Günlük Vercel bulut güncellemesi"]);
  const syncRunId = Number(syncRun.lastInsertRowid);
  let checked = 0;
  let updated = 0;
  let completeGoalSets = 0;
  const errors: string[] = [];
  try {
    const fixtures = await db.all(`
      SELECT f.id, f.external_id, f.competition_code, f.kickoff_utc, f.status,
             f.home_goals, f.away_goals, f.home_team_id, f.away_team_id,
             ht.name AS home_team, at.name AS away_team, f.source_url,
             CASE WHEN mr.fixture_id IS NULL THEN 0 ELSE 1 END AS has_manual_result,
             CASE WHEN ges.is_complete = 1 THEN 1 ELSE 0 END AS has_complete_goals
      FROM fixtures f
      JOIN teams ht ON ht.id = f.home_team_id
      JOIN teams at ON at.id = f.away_team_id
      LEFT JOIN manual_fixture_results mr ON mr.fixture_id = f.id
      LEFT JOIN goal_event_sets ges ON ges.fixture_id = f.id
      WHERE (
        datetime(f.kickoff_utc) >= datetime('now', '-3 days')
        AND datetime(f.kickoff_utc) <= datetime('now', '+12 hours')
      ) OR (
        f.status = 'FINISHED' AND ges.fixture_id IS NULL
        AND datetime(f.kickoff_utc) >= datetime('now', '-180 days')
      )
      ORDER BY CASE
                 WHEN f.status <> 'FINISHED' AND datetime(f.kickoff_utc) <= datetime('now') THEN 0
                 WHEN f.status = 'FINISHED' AND ges.fixture_id IS NULL THEN 1
                 ELSE 2
               END,
               f.kickoff_utc DESC
      LIMIT 9
    `) as unknown as SyncFixture[];

    for (let index = 0; index < fixtures.length; index += 3) {
      const group = fixtures.slice(index, index + 3);
      const providerResults = await Promise.allSettled(group.map(async (fixture) => {
        const isUefa = ["CL", "EL", "ECL"].includes(fixture.competition_code);
        return isUefa ? syncFromUefa(fixture) : syncFromTheSportsDb(fixture);
      }));
      for (let resultIndex = 0; resultIndex < providerResults.length; resultIndex += 1) {
        const fixture = group[resultIndex];
        const providerResult = providerResults[resultIndex];
        checked += 1;
        if (providerResult.status === "rejected") {
          errors.push(`${fixture.id}: ${
            providerResult.reason instanceof Error ? providerResult.reason.message : String(providerResult.reason)
          }`.slice(0, 220));
          continue;
        }
        if (!providerResult.value) continue;
        try {
          await persistResult(db, fixture, providerResult.value);
          updated += 1;
          if (providerResult.value.goals) completeGoalSets += 1;
        } catch (error) {
          errors.push(`${fixture.id}: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 220));
        }
      }
    }
    // Günlük çalışmada bugünün ve yarının kuponlarını güncelle; 31 günlük
    // kapsamlı yeniden hesaplama periyodik bakımda yapılır.
    const analysis = await runAnalysis(2);
    const status = errors.length && !updated ? "PARTIAL" : "SUCCESS";
    const notes = JSON.stringify({ checked, updated, completeGoalSets, errors: errors.slice(0, 6), analysis });
    await db.run(`
      UPDATE sync_runs SET finished_at = ?, status = ?, fixtures_updated = ?,
        sources_checked = ?, notes = ? WHERE id = ?
    `, [new Date().toISOString(), status, updated, checked, notes, syncRunId]);
    await db.run(`
      UPDATE cloud_sync_locks SET finished_at = ?, status = ?, notes = ? WHERE run_key = ?
    `, [new Date().toISOString(), status, notes, runKey]);
    return { ok: true, runKey, checked, updated, completeGoalSets, errors: errors.slice(0, 6), analysis };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Günlük bulut güncellemesi başarısız:", error);
    await db.run("UPDATE sync_runs SET finished_at = ?, status = 'FAILED', notes = ? WHERE id = ?", [
      new Date().toISOString(), message, syncRunId,
    ]);
    await db.run("UPDATE cloud_sync_locks SET finished_at = ?, status = 'FAILED', notes = ? WHERE run_key = ?", [
      new Date().toISOString(), message, runKey,
    ]);
    throw error;
  }
}
