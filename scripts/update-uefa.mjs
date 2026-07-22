import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const pages = [
  { code: "CL", url: "https://www.uefa.com/uefachampionsleague/accesslist/" },
  { code: "EL", url: "https://www.uefa.com/uefaeuropaleague/accesslist/" },
  { code: "ECL", url: "https://www.uefa.com/uefaconferenceleague/news/02a6-20e5e911587f-cc10425958b3-1000--conference-league-qualifying-fixtures-dates-how-it-works/" },
];

const monthNumbers = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function decode(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/[﻿​]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTeam(value) {
  return value.replace(/\*+$/g, "").replace(/^﻿/, "").trim();
}

function parsePage(html, page, checkedAt) {
  const fixtures = [];
  let stage = "Eleme turu";
  let leg = "";
  let currentDate = null;
  const blockRegex = /<(h2|h3|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let block;
  while ((block = blockRegex.exec(html))) {
    const tag = block[1].toLowerCase();
    const raw = block[2];
    const text = decode(raw);
    if (tag === "h2" && /qualifying round/i.test(text)) stage = text;
    if (tag === "h3" && /legs/i.test(text)) leg = text;

    const dateMatch = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i);
    if (dateMatch) {
      const monthName = `${dateMatch[2][0].toUpperCase()}${dateMatch[2].slice(1).toLowerCase()}`;
      currentDate = { day: Number(dateMatch[1]), month: monthNumbers[monthName] };
    }
    if (!currentDate) continue;

    const linkRegex = /<a\b[^>]*href="([^"]*\/match\/\d+[^\"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let link;
    while ((link = linkRegex.exec(raw))) {
      const url = new URL(link[1], "https://www.uefa.com").href;
      const matchText = decode(link[2]);
      const result = matchText.match(/^(.+?)\s+(\d+)-(\d+)(?:aet)?\s+(.+?)(?:\s+\(.*)?$/i);
      const scheduled = matchText.match(/^(.+?)\s+vs\s+(.+?)$/i);
      const trailing = raw.slice(linkRegex.lastIndex).split(/<br\s*\/?\s*>|<a\b/i, 1)[0];
      const timeMatch = decode(trailing).match(/\((\d{2}):(\d{2})\)/);
      if (!result && !scheduled) continue;

      const now = new Date();
      const year = now.getUTCFullYear();
      let kickoff;
      let homeTeam;
      let awayTeam;
      let status;
      let homeGoals = null;
      let awayGoals = null;
      if (result) {
        homeTeam = cleanTeam(result[1]);
        homeGoals = Number(result[2]);
        awayGoals = Number(result[3]);
        awayTeam = cleanTeam(result[4]);
        status = "FINISHED";
        kickoff = new Date(Date.UTC(year, currentDate.month, currentDate.day, 12, 0, 0));
      } else {
        homeTeam = cleanTeam(scheduled[1]);
        awayTeam = cleanTeam(scheduled[2]);
        status = timeMatch ? "TIMED" : "TBC";
        const cetHour = timeMatch ? Number(timeMatch[1]) : 13;
        const minute = timeMatch ? Number(timeMatch[2]) : 0;
        kickoff = new Date(Date.UTC(year, currentDate.month, currentDate.day, cetHour - 1, minute, 0));
      }

      const matchId = url.match(/\/match\/(\d+)/)?.[1];
      fixtures.push({
        external_id: `uefa-${page.code}-${matchId}`,
        competition_code: page.code,
        season: `${year}-${year + 1}`,
        stage: `${stage} ${leg}`.trim(),
        kickoff_utc: kickoff.toISOString(),
        home_team: homeTeam,
        away_team: awayTeam,
        status,
        home_goals: homeGoals,
        away_goals: awayGoals,
        source_name: "UEFA",
        source_url: url,
        source_checked_at: checkedAt,
      });
    }
  }
  return fixtures;
}

const checkedAt = new Date().toISOString();
const all = [];
for (const page of pages) {
  const response = await fetch(page.url, { headers: { "User-Agent": "KuponAnaliz/1.0 personal-local; 15-day refresh" } });
  if (!response.ok) throw new Error(`${page.code} fikstürü alınamadı: ${response.status}`);
  all.push(...parsePage(await response.text(), page, checkedAt));
}

const unique = [...new Map(all.map((fixture) => [fixture.external_id, fixture])).values()];
const now = Date.now();
const min = now - 45 * 86400000;
const max = now + 15 * 86400000;
const fixtures = unique.filter((fixture) => {
  const time = new Date(fixture.kickoff_utc).getTime();
  return time >= min && time <= max;
});

const outputDir = path.join(root, "data", "imports");
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, `uefa-${checkedAt.slice(0, 10)}.generated.json`);
fs.writeFileSync(output, JSON.stringify({ fixtures }, null, 2), "utf8");

const ingest = spawnSync(process.execPath, [path.join(root, "scripts", "ingest-fixtures.mjs"), output], {
  cwd: root,
  encoding: "utf8",
});
if (ingest.status !== 0) {
  process.stderr.write(ingest.stderr || ingest.stdout);
  process.exit(ingest.status || 1);
}
process.stdout.write(ingest.stdout);
console.log(JSON.stringify({ sourcePages: pages.length, parsed: unique.length, inWindow: fixtures.length, output }, null, 2));

const backup = spawnSync(process.execPath, [path.join(root, "scripts", "backup-db.mjs")], {
  cwd: root,
  encoding: "utf8",
});
if (backup.status !== 0) {
  process.stderr.write(backup.stderr || backup.stdout);
  process.exit(backup.status || 1);
}
process.stdout.write(backup.stdout);

try {
  const response = await fetch("http://localhost:3000/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days: 15 }),
  });
  if (response.ok) console.log(JSON.stringify({ analysis: await response.json() }, null, 2));
} catch {
  console.log("Panel çalışmıyorsa analiz, panel ilk açıldığında elle başlatılabilir.");
}
