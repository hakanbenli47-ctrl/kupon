import "server-only";

import { getDb, SqliteDb, withTransaction } from "./db";
import { ensureSeedData } from "./seed";

const MODEL_VERSION = "goal-poisson-2.1-timing";
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
  home_attacks?: number | null;
  away_attacks?: number | null;
  home_pass_accuracy?: number | null;
  away_pass_accuracy?: number | null;
  home_balls_recovered?: number | null;
  away_balls_recovered?: number | null;
  home_saves?: number | null;
  away_saves?: number | null;
  home_big_chances?: number | null;
  away_big_chances?: number | null;
  home_xg?: number | null;
  away_xg?: number | null;
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

type GoalTimingProfile = {
  averageScoredMinute: number | null;
  averageConcededMinute: number | null;
  firstHalfScoringShare: number | null;
  lateScoringShare: number | null;
  lateConcedingShare: number | null;
  earlyGoalMatchShare: number | null;
  secondHalfGoalShare: number | null;
  coverage: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[], fallback: number) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function recencyMean(values: number[], fallback: number) {
  if (!values.length) return fallback;
  const weights = values.map((_, index) => Math.max(1, values.length - index));
  return values.reduce((sum, value, index) => sum + value * weights[index], 0)
    / weights.reduce((sum, weight) => sum + weight, 0);
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
    shotsAgainst: isHome ? match.away_shots : match.home_shots,
    shotsOnTarget: isHome ? match.home_shots_on_target : match.away_shots_on_target,
    shotsOnTargetAgainst: isHome ? match.away_shots_on_target : match.home_shots_on_target,
    corners: isHome ? match.home_corners : match.away_corners,
    possession: isHome ? match.home_possession : match.away_possession,
    attacks: isHome ? match.home_attacks : match.away_attacks,
    passAccuracy: isHome ? match.home_pass_accuracy : match.away_pass_accuracy,
    ballsRecovered: isHome ? match.home_balls_recovered : match.away_balls_recovered,
    saves: isHome ? match.home_saves : match.away_saves,
    bigChances: isHome ? match.home_big_chances : match.away_big_chances,
    xg: isHome ? match.home_xg : match.away_xg,
  };
}

function present(values: Array<number | null | undefined>) {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function istanbulDateKey(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
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
           ms.home_corners, ms.away_corners, ms.home_possession, ms.away_possession,
           ms.home_attacks, ms.away_attacks, ms.home_pass_accuracy, ms.away_pass_accuracy,
           ms.home_balls_recovered, ms.away_balls_recovered, ms.home_saves, ms.away_saves,
           ms.home_big_chances, ms.away_big_chances, ms.home_xg, ms.away_xg
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

async function goalTimingProfile(db: SqliteDb, teamId: number, matches: MatchRow[]): Promise<GoalTimingProfile> {
  const empty = {
    averageScoredMinute: null,
    averageConcededMinute: null,
    firstHalfScoringShare: null,
    lateScoringShare: null,
    lateConcedingShare: null,
    earlyGoalMatchShare: null,
    secondHalfGoalShare: null,
    coverage: 0,
  };
  const fixtureIds = matches.map((match) => Number(match.id)).filter(Number.isFinite);
  if (!fixtureIds.length) return empty;
  const placeholders = fixtureIds.map(() => "?").join(",");
  const completeRows = await db.all(`
    SELECT fixture_id FROM goal_event_sets
    WHERE is_complete = 1 AND fixture_id IN (${placeholders})
  `, fixtureIds) as Array<{ fixture_id: number }>;
  const completeIds = completeRows.map((row) => Number(row.fixture_id));
  if (!completeIds.length) return empty;
  const completePlaceholders = completeIds.map(() => "?").join(",");
  const rows = await db.all(`
    SELECT ge.fixture_id, ge.scoring_team_id, ge.minute, ge.added_time, ge.period
    FROM goal_events ge
    WHERE ge.fixture_id IN (${completePlaceholders})
    ORDER BY ge.fixture_id, ge.minute, ge.added_time
  `, completeIds) as Array<{
    fixture_id: number;
    scoring_team_id: number;
    minute: number;
    added_time: number;
    period: string | null;
  }>;
  const scored = rows.filter((row) => Number(row.scoring_team_id) === teamId);
  const conceded = rows.filter((row) => Number(row.scoring_team_id) !== teamId);
  const elapsedMinute = (row: { minute: number; added_time: number }) =>
    Number(row.minute) + Number(row.added_time || 0);
  const isFirstHalf = (row: { minute: number; period: string | null }) =>
    row.period === "FIRST_HALF" || (!row.period && Number(row.minute) <= 45);
  const matchHasEarlyGoal = new Set(rows.filter((row) => elapsedMinute(row) <= 30).map((row) => Number(row.fixture_id)));
  return {
    averageScoredMinute: scored.length ? mean(scored.map(elapsedMinute), 0) : null,
    averageConcededMinute: conceded.length ? mean(conceded.map(elapsedMinute), 0) : null,
    firstHalfScoringShare: scored.length ? scored.filter(isFirstHalf).length / scored.length : null,
    lateScoringShare: scored.length ? scored.filter((row) => elapsedMinute(row) >= 76).length / scored.length : null,
    lateConcedingShare: conceded.length ? conceded.filter((row) => elapsedMinute(row) >= 76).length / conceded.length : null,
    earlyGoalMatchShare: matchHasEarlyGoal.size / completeIds.length,
    secondHalfGoalShare: rows.length ? rows.filter((row) => !isFirstHalf(row)).length / rows.length : null,
    coverage: completeIds.length / fixtureIds.length,
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
           ms.home_corners, ms.away_corners, ms.home_possession, ms.away_possession,
           ms.home_attacks, ms.away_attacks, ms.home_pass_accuracy, ms.away_pass_accuracy,
           ms.home_balls_recovered, ms.away_balls_recovered, ms.home_saves, ms.away_saves,
           ms.home_big_chances, ms.away_big_chances, ms.home_xg, ms.away_xg
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

  const homeAttack = recencyMean(hp.map((x) => x.scored), baseline.home) * 0.8
    + mean(hvp.map((x) => x.scored), baseline.home) * 0.2;
  const awayDefense = recencyMean(ap.map((x) => x.conceded), baseline.home) * 0.8
    + mean(avp.map((x) => x.conceded), baseline.home) * 0.2;
  const awayAttack = recencyMean(ap.map((x) => x.scored), baseline.away) * 0.8
    + mean(avp.map((x) => x.scored), baseline.away) * 0.2;
  const homeDefense = recencyMean(hp.map((x) => x.conceded), baseline.away) * 0.8
    + mean(hvp.map((x) => x.conceded), baseline.away) * 0.2;

  let expectedHome = homeAttack * 0.52 + awayDefense * 0.33 + baseline.home * 0.15;
  let expectedAway = awayAttack * 0.52 + homeDefense * 0.33 + baseline.away * 0.15;
  const [homeTiming, awayTiming] = await Promise.all([
    goalTimingProfile(db, fixture.home_team_id, homeRecent),
    goalTimingProfile(db, fixture.away_team_id, awayRecent),
  ]);
  const timingCoverage = (homeTiming.coverage + awayTiming.coverage) / 2;

  const homeSot = mean(present(hp.map((x) => x.shotsOnTarget)), 4.5);
  const awaySot = mean(present(ap.map((x) => x.shotsOnTarget)), 4.0);
  const homeShots = mean(present(hp.map((x) => x.shots)), 12);
  const awayShots = mean(present(ap.map((x) => x.shots)), 11);
  const homeCorners = mean(present(hp.map((x) => x.corners)), 5);
  const awayCorners = mean(present(ap.map((x) => x.corners)), 4.5);
  const homePossession = mean(present(hp.map((x) => x.possession)), 50);
  const awayPossession = mean(present(ap.map((x) => x.possession)), 50);
  const homeAttacks = mean(present(hp.map((x) => x.attacks)), 85);
  const awayAttacks = mean(present(ap.map((x) => x.attacks)), 80);
  const homePassAccuracy = mean(present(hp.map((x) => x.passAccuracy)), 78);
  const awayPassAccuracy = mean(present(ap.map((x) => x.passAccuracy)), 76);
  const homeRecoveries = mean(present(hp.map((x) => x.ballsRecovered)), 40);
  const awayRecoveries = mean(present(ap.map((x) => x.ballsRecovered)), 40);
  const homeBigChances = mean(present(hp.map((x) => x.bigChances)), 1.5);
  const awayBigChances = mean(present(ap.map((x) => x.bigChances)), 1.3);
  const homeXg = mean(present(hp.map((x) => x.xg)), homeAttack);
  const awayXg = mean(present(ap.map((x) => x.xg)), awayAttack);
  const homeSotAllowed = mean(present(hp.map((x) => x.shotsOnTargetAgainst)), 4);
  const awaySotAllowed = mean(present(ap.map((x) => x.shotsOnTargetAgainst)), 4.5);
  const statSeries = [
    [...hp.map((x) => x.shots), ...ap.map((x) => x.shots)],
    [...hp.map((x) => x.shotsOnTarget), ...ap.map((x) => x.shotsOnTarget)],
    [...hp.map((x) => x.corners), ...ap.map((x) => x.corners)],
    [...hp.map((x) => x.possession), ...ap.map((x) => x.possession)],
    [...hp.map((x) => x.attacks), ...ap.map((x) => x.attacks)],
    [...hp.map((x) => x.passAccuracy), ...ap.map((x) => x.passAccuracy)],
    [...hp.map((x) => x.ballsRecovered), ...ap.map((x) => x.ballsRecovered)],
    [...hp.map((x) => x.xg), ...ap.map((x) => x.xg)],
  ];
  const statsCoverage = (
    statSeries.reduce((total, values) => total + present(values).length, 0)
  ) / Math.max(1, (hp.length + ap.length) * statSeries.length);

  if (statsCoverage >= 0.2) {
    const homePressure = clamp(
      (homeSot - 4.5) * 0.018 + (homeShots - 12) * 0.004 + (homeCorners - 5) * 0.006
      + (homeAttacks - 85) * 0.001 + (homePassAccuracy - 78) * 0.002
      + (homeBigChances - 1.5) * 0.025 + (homeXg - homeAttack) * 0.05
      + (awaySotAllowed - 4.5) * 0.012,
      -0.14,
      0.14,
    );
    const awayPressure = clamp(
      (awaySot - 4.0) * 0.018 + (awayShots - 11) * 0.004 + (awayCorners - 4.5) * 0.006
      + (awayAttacks - 80) * 0.001 + (awayPassAccuracy - 76) * 0.002
      + (awayBigChances - 1.3) * 0.025 + (awayXg - awayAttack) * 0.05
      + (homeSotAllowed - 4) * 0.012,
      -0.14,
      0.14,
    );
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
  if (timingCoverage >= 0.4) {
    const earlySignal = mean(
      present([homeTiming.earlyGoalMatchShare, awayTiming.earlyGoalMatchShare]),
      0.45,
    ) - 0.45;
    const lateSignal = mean(
      present([
        homeTiming.lateScoringShare,
        awayTiming.lateScoringShare,
        homeTiming.lateConcedingShare,
        awayTiming.lateConcedingShare,
      ]),
      0.22,
    ) - 0.22;
    const multiplier = 1 + clamp(earlySignal * 0.08 + lateSignal * 0.06, -0.045, 0.065) * timingCoverage;
    expectedHome *= multiplier;
    expectedAway *= multiplier;
  }
  expectedHome = clamp(expectedHome, 0.25, 3.4);
  expectedAway = clamp(expectedAway, 0.2, 3.1);

  const lambda = expectedHome + expectedAway;
  const dataQuality = clamp(
    0.38
      + Math.min(homeRecent.length, awayRecent.length) * 0.055
      + Math.min(homeVenue.length, awayVenue.length, 5) * 0.018
      + Math.min(h2h.length, 3) * 0.018
      + Math.min(baseline.total, 100) / 1250
      + statsCoverage * 0.15
      + timingCoverage * 0.06,
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
      statsCoverage,
      sampleHome: homeRecent.length,
      sampleAway: awayRecent.length,
      sampleH2h: h2h.length,
      explanation: {
        expected_home: expectedHome,
        expected_away: expectedAway,
        home_last5_for: recencyMean(hp.map((x) => x.scored), 0),
        home_last5_against: recencyMean(hp.map((x) => x.conceded), 0),
        away_last5_for: recencyMean(ap.map((x) => x.scored), 0),
        away_last5_against: recencyMean(ap.map((x) => x.conceded), 0),
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
        home_avg_attacks: present(hp.map((x) => x.attacks)).length ? homeAttacks : null,
        away_avg_attacks: present(ap.map((x) => x.attacks)).length ? awayAttacks : null,
        home_pass_accuracy: present(hp.map((x) => x.passAccuracy)).length ? homePassAccuracy : null,
        away_pass_accuracy: present(ap.map((x) => x.passAccuracy)).length ? awayPassAccuracy : null,
        home_recoveries: present(hp.map((x) => x.ballsRecovered)).length ? homeRecoveries : null,
        away_recoveries: present(ap.map((x) => x.ballsRecovered)).length ? awayRecoveries : null,
        home_sot_allowed: present(hp.map((x) => x.shotsOnTargetAgainst)).length ? homeSotAllowed : null,
        away_sot_allowed: present(ap.map((x) => x.shotsOnTargetAgainst)).length ? awaySotAllowed : null,
        home_xg: present(hp.map((x) => x.xg)).length ? homeXg : null,
        away_xg: present(ap.map((x) => x.xg)).length ? awayXg : null,
        stats_coverage: statsCoverage,
        goal_timing_coverage: timingCoverage,
        home_avg_goal_minute: homeTiming.averageScoredMinute,
        away_avg_goal_minute: awayTiming.averageScoredMinute,
        home_avg_conceded_minute: homeTiming.averageConcededMinute,
        away_avg_conceded_minute: awayTiming.averageConcededMinute,
        home_first_half_scoring_share: homeTiming.firstHalfScoringShare,
        away_first_half_scoring_share: awayTiming.firstHalfScoringShare,
        home_late_scoring_share: homeTiming.lateScoringShare,
        away_late_scoring_share: awayTiming.lateScoringShare,
        home_late_conceding_share: homeTiming.lateConcedingShare,
        away_late_conceding_share: awayTiming.lateConcedingShare,
        home_early_goal_match_share: homeTiming.earlyGoalMatchShare,
        away_early_goal_match_share: awayTiming.earlyGoalMatchShare,
        home_second_half_goal_share: homeTiming.secondHalfGoalShare,
        away_second_half_goal_share: awayTiming.secondHalfGoalShare,
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

async function settleCoupons(db: SqliteDb) {
  const rows = await db.all(`
    SELECT c.id, c.status,
           COUNT(cs.prediction_id) AS selection_count,
           SUM(CASE WHEN p.outcome = 'WON' THEN 1 ELSE 0 END) AS won_count,
           SUM(CASE WHEN p.outcome = 'LOST' THEN 1 ELSE 0 END) AS lost_count,
           SUM(CASE WHEN p.outcome IS NULL THEN 1 ELSE 0 END) AS open_count
    FROM coupons c
    JOIN coupon_selections cs ON cs.coupon_id = c.id
    JOIN predictions p ON p.id = cs.prediction_id
    WHERE c.status NOT IN ('WON', 'LOST')
    GROUP BY c.id, c.status
  `) as unknown as Array<{
    id: number;
    status: string;
    selection_count: number;
    won_count: number;
    lost_count: number;
    open_count: number;
  }>;

  let updated = 0;
  for (const row of rows) {
    const selectionCount = Number(row.selection_count || 0);
    const wonCount = Number(row.won_count || 0);
    const lostCount = Number(row.lost_count || 0);
    const openCount = Number(row.open_count || 0);
    const nextStatus = lostCount > 0
      ? "LOST"
      : selectionCount > 0 && wonCount === selectionCount
        ? "WON"
        : openCount < selectionCount
          ? "PENDING"
          : row.status;
    if (nextStatus !== row.status) {
      await db.run("UPDATE coupons SET status = ? WHERE id = ?", [nextStatus, row.id]);
      updated += 1;
    }
  }
  return updated;
}

async function buildCoupons(db: SqliteDb, generatedFor: string) {
  const candidates = await db.all(`
    SELECT p.id, p.fixture_id, p.probability, p.data_quality, p.stats_coverage, f.kickoff_utc
    FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.is_active = 1 AND p.outcome IS NULL AND f.status IN ('SCHEDULED','TIMED','TBC')
      AND date(datetime(f.kickoff_utc, '+3 hours')) = date(?)
      AND p.probability >= 0.72 AND p.data_quality >= 0.68
    ORDER BY (p.probability * 0.65 + p.data_quality * 0.25 + p.stats_coverage * 0.10) DESC
  `, [generatedFor]) as unknown as { id: number; fixture_id: number; probability: number }[];

  const unique: typeof candidates = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (!seen.has(candidate.fixture_id)) {
      unique.push(candidate);
      seen.add(candidate.fixture_id);
    }
  }

  const groups = unique.length >= 9
    ? [unique.slice(0, 5), unique.slice(5, 10)]
    : unique.length >= 4
      ? [unique.slice(0, 5)]
      : [];
  const validGroups = groups.filter((candidateGroup) => candidateGroup.length >= 4);
  const existingRows = await db.all(`
    SELECT c.id, c.label, cs.prediction_id
    FROM coupons c
    JOIN coupon_selections cs ON cs.coupon_id = c.id
    WHERE c.generated_for = ? AND c.status = 'ACTIVE'
    ORDER BY c.id, cs.position
  `, [generatedFor]) as unknown as Array<{ id: number; label: string; prediction_id: number }>;
  const existingByLabel = new Map<string, { id: number; predictionIds: number[] }>();
  for (const row of existingRows) {
    const item = existingByLabel.get(row.label) || { id: Number(row.id), predictionIds: [] };
    item.predictionIds.push(Number(row.prediction_id));
    existingByLabel.set(row.label, item);
  }

  let created = 0;
  for (const [index, group] of validGroups.entries()) {
    const label = `Kupon ${index + 1}`;
    const existing = existingByLabel.get(label);
    const nextIds = group.map((pick) => Number(pick.id));
    const unchanged = existing
      && existing.predictionIds.length === nextIds.length
      && existing.predictionIds.every((id, position) => id === nextIds[position]);
    if (unchanged) continue;
    if (existing) {
      await db.run("UPDATE coupons SET status = 'SUPERSEDED' WHERE id = ?", [existing.id]);
    }
    const combined = group.reduce((value, pick) => value * pick.probability, 1);
    const risk = combined >= 0.35 ? "DUSUK" : combined >= 0.2 ? "ORTA" : "YUKSEK";
    const result = await db.run(`
      INSERT INTO coupons(generated_for, label, combined_probability, risk, status)
      VALUES (?, ?, ?, ?, 'ACTIVE')
    `, [generatedFor, label, combined, risk]);
    const couponId = Number(result.lastInsertRowid);
    await Promise.all(group.map((pick, position) => db.run(
      "INSERT INTO coupon_selections(coupon_id, prediction_id, position) VALUES (?, ?, ?)",
      [couponId, pick.id, position + 1],
    )));
    created += 1;
  }

  for (const [label, existing] of existingByLabel) {
    const index = Number(label.replace("Kupon ", "")) - 1;
    if (!validGroups[index]) {
      await db.run("UPDATE coupons SET status = 'SUPERSEDED' WHERE id = ?", [existing.id]);
    }
  }
  return created;
}

export async function runAnalysis(days = 15) {
  const bootstrapDb = await getDb();
  await ensureSeedData(bootstrapDb);
  return withTransaction(async (db) => {
    const settled = await settlePredictions(db);
    const couponsSettled = await settleCoupons(db);
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
      const existingRows = await db.all(`
        SELECT id, market FROM predictions
        WHERE fixture_id = ? AND is_active = 1 AND outcome IS NULL
      `, [fixture.id]) as unknown as Array<{ id: number; market: number }>;
      const existingByMarket = new Map(existingRows.map((row) => [Number(row.market), Number(row.id)]));
      if (!predictions.length) {
        await db.run("UPDATE predictions SET is_active = 0 WHERE fixture_id = ? AND is_active = 1", [fixture.id]);
        continue;
      }
      await Promise.all(predictions.map((prediction) => {
        const parameters = [
          prediction.selection,
          prediction.rawProbability,
          prediction.probability,
          prediction.expectedTotal,
          prediction.dataQuality,
          prediction.statsCoverage,
          prediction.sampleHome,
          prediction.sampleAway,
          prediction.sampleH2h,
          JSON.stringify(prediction.explanation),
          MODEL_VERSION,
        ];
        const existingId = existingByMarket.get(prediction.market);
        if (existingId) {
          return db.run(`
            UPDATE predictions
            SET selection = ?, raw_probability = ?, probability = ?, expected_total = ?,
                data_quality = ?, stats_coverage = ?, sample_home = ?, sample_away = ?, sample_h2h = ?,
                explanation_json = ?, model_version = ?
            WHERE id = ?
          `, [...parameters, existingId]);
        }
        return db.run(`
          INSERT INTO predictions(
            fixture_id, market, selection, raw_probability, probability, expected_total,
            data_quality, stats_coverage, sample_home, sample_away, sample_h2h, explanation_json, model_version, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `, [fixture.id, prediction.market, ...parameters]);
      }));
      analyzed += 1;
    }

    const dates = [...new Set(fixtures.map((fixture) => istanbulDateKey(fixture.kickoff_utc)))];
    let coupons = 0;
    for (const date of dates) coupons += await buildCoupons(db, date);
    return { analyzed, settled, couponsSettled, coupons, fixturesInWindow: fixtures.length, modelVersion: MODEL_VERSION };
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
    SELECT c.id, c.generated_for, c.label, c.combined_probability, c.risk,
           COALESCE(mcr.status, c.status) AS status,
           CASE WHEN mcr.coupon_id IS NULL THEN 0 ELSE 1 END AS manually_reviewed,
           c.created_at,
           cs.position, p.market, p.selection, p.probability, p.outcome,
           f.id AS fixture_id, f.kickoff_utc, ht.name AS home_team, at.name AS away_team,
           f.status AS fixture_status, f.home_goals, f.away_goals,
           comp.code AS competition_code, comp.name AS competition
    FROM coupons c
    JOIN coupon_selections cs ON cs.coupon_id = c.id
    JOIN predictions p ON p.id = cs.prediction_id
    JOIN fixtures f ON f.id = p.fixture_id
    JOIN teams ht ON ht.id = f.home_team_id
    JOIN teams at ON at.id = f.away_team_id
    JOIN competitions comp ON comp.code = f.competition_code
    LEFT JOIN manual_coupon_reviews mcr ON mcr.coupon_id = c.id
    WHERE c.status <> 'SUPERSEDED'
    ORDER BY c.generated_for DESC, c.id DESC, cs.position
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
      manually_reviewed: Boolean(row.manually_reviewed),
      selections: [],
    };
    (existing.selections as Record<string, unknown>[]).push({
      position: row.position,
      fixture_id: row.fixture_id,
      market: row.market,
      selection: row.selection,
      probability: row.probability,
      kickoff_utc: row.kickoff_utc,
      home_team: row.home_team,
      away_team: row.away_team,
      competition_code: row.competition_code,
      competition: row.competition,
      outcome: row.outcome,
      fixture_status: row.fixture_status,
      home_goals: row.home_goals,
      away_goals: row.away_goals,
    });
    couponMap.set(id, existing);
  });

  const metrics = await db.get(`
    SELECT COUNT(*) AS settled,
           SUM(CASE WHEN outcome = 'WON' THEN 1 ELSE 0 END) AS won
    FROM predictions WHERE outcome IN ('WON','LOST')
  `) || { settled: 0, won: 0 };
  const poolMetrics = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM fixtures WHERE status = 'FINISHED') AS historical_matches,
      (SELECT COUNT(*) FROM match_stats) AS detailed_stats_matches,
      (SELECT COUNT(*) FROM goal_event_sets WHERE is_complete = 1) AS goal_timing_matches,
      (SELECT COUNT(*) FROM teams) AS teams,
      (
        SELECT COUNT(*) FROM (
          SELECT team_id
          FROM (
            SELECT home_team_id AS team_id FROM fixtures WHERE status = 'FINISHED'
            UNION ALL
            SELECT away_team_id AS team_id FROM fixtures WHERE status = 'FINISHED'
          )
          GROUP BY team_id
          HAVING COUNT(*) >= 5
        )
      ) AS teams_ready
  `) || {};
  const sourceRows = await db.all(`
    SELECT source_name, COUNT(*) AS match_count,
           SUM(CASE WHEN status = 'FINISHED' THEN 1 ELSE 0 END) AS result_count,
           MAX(source_checked_at) AS last_checked_at
    FROM fixtures
    GROUP BY source_name
    ORDER BY match_count DESC
  `);
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
      historicalMatches: Number(poolMetrics.historical_matches || 0),
      detailedStatsMatches: Number(poolMetrics.detailed_stats_matches || 0),
      goalTimingMatches: Number(poolMetrics.goal_timing_matches || 0),
      teams: Number(poolMetrics.teams || 0),
      teamsReady: Number(poolMetrics.teams_ready || 0),
    },
    sources: sourceRows.map((row) => ({
      name: String(row.source_name),
      matches: Number(row.match_count || 0),
      results: Number(row.result_count || 0),
      lastCheckedAt: row.last_checked_at,
    })),
    lastSync,
  };
}
