/**
 * ESPN public scoreboard adapter (best effort, not a guaranteed coverage source).
 * A final result is accepted only for a verified league, teams, and kickoff.
 * Cup results are intentionally excluded because full-time can include extra-time.
 */
export type FeedFixture = {
  competition_code: string;
  kickoff_utc: string;
  home_team: string;
  away_team: string;
};

export type ScoreboardMatch = {
  eventId: string;
  sourceUrl: string;
  kickoffUtc: string;
  homeName: string;
  awayName: string;
  homeScore: number | null;
  awayScore: number | null;
  final: boolean;
  canceled: boolean;
};

const leagues: Record<string,string> = {
  PL: "eng.1",
  LL: "esp.1",
  TSL: "tur.1",
  BL: "ger.1",
  SA: "ita.1",
};
const aliases: Record<string,string> = {
  "manutd":"manchesterunited",
  "manunited":"manchesterunited",
  "manchesterutd":"manchesterunited",
  "mancity":"manchestercity",
  "atleticomadrid":"atleticodemadrid",
  "intermilan":"internazionale",
  "internazionalemilano":"internazionale",
  "parissaintgermain":"psg",
  "basaksehir":"istanbulbasaksehir",
  "rizespor":"caykurrizespor",
};
export function canonicalTeam(name: unknown) {
  const clean = String(name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g,"i").toLowerCase()
    .replace(/\b(fk|fc|cf|sk|afc|football|futbol|club)\b/g, "")
    .replace(/[^a-z0-9]/g,"");
  return aliases[clean] || clean;
}

export function isSameTeam(a: unknown,b: unknown) {
  const left=canonicalTeam(a),right=canonicalTeam(b);
  // No substring matching: avoids youth/reserve or similarly named clubs.
  return left.length>2 && left===right;
}
function numberScore(value: unknown) {
  if(typeof value!=="number" && typeof value!=="string")return null;
  if(String(value).trim()==="")return null;
  const n=Number(value);
  return Number.isInteger(n) && n>=0 && n<=30 ? n:null;
}

export function parseEspnScoreboard(raw: unknown, sourceUrl: string): ScoreboardMatch[] {
  const root=raw && typeof raw==="object" ? raw as Record<string,unknown>:{};
  if(!Array.isArray(root.events))return [];
  const matches:ScoreboardMatch[]=[];
  for(const source of root.events){
    if(!source || typeof source!=="object")continue;
    const event=source as Record<string,unknown>;
    const competition=Array.isArray(event.competitions) ? event.competitions[0] as Record<string,unknown> : null;
    if(!competition || !Array.isArray(competition.competitors))continue;
    const entries=competition.competitors as Record<string,unknown>[];
    const home=entries.find(p=>p.homeAway==="home");
    const away=entries.find(p=>p.homeAway==="away");
    if(!home || !away)continue;
    const teamName=(entry:Record<string,unknown>)=>{
      const t=entry.team as Record<string,unknown> | undefined;
      return String(t?.displayName||t?.name||"");
    };
    const status=(event.status as Record<string,unknown> | undefined)?.type as Record<string,unknown>|undefined;
    const statusName=String(status?.name||"").toLowerCase();
    const statusState=String(status?.state||"").toLowerCase();
    const canceled=/cancel|postpon|abandon|suspend/.test(statusName);
    const final=!canceled && (status?.completed===true || statusName==="status_final")
      && statusState!=="pre" && statusState!=="in";
    const kickoffUtc=String(event.date || competition.date || "");
    if(!Number.isFinite(Date.parse(kickoffUtc)))continue;
    const eventId=String(event.id||"");
    if(!/^\d+$/.test(eventId))continue;
    matches.push({
      eventId,sourceUrl,kickoffUtc,homeName:teamName(home),awayName:teamName(away),
      homeScore:numberScore(home.score),awayScore:numberScore(away.score),final,canceled
    });
  }
  return matches;
}

export function findFixtureInScoreboard(fixture:FeedFixture,matches:ScoreboardMatch[]){
  const at=Date.parse(fixture.kickoff_utc);
  if(!Number.isFinite(at))return null;
  const matched=matches.filter(m=>
    Math.abs(Date.parse(m.kickoffUtc)-at) <= 12*60*60*1000 &&
    isSameTeam(fixture.home_team,m.homeName) &&
    isSameTeam(fixture.away_team,m.awayName)
  );
  return matched.length===1?matched[0]:null;
}

export async function loadLeagueScoreboard(code:string,utcDate:string):Promise<ScoreboardMatch[]>{
  const league=leagues[code];if(!league)return [];
  if(!/^\d{8}$/.test(utcDate))return [];
  const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${utcDate}&limit=500`;
  const response=await fetch(url,{
    cache:"no-store",headers:{Accept:"application/json"},signal:AbortSignal.timeout(8500)
  });
  if(!response.ok)throw new Error(`ESPN ${code}: HTTP ${response.status}`);
  return parseEspnScoreboard(await response.json(),url);
}
