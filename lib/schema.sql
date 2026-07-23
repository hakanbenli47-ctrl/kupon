PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS competitions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  country TEXT
);

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  competition_code TEXT NOT NULL REFERENCES competitions(code),
  kickoff_utc TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  home_goals INTEGER,
  away_goals INTEGER,
  stage TEXT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (home_team_id <> away_team_id),
  CHECK (status IN ('SCHEDULED','TIMED','FINISHED','POSTPONED','CANCELLED','TBC'))
);

CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff ON fixtures(kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_home ON fixtures(home_team_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_away ON fixtures(away_team_id, kickoff_utc);

CREATE TABLE IF NOT EXISTS match_stats (
  fixture_id INTEGER PRIMARY KEY REFERENCES fixtures(id) ON DELETE CASCADE,
  home_shots INTEGER,
  away_shots INTEGER,
  home_shots_on_target INTEGER,
  away_shots_on_target INTEGER,
  home_corners INTEGER,
  away_corners INTEGER,
  home_possession REAL,
  away_possession REAL,
  home_fouls INTEGER,
  away_fouls INTEGER,
  home_yellow_cards INTEGER,
  away_yellow_cards INTEGER,
  home_red_cards INTEGER,
  away_red_cards INTEGER,
  home_attacks INTEGER,
  away_attacks INTEGER,
  home_pass_accuracy REAL,
  away_pass_accuracy REAL,
  home_passes_completed INTEGER,
  away_passes_completed INTEGER,
  home_passes_attempted INTEGER,
  away_passes_attempted INTEGER,
  home_balls_recovered INTEGER,
  away_balls_recovered INTEGER,
  home_saves INTEGER,
  away_saves INTEGER,
  home_big_chances INTEGER,
  away_big_chances INTEGER,
  home_xg REAL,
  away_xg REAL,
  source_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  CHECK (home_possession IS NULL OR home_possession BETWEEN 0 AND 100),
  CHECK (away_possession IS NULL OR away_possession BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS player_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_name TEXT NOT NULL,
  availability TEXT NOT NULL,
  reason TEXT,
  attack_impact REAL NOT NULL DEFAULT 0,
  defense_impact REAL NOT NULL DEFAULT 0,
  source_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  UNIQUE(fixture_id, team_id, player_name),
  CHECK (availability IN ('OUT','SUSPENDED','DOUBT','AVAILABLE')),
  CHECK (attack_impact BETWEEN 0 AND 0.15),
  CHECK (defense_impact BETWEEN 0 AND 0.15)
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  market REAL NOT NULL,
  selection TEXT NOT NULL,
  raw_probability REAL NOT NULL,
  probability REAL NOT NULL,
  expected_total REAL NOT NULL,
  data_quality REAL NOT NULL,
  stats_coverage REAL NOT NULL DEFAULT 0,
  sample_home INTEGER NOT NULL,
  sample_away INTEGER NOT NULL,
  sample_h2h INTEGER NOT NULL,
  explanation_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT,
  CHECK (market IN (1.5, 2.5, 3.5)),
  CHECK (selection IN ('ALT','UST')),
  CHECK (probability BETWEEN 0 AND 1),
  CHECK (outcome IS NULL OR outcome IN ('WON','LOST','VOID'))
);

CREATE INDEX IF NOT EXISTS idx_predictions_fixture ON predictions(fixture_id, is_active);
CREATE INDEX IF NOT EXISTS idx_predictions_calibration ON predictions(market, selection, outcome, probability);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_for TEXT NOT NULL,
  label TEXT NOT NULL,
  combined_probability REAL NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (risk IN ('DUSUK','ORTA','YUKSEK')),
  CHECK (status IN ('ACTIVE','SUPERSEDED','WON','LOST','PENDING'))
);

CREATE TABLE IF NOT EXISTS coupon_selections (
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  prediction_id INTEGER NOT NULL REFERENCES predictions(id),
  position INTEGER NOT NULL,
  PRIMARY KEY(coupon_id, prediction_id)
);

CREATE TABLE IF NOT EXISTS manual_fixture_results (
  fixture_id INTEGER PRIMARY KEY REFERENCES fixtures(id) ON DELETE CASCADE,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (home_goals BETWEEN 0 AND 30),
  CHECK (away_goals BETWEEN 0 AND 30)
);

CREATE TABLE IF NOT EXISTS manual_coupon_reviews (
  coupon_id INTEGER PRIMARY KEY REFERENCES coupons(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('WON','LOST'))
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  fixtures_added INTEGER NOT NULL DEFAULT 0,
  fixtures_updated INTEGER NOT NULL DEFAULT 0,
  sources_checked INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED'))
);

INSERT OR IGNORE INTO competitions(code, name, country) VALUES
  ('CL', 'UEFA Şampiyonlar Ligi', 'Avrupa'),
  ('EL', 'UEFA Avrupa Ligi', 'Avrupa'),
  ('ECL', 'UEFA Konferans Ligi', 'Avrupa'),
  ('PL', 'Premier Lig', 'İngiltere'),
  ('TSL', 'Süper Lig', 'Türkiye'),
  ('LL', 'La Liga', 'İspanya');
