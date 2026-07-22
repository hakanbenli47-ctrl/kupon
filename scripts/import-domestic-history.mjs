import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const files = [
  "at.1.json", "be.1.json", "de.1.json", "de.2.json", "en.1.json", "en.2.json",
  "en.3.json", "en.4.json", "es.1.json", "es.2.json", "fr.1.json", "fr.2.json",
  "gr.1.json", "it.1.json", "it.2.json", "nl.1.json", "pt.1.json", "sco.1.json",
  "tr.1.json",
];

const checkedAt = new Date().toISOString();
const allFixtures = [];
const competitions = [];
const currentSeed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "imports", "uefa-2026-07-22.generated.json"), "utf8"));
const targetNames = [...new Set(currentSeed.fixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team]))];
const aliases = new Map([
  ["RSC Anderlecht", "Anderlecht"],
  ["PAOK Saloniki", "PAOK"],
  ["FC Twente '65", "Twente"],
  ["Sport Lisboa e Benfica", "Benfica"],
  ["İstanbul Başakşehir", "Başakşehir"],
  ["Sporting Clube de Braga", "Braga"],
  ["Hibernian FC", "Hibernian"],
  ["Rapid Wien", "SK Rapid"],
  ["AFC Ajax", "Ajax"],
  ["KAA Gent", "Gent"],
  ["Motherwell FC", "Motherwell"],
]);

function normalized(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en")
    .replace(/\b(fc|cf|fk|sk|ac|afc|sc|club)\b/g, "").replace(/[^a-z0-9]/g, "");
}

const targetsByNormalized = new Map(targetNames.map((name) => [normalized(name), name]));
function targetName(sourceName) {
  return aliases.get(sourceName) || targetsByNormalized.get(normalized(sourceName));
}

for (const file of files) {
  const rawUrl = `https://raw.githubusercontent.com/openfootball/football.json/master/2025-26/${file}`;
  const pageUrl = `https://github.com/openfootball/football.json/blob/master/2025-26/${file}`;
  const response = await fetch(rawUrl, { headers: { "User-Agent": "KuponAnaliz/1.1 domestic-history" } });
  if (!response.ok) throw new Error(`${file} alınamadı: ${response.status}`);
  const data = await response.json();
  const code = `DOM-${file.replace(".json", "").replaceAll(".", "").toUpperCase()}`;
  competitions.push({ code, name: data.name, country: file.split(".")[0].toUpperCase() });

  for (const match of data.matches || []) {
    const score = match.score?.ft;
    if (!match.date || !match.team1 || !match.team2 || !Array.isArray(score) || score.length < 2) continue;
    if (!Number.isFinite(score[0]) || !Number.isFinite(score[1])) continue;
    const digest = crypto.createHash("sha1").update(`${code}|${match.date}|${match.team1}|${match.team2}`).digest("hex").slice(0, 20);
    const matchedHome = targetName(match.team1);
    const matchedAway = targetName(match.team2);
    if (!matchedHome && !matchedAway) continue;
    allFixtures.push({
      external_id: `openfootball-${digest}`,
      competition_code: code,
      kickoff_utc: `${match.date}T12:00:00.000Z`,
      home_team: matchedHome || match.team1,
      away_team: matchedAway || match.team2,
      status: "FINISHED",
      home_goals: Number(score[0]),
      away_goals: Number(score[1]),
      stage: match.round || "2025/26",
      source_name: "OpenFootball CC0",
      source_url: pageUrl,
      source_checked_at: checkedAt,
    });
  }
}

const selectedIds = new Set();
for (const team of targetNames) {
  allFixtures
    .filter((fixture) => fixture.home_team === team || fixture.away_team === team)
    .sort((a, b) => b.kickoff_utc.localeCompare(a.kickoff_utc))
    .slice(0, 5)
    .forEach((fixture) => selectedIds.add(fixture.external_id));
}
const fixtures = allFixtures.filter((fixture) => selectedIds.has(fixture.external_id))
  .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
const output = path.join(process.cwd(), "data", "imports", "domestic-2025-26-history.generated.json");
fs.writeFileSync(output, JSON.stringify({ competitions, fixtures }, null, 2), "utf8");
console.log(JSON.stringify({ ok: true, competitions: competitions.length, fixtures: fixtures.length, output }, null, 2));
