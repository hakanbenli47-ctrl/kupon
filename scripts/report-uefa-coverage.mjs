import fs from "node:fs";
import path from "node:path";

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "imports", name), "utf8")).fixtures;
}

const current = read("uefa-2026-07-22.generated.json");
const history = read("uefa-2025-26-history.generated.json");
const domestic = read("domestic-2025-26-history.generated.json");
const now = new Date();
const end = new Date(now.getTime() + 31 * 86_400_000);
const upcoming = current.filter((fixture) =>
  ["CL", "EL", "ECL"].includes(fixture.competition_code)
  && ["SCHEDULED", "TIMED", "TBC"].includes(fixture.status)
  && new Date(fixture.kickoff_utc) >= now
  && new Date(fixture.kickoff_utc) < end
);
const teams = [...new Set(upcoming.flatMap((fixture) => [fixture.home_team, fixture.away_team]))].sort();
const finished = [...current, ...history, ...domestic].filter((fixture) =>
  fixture.status === "FINISHED" && new Date(fixture.kickoff_utc) < now
);
const rows = teams.map((team) => {
  const matches = finished.filter((fixture) => fixture.home_team === team || fixture.away_team === team);
  return {
    team,
    played: matches.length,
    sources: [...new Set(matches.map((fixture) => fixture.source_name))].sort(),
  };
});
const missing = rows.filter((row) => row.played < 5).sort((a, b) => a.played - b.played || a.team.localeCompare(b.team));

console.log(JSON.stringify({
  generated_at: now.toISOString(),
  upcoming: upcoming.length,
  teams: teams.length,
  ready: rows.length - missing.length,
  missing: missing.length,
  missing_teams: missing,
}, null, 2));
