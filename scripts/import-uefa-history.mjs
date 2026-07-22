import fs from "node:fs";
import path from "node:path";

const pages = [
  {
    code: "CL",
    url: "https://www.uefa.com/uefachampionsleague/news/029c-1e9a2f63fe2d-ebf9ad643892-1000--2025-26-champions-league-all/",
  },
  {
    code: "CL",
    url: "https://www.uefa.com/uefachampionsleague/news/029b-1e3069454cdf-6efa559be902-1000--champions-league-qualifying-fixtures-dates/",
  },
  {
    code: "EL",
    url: "https://www.uefa.com/uefaeuropaleague/news/029c-1e9ad67620f2-05c31d01f0f4-1000--2025-26-europa-league-fixtures-and-results-quarter-final/",
  },
  {
    code: "EL",
    url: "https://www.uefa.com/uefaeuropaleague/news/029b-1e44205b3005-ab9af86b3c62-1000--europa-league-qualifying-fixtures-dates-results-how-it-works/",
  },
  {
    code: "ECL",
    url: "https://www.uefa.com/uefaconferenceleague/news/029c-1e9ad66c8169-aaecb38941a7-1000--2025-26-conference-league-all-the-results/",
  },
  {
    code: "ECL",
    url: "https://www.uefa.com/uefaconferenceleague/news/029b-1e43ed1cf056-ea20f3f23ef3-1000--conference-league-qualifying-fixtures-dates-results-how-it-w/",
  },
];

const months = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function text(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, " ")
    .trim();
}

function dateFromHeading(value) {
  const match = value.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(2025|2026))?/i);
  if (!match) return null;
  const monthName = `${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`;
  const month = months[monthName];
  const year = match[3] ? Number(match[3]) : month >= 6 ? 2025 : 2026;
  return new Date(Date.UTC(year, month, Number(match[1]), 12, 0, 0)).toISOString();
}

function parsePage(html, page, checkedAt) {
  const fixtures = [];
  let kickoff = null;
  let stage = "2025/26 UEFA";
  const tokenRegex = /<(h2|h3|b)\b[^>]*>([\s\S]*?)<\/\1>|<a\b[^>]*href="([^"]*\/match\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let token;
  while ((token = tokenRegex.exec(html))) {
    if (token[1]) {
      const heading = text(token[2]);
      const parsedDate = dateFromHeading(heading);
      if (parsedDate) kickoff = parsedDate;
      if (token[1].toLowerCase() === "h2" || token[1].toLowerCase() === "h3") stage = heading;
      continue;
    }
    if (!kickoff) continue;
    const matchText = text(token[5]);
    const result = matchText.match(/^(.+?)\s+(\d+)-(\d+)(?:aet)?\s+(.+?)(?:\s+\(.*)?$/i);
    if (!result) continue;
    fixtures.push({
      external_id: `uefa-history-${page.code}-${token[4]}`,
      competition_code: page.code,
      kickoff_utc: kickoff,
      home_team: result[1].trim(),
      away_team: result[4].trim(),
      status: "FINISHED",
      home_goals: Number(result[2]),
      away_goals: Number(result[3]),
      stage,
      source_name: "UEFA",
      source_url: new URL(token[3], "https://www.uefa.com").href,
      source_checked_at: checkedAt,
    });
  }
  return fixtures;
}

const checkedAt = new Date().toISOString();
const all = [];
for (const page of pages) {
  const response = await fetch(page.url, { headers: { "User-Agent": "KuponAnaliz/1.1 historical-import" } });
  if (!response.ok) throw new Error(`${page.code} geçmiş sonuçları alınamadı: ${response.status}`);
  all.push(...parsePage(await response.text(), page, checkedAt));
}

const fixtures = [...new Map(all.map((fixture) => [fixture.external_id, fixture])).values()]
  .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
const output = path.join(process.cwd(), "data", "imports", "uefa-2025-26-history.generated.json");
fs.writeFileSync(output, JSON.stringify({ fixtures }, null, 2), "utf8");
console.log(JSON.stringify({ ok: true, fixtures: fixtures.length, output }, null, 2));
