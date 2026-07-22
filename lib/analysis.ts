import "server-only";

import { getDb, SqliteDb, withTransaction } from "./db";
import { ensureSeedData } from "./seed";

const MODEL_VERSION = "goal-poisson-1.1";
const MARKETS = [1.5, 2.5, 3.5] as const;

type MatchRow = {
  id?: number;
  home_team_id: number;
  away_team_id: number;
  home_goals: number;
  away_goals: number;
  home_shots?: number | null;
  away_shots?: number | null;
  home_shots_on_target?: number | null;
  away_shots_on_target?: number | null;
  home_corners?: number | null;
  away_corners?: number | null;
  home_possession?: number | null;
  away_possession?: number | null;
};

type FixtureRow = {
  id: number;
  competition_code: string;
  kickoff_utc: string;
  home_team_id: number;
  away_team_id: number;
  home_team: string;
  away_team: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[], fallback: number) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function poissonCdf(maxGoals: number, lambda: number) {
  let term = Math.exp(-lambda);
  let total = term;
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    term *= lambda / goals;
    total += term;
  }
  return clamp(total, 0, 1);
}

function teamPerspective(match: MatchRow, teamId: number) {
  const isHome = match.home_team_id === teamId;
  return {
    scored: isHome ? match.home_goals : match.away_goals,
    conceded: isHome ? match.away_goals : match.home_goals,
    total: match.home_goals + match.away_goals,
    shots: isHome ? match.home_shots : match.away_shots,
    shotsOnTarget: isHome ? match.home_shots_on_target : match.away_shots_on_target,
    corners: isHome ? match.home_corners : match.away_corners,
    possession: isHome ? match.home_possession : match.away_possession,
  };
}

function present(values: Array<number | null | undefined>) {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

async function calibration(db: SqliteDb, competition: string, market: number, selection: string, raw: number) {
  const low = Math.floor(raw * 10) / 10;
  const high = Math.min(1.001, low + 0.1);
  const row = await db.get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN p.outcome = 'WON' THEN 1 ELSE 0 END) AS wins
    FROM predictions p
    JOIN fixtures f ON f.id = p.fixture_id
    WHERE f.competition_code = ? AND p.market = ? AND p.selection = ?
      AND p.outcome IN ('WON','LOST') AND p.probability >= ? AND p.probability < ?
  `, [competition, market, selection, low, high]) as { total?: number; wins?: number } | undefined;

  const total = Number(row?.total || 0);
  const wins = Number(row?.wins || 0);
  if (total < 20) return raw;
  const empirical = (wins + raw * 10) / (total + 10);
  return clamp(raw * 0.45 + empirical * 0.55, 0.04, 0.96);
}

async function recentMatches(db: SqliteDb, teamId: number, before: string, venue?: "HOME" | "AWAY") {
  const venueClause = venue === "HOME" ? "AND home_team_id = ?" : venue === "AWAY" ? "AND away_team_id = ?" : "";
  return await db.all(`
    SELECT f.id, f.home_team_id, f.away_team_id, f.home_goals, f.away_goals,
           ms.home_shots, ms.away_shots, ms.home_shots_on_target, ms.away_shots_on_target,
           ms.home_corners, ms.away_corners, ms.home_possession, ms.away_possession
    FROM fixtures f LEFT JOIN match_stats ms ON ms.fixture_id = f.id
    WHERE f.status = 'FINISHED' AND f.kickoff_utc < ?
      AND (f.home_team_id = ? OR f.away_team_id = ?)
      ${venueClause}
    ORDER BY f.kickoff_utc DESC LIMIT 5
  `, [before, teamId, teamId, ...(venue ? [teamId] : [])]) as unknown as MatchRow[];
}

async function leagueBaseline(db: SqliteDb, competition: string, before: string) {
  const row = await db.get(`
    SELECT AVG(home_goals) AS home_avg, AVG(away_goals) AS away_avg, COUNT(*) AS total
    FROM (
      SELECT home_goals, away_goals FROM fixtures
      WHERE competition_code = ? AND status = 'FINISHED' AND kickoff_utc < ?
      ORDER BY kickoff_utc DESC LIMIT 300
    )
  `, [competition, before]) as { home_avg?: number; away_avg?: number; total?: number } | undefined;
  return {
    home: Number(row?.home_avg || 1.45),
    away: Number(row?.away_avg || 1.2),
    total: Number(row?.total || 0),
  };
}

async function absenceAdjustment(db: SqliteDb, fixtureId: number, teamId: number) {
  const row = await db.get(`
    SELECT COALESCE(SUM(attack_impact), 0) AS attack,
           COALESCE(SUM(defense_impact), 0) AS defense
    FROM player_availability
    WHERE fixture_id = ? AND team_id = ? AND availability IN ('OUT','SUSPENDED')
  `, [fixtureId, teamId]) as { attack?: number; defense?: number } | undefined;
  return {
    attack: clamp(Number(row?.attack || 0), 0, 0.18),
    defense: clamp(Number(row?.defense || 0), 0, 0.18),
  };
}

async function analyzeFixture(db: SqliteDb, fixture: FixtureRow) {
  const [homeRecent, awayRecent, homeVenue, awayVenue] = await Promise.all([
    recentMatches(db, fixture.home_team_id, fixture.kickoff_utc),
    recentMatches(db, fixture.away_team_id, fixture.kickoff_utc),
    recentMatches(db, fixture.home_team_id, fixture.kickoff_utc, "HOME"),
    recentMatches(db, fixture.away_team_id, fixture.kickoff_utc, "AWAY"),
  ]);
  if (homeRecent.length < 5 || awayRecent.length < 5) return [];

  const h2h = await db.all(`
    SELECT f.id, f.home_team_id, f.away_team_id, f.home_goals, f.away_goals,
           ms.home_shots, ms.away_shots, ms.home_shots_on_target, ms.away_shots_on_target,
           ms.home_corners, ms.away_corners, ms.home_possession, ms.away_possession
    FROM fixtures f LEFT JOIN match_stats ms ON ms.fixture_id = f.id
    WHERE f.status = 'FINISHED' AND f.kickoff_utc < ?
      AND ((f.home_team_id = ? AND f.away_team_id = ?) OR (f.home_team_id = ? AND f.away_team_id = ?))
    ORDER BY f.kickoff_utc DESC
  `, [
    fixture.kickoff_utc,
    fixture.home_team_id,
    fixture.away_team_id,
    fixture.away_team_id,
    fixture.home_team_id,
  ]) as unknown as MatchRow[];

  const baseline = await leagueBaseline(db, fixture.competition_code, fixture.kickoff_utc);
  const hp = homeRecent.map((match) => teamPerspective(match, fixture.home_team_id));
  const ap = awayRecent.map((match) => teamPerspective(match, fixture.away_team_id));
  const hvp = homeVenue.map((match) => teamPerspective(match, fixture.home_team_id));
  const avp = awayVenue.map((match) => teamPerspective(match, fixture.away_team_id));

  const homeAttack = mean(hp.map((x) => x.scored), baseline.home) * 0.8
    + mean(hvp.map((x) => x.scored), baseline.home) * 0.2;
  const awayDefense = mean(ap.map((x) => x.conceded), baseline.home) * 0.8
    + mean(avp.map((x) => x.conceded), baseline.home) * 0.2;
  const awayAttack = mean(ap.map((x) => x.scored), baseline.away) * 0.8
    + mean(avp.map((x) => x.scored), baseline.away) * 0.2;
  const homeDefense = mean(hp.map((x) => x.conceded), baseline.away) * 0.8
    + mean(hvp.map((x) => x.conceded), baseline.away) * 0.2;

  let expectedHome = homeAttack * 0.52 + awayDefense * 0.33 + baseline.home * 0.15;
  let expectedAway = awayAttack * 0.52 + homeDefense * 0.33 + baseline.away * 0.15;

  const homeSot = mean(present(hp.map((x) => x.shotsOnTarget)), 4.5);
  const awaySot = mean(present(ap.map((x) => x.shotsOnTarget)), 4.0);
  const homeShots = mean(present(hp.map((x) => x.shots)), 12);
  const awayShots = mean(present(ap.map((x) => x.shots)), 11);
  const homeCorners = mean(present(hp.map((x) => x.corners)), 5);
  const awayCorners = mean(present(ap.map((x) => x.corners)), 4.5);
  const homePossession = mean(present(hp.map((x) => x.possession)), 50);
  const awayPossession = mean(present(ap.map((x) => x.possession)), 50);
  const statsCoverage = (
    present([...hp.map((x) => x.shots), ...ap.map((x) => x.shots)]).length +
    present([...hp.map((x) => x.shotsOnTarget), ...ap.map((x) => x.shotsOnTarget)]).length +
    present([...hp.map((x) => x.corners), ...ap.map((x) => x.corners)]).length
  ) / Math.max(1, (hp.length + ap.length) * 3);

  if (statsCoverage >= 0.4) {
    const homePressure = clamp((homeSot - 4.5) * 0.025 + (homeShots - 12) * 0.006 + (homeCorners - 5) * 0.008, -0.1, 0.1);
    const awayPressure = clamp((awaySot - 4.0) * 0.025 + (awayShots - 11) * 0.006 + (awayCorners - 4.5) * 0.008, -0.1, 0.1);
    expectedHome *= 1 + homePressure;
    expectedAway *= 1 + awayPressure;
  }

  let h2hWeight = 0;
  if (h2h.length > 0) {
    h2hWeight = clamp(h2h.length * 0.025, 0.05, 0.15);
    const h2hTotal = mean(h2h.map((match) => match.home_goals + match.away_goals), baseline.home + baseline.away);
    const currentTotal = expectedHome + expectedAway;
    const adjustedTotal = currentTotal * (1 - h2hWeight) + h2hTotal * h2hWeight;
    const ratio = adjustedTotal / Math.max(0.5, currentTotal);
    expectedHome *= ratio;
    expectedAway *= ratio;
  }

  const [homeAbsence, awayAbsence] = await Promise.all([
    absenceAdjustment(db, fixture.id, fixture.home_team_id),
    absenceAdjustment(db, fixture.id, fixture.away_team_id),
  ]);
  expectedHome *= 1 - homeAbsence.attack + awayAbsence.defense;
  expectedAway *= 1 - awayAbsence.attack + homeAbsence.defense;
  expectedHome = clamp(expectedHome, 0.25, 3.4);
  expectedAway = clamp(expectedAway, 0.2, 3.1);

  const lambda = expectedHome + expectedAway;
  const dataQuality = clamp(
    0.48 + Math.min(homeRecent.length, awayRecent.length) * 0.05 + Math.min(h2h.length, 3) * 0.025 + Math.min(baseline.total, 100) / 1000 + statsCoverage * 0.07,
    0,
    1,
  );

  return Promise.all(MARKETS.map(async (market) => {
    const maxUnderGoals = Math.floor(market);
    const under = poissonCdf(maxUnderGoals, lambda);
    const rawProbability = Math.max(under, 1 - under);
    const selection = under >= 0.5 ? "ALT" : "UST";
    const probability = await calibration(db, fixture.competition_code, market, selection, rawProbability);
    return {
      market,
      selection,
      rawProbability,
      probability,
      expectedTotal: lambda,
      dataQuality,
      sampleHome: homeRecent.length,
      sampleAway: awayRecent.length,
      sampleH2h: h2h.length,
      explanation: {
        expected_home: expectedHome,
        expected_away: expectedAway,
        home_last5_for: mean(hp.map((x) => x.scored), 0),
        home_last5_against: mean(hp.map((x) => x.conceded), 0),
        away_last5_for: mean(ap.map((x) => x.scored), 0),
        away_last5_against: mean(ap.map((x) => x.conceded), 0),
        h2h_total_average: h2h.length ? mean(h2h.map((x) => x.home_goals + x.away_goals), 0) : null,
        h2h_weight: h2hWeight,
        home_avg_shots: present(hp.map((x) => x.shots)).length ? homeShots : null,
        away_avg_shots: present(ap.map((x) => x.shots)).length ? awayShots : null,
        home_avg_shots_on_target: present(hp.map((x) => x.shotsOnTarget)).length ? homeSot : null,
        away_avg_shots_on_target: present(ap.map((x) => x.shotsOnTarget)).length ? awaySot : null,
        home_avg_corners: present(hp.map((x) => x.corners)).length ? homeCorners : null,
        away_avg_corners: present(ap.map((x) => x.corners)).length ? awayCorners : null,
        home_avg_possession: present(hp.map((x) => x.possession)).length ? homePossession : null,
        away_avg_possession: present(ap.map((x) => x.possession)).length ? awayPossession : null,
        stats_coverage: statsCoverage,
      },
    };
  }));
}

async function settlePredictions(db: SqliteDb) {
  const rows = await db.all(`
    SELECT p.id, p.market, p.selection, f.home_goals, f.away_goals
    FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.outcome IS NULL AND f.status = 'FINISHED'
      AND f.home_goals IS NOT NULL AND f.away_goals IS NOT NULL
  `) as unknown as { id: number; market: number; selection: string; home_goals: number; away_goals: number }[];

  await Promise.all(rows.map((row) => {
    const total = row.home_goals + row.away_goals;
    const won = row.selection === "UST" ? total > row.market : total < row.market;
    return db.run("UPDATE predictions SET outcome = ?, settled_at = CURRENT_TIMESTAMP WHERE id = ?", [won ? "WON" : "LOST", row.id]);
  }));
  return rows.length;
}

async function buildCoupons(db: SqliteDb, generatedFor: string) {
  await db.run("UPDATE coupons SET status = 'SUPERSEDED' WHERE generated_for = ? AND status = 'ACTIVE'", [generatedFor]);
  const candidates = await db.all(`
    SELECT p.id, p.fixture_id, p.probability, p.data_quality, f.kickoff_utc
    FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.is_active = 1 AND p.outcome IS NULL AND f.status IN ('SCHEDULED','TIMED','TBC')
      AND date(f.kickoff_utc) = date(?) AND p.probability >= 0.72 AND p.data_quality >= 0.65
    ORDER BY p.probability DESC, p.data_quality DESC
  `, [generatedFor]) as unknown as { id: number; fixture_id: number; probability: number }[];

  const unique: typeof candidates = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (!seen.has(candidate.fixture_id)) {
      unique.push(candidate);
      seen.add(candidate.fixture_id);
    }
  }

  const groups = unique.length >= 8 ? [unique.slice(0, 5), unique.slice(5, 10)] : unique.length >= 4 ? [unique.slice(0, 5)] : [];
  for (const [index, group] of groups.filter((candidateGroup) => candidateGroup.length >= 4).entries()) {
    const combined = group.reduce((value, pick) => value * pick.probability, 1);
    const risk = combined >= 0.35 ? "DUSUK" : combined >= 0.2 ? "ORTA" : "YUKSEK";
    const result = await db.run(`
      INSERT INTO coupons(generated_for, label, combined_probability, risk, status)
      VALUES (?, ?, ?, ?, 'ACTIVE')
    `, [generatedFor, `Kupon ${index + 1}`, combined, risk]);
    const couponId = Number(result.lastInsertRowid);
    await Promise.all(group.map((pick, position) => db.run(
      "INSERT INTO coupon_selections(coupon_id, prediction_id, position) VALUES (?, ?, ?)",
      [couponId, pick.id, position + 1],
    )));
  }

  return groups.filter((group) => group.length >= 4).length;
}

export async function runAnalysis(days = 15) {
  const bootstrapDb = await getDb();
  await ensureSeedData(bootstrapDb);
  return withTransaction(async (db) => {
    const settled = await settlePredictions(db);
    const fixtures = await db.all(`
      SELECT f.id, f.competition_code, f.kickoff_utc, f.home_team_id, f.away_team_id,
             ht.name AS home_team, at.name AS away_team
      FROM fixtures f
      JOIN teams ht ON ht.id = f.home_team_id
      JOIN teams at ON at.id = f.away_team_id
      WHERE f.status IN ('SCHEDULED','TIMED','TBC')
        AND datetime(f.kickoff_utc) >= datetime('now')
        AND datetime(f.kickoff_utc) < datetime('now', ?)
      ORDER BY f.kickoff_utc
    `, [`+${Math.max(1, Math.min(days, 31))} days`]) as unknown as FixtureRow[];

    let analyzed = 0;
    for (const fixture of fixtures) {
      const predictions = await analyzeFixture(db, fixture);
      await db.run("UPDATE predictions SET is_active = 0 WHERE fixture_id = ? AND is_active = 1", [fixture.id]);
      if (!predictions.length) continue;
      await Promise.all(predictions.map((prediction) => db.run(`
        INSERT INTO predictions(
          fixture_id, market, selection, raw_probability, probability, expected_total,
          data_quality, sample_home, sample_away, sample_h2h, explanation_json, model_version, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `, [
        fixture.id,
        prediction.market,
        prediction.selection,
        prediction.rawProbability,
        prediction.probability,
        prediction.expectedTotal,
        prediction.dataQuality,
        prediction.sampleHome,
        prediction.sampleAway,
        prediction.sampleH2h,
        JSON.stringify(prediction.explanation),
        MODEL_VERSION,
      ])));
      analyzed += 1;
    }

    const dates = [...new Set(fixtures.map((fixture) => fixture.kickoff_utc.slice(0, 10)))];
    let coupons = 0;
    for (const date of dates) coupons += await buildCoupons(db, date);
    return { analyzed, settled, coupons, fixturesInWindow: fixtures.length, modelVersion: MODEL_VERSION };
  });
}

export async function getDashboard(days = 15) {
  const db = await getDb();
  await ensureSeedData(db);
  const fixtures = await db.all(`
    SELECT f.id, f.external_id, f.kickoff_utc, f.status, f.home_goals, f.away_goals,
           c.code AS competition_code, c.name AS competition,
           ht.name AS home_team, at.name AS away_team,
           f.source_name, f.source_url, f.source_checked_at
    FROM fixtures f
    JOIN competitions c ON c.code = f.competition_code
    JOIN teams ht ON ht.id = f.home_team_id
    JOIN teams at ON at.id = f.away_team_id
    WHERE datetime(f.kickoff_utc) >= datetime('now', '-1 day')
      AND datetime(f.kickoff_utc) < datetime('now', ?)
    ORDER BY f.kickoff_utc
  `, [`+${Math.max(1, Math.min(days, 31))} days`]);

  const predictionRows = await db.all(`
    SELECT p.*, f.competition_code FROM predictions p
    JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.is_active = 1
  `);
  const predictions = new Map<number, Record<string, unknown>[]>();
  predictionRows.forEach((row) => {
    const fixtureId = Number(row.fixture_id);
    predictions.set(fixtureId, [...(predictions.get(fixtureId) || []), row]);
  });

  const enriched: Array<Record<string, unknown> & { predictions: Record<string, unknown>[] }> = fixtures.map((fixture) => ({
    ...fixture,
    predictions: predictions.get(Number(fixture.id)) || [],
  }));

  const couponRows = await db.all(`
    SELECT c.id, c.generated_for, c.label, c.combined_probability, c.risk, c.status, c.created_at,
           cs.position, p.market, p.selection, p.probability,
           f.kickoff_utc, ht.name AS home_team, at.name AS away_team,
           comp.code AS competition_code, comp.name AS competition
    FROM coupons c
    JOIN coupon_selections cs ON cs.coupon_id = c.id
    JOIN predictions p ON p.id = cs.prediction_id
    JOIN fixtures f ON f.id = p.fixture_id
    JOIN teams ht ON ht.id = f.home_team_id
    JOIN teams at ON at.id = f.away_team_id
    JOIN competitions comp ON comp.code = f.competition_code
    WHERE c.status = 'ACTIVE'
    ORDER BY c.generated_for, c.id, cs.position
  `);

  const couponMap = new Map<number, Record<string, unknown>>();
  couponRows.forEach((row) => {
    const id = Number(row.id);
    const existing = couponMap.get(id) || {
      id,
      generated_for: row.generated_for,
      label: row.label,
      combined_probability: row.combined_probability,
      risk: row.risk,
      status: row.status,
      selections: [],
    };
    (existing.selections as Record<string, unknown>[]).push({
      position: row.position,
      market: row.market,
      selection: row.selection,
      probability: row.probability,
      kickoff_utc: row.kickoff_utc,
      home_team: row.home_team,
      away_team: row.away_team,
      competition_code: row.competition_code,
      competition: row.competition,
    });
    couponMap.set(id, existing);
  });

  const metrics = await db.get(`
    SELECT COUNT(*) AS settled,
           SUM(CASE WHEN outcome = 'WON' THEN 1 ELSE 0 END) AS won
    FROM predictions WHERE outcome IN ('WON','LOST')
  `) || { settled: 0, won: 0 };
  const lastSync = await db.get("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1") || null;
  const upcomingCount = enriched.filter((fixture) => ["SCHEDULED", "TIMED", "TBC"].includes(String(fixture["status"]))).length;
  const analyzedCount = enriched.filter((fixture) => fixture.predictions.length > 0).length;

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    fixtures: enriched,
    coupons: [...couponMap.values()],
    metrics: {
      upcoming: upcomingCount,
      analyzed: analyzedCount,
      settled: Number(metrics.settled || 0),
      won: Number(metrics.won || 0),
      hitRate: Number(metrics.settled || 0) ? Number(metrics.won || 0) / Number(metrics.settled) : null,
    },
    lastSync,
  };
}
