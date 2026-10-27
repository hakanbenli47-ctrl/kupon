import "server-only";

import { getDb, type SqliteDb } from "./db";
import { ensureSeedData } from "./seed";
import { canonicalTeam, parseEspnScoreboard } from "./scoreboard-feed";

export const LEAGUE_SOURCES = [
  { code:"PL", name:"Premier Lig", country:"İngiltere", feed:"eng.1" },
  { code:"LL", name:"La Liga", country:"İspanya", feed:"esp.1" },
  { code:"TSL", name:"Süper Lig", country:"Türkiye", feed:"tur.1" },
  { code:"BL", name:"Bundesliga", country:"Almanya", feed:"ger.1" },
  { code:"SA", name:"Serie A", country:"İtalya", feed:"ita.1" },
] as const;

export const TFF_SOURCES = [
  {code:"T1",name:"Trendyol 1. Lig",country:"Türkiye",page:142,yearStart:"2026-08-07",maxWeek:38},
  {code:"T2",name:"Nesine 2. Lig",country:"Türkiye",page:976,yearStart:"2026-09-06",maxWeek:36},
  {code:"T3",name:"Nesine 3. Lig",country:"Türkiye",page:971,yearStart:"2026-09-06",maxWeek:34},
] as const;

type ImportedMatch = {
  external_id:string;
  competition_code:string;
  kickoff_utc:string;
  home_team:string;
  away_team:string;
  status:"SCHEDULED"|"TIMED"|"FINISHED"|"POSTPONED";
  home_goals:number|null;
  away_goals:number|null;
  source_name:string;
  source_url:string;
};

function decodeHtml(text:string) {
  const named:Record<string,string> = {nbsp:" ",amp:"&",quot:'"',apos:"'",lt:"<",gt:">",ouml:"ö",uuml:"ü",ccedil:"ç",Ouml:"Ö",Uuml:"Ü",Ccedil:"Ç",szlig:"ß"};
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(raw,entity:string)=>{
    if(entity.startsWith("#")){
      const hex=entity.toLowerCase().startsWith("#x");
      const n=Number.parseInt(entity.slice(hex?2:1),hex?16:10);
      return Number.isFinite(n)&&n>0&&n<=0x10ffff ? String.fromCodePoint(n) :raw;
    }
    return named[entity]??raw;
  });
}
function plainHtml(input:string){
  return decodeHtml(input.replace(/<script\b[\s\S]*?<\/script>/gi,"")
    .replace(/<style\b[\s\S]*?<\/style>/gi,"")
    .replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
}
function trDateUtc(dd:string,mm:string,yyyy:string,hh:string,min:string) {
  const h=Number(hh),minute=Number(min),year=Number(yyyy),month=Number(mm),day=Number(dd);
  if(h>23 || minute>59 || month<1 || month>12 || day<1 || day>31)return null;
  const date=new Date(Date.UTC(year,month-1,day,h-3,minute));
  const local=new Date(date.getTime()+3*3600_000);
  return Number.isFinite(date.getTime())&&local.getUTCFullYear()===year
    &&local.getUTCMonth()+1===month&&local.getUTCDate()===day ? date.toISOString():null;
}

export function parseTffRows(html:string,code:string,sourceUrl:string): ImportedMatch[] {
  const rows=html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[];
  const unique=new Map<string,ImportedMatch>();
  for(const row of rows){
    const text=plainHtml(row);
    const date=text.match(/\b(\d{2})\.(\d{2})\.(20\d{2})\s+(\d{2}):(\d{2})\b/);
    if(!date)continue;
    const kickoff=trDateUtc(date[1],date[2],date[3],date[4],date[5]);if(!kickoff)continue;
    // TFF match rows expose home club, score, away club as adjacent links.
    const anchors=[...row.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m=>plainHtml(m[1])).filter(Boolean);
    const scorePosition=anchors.findIndex(a=>/^\d{1,2}\s*-\s*\d{1,2}$/.test(a)||a==="-"||a==="–");
    const home=scorePosition>0?anchors[scorePosition-1]:anchors[0];
    const away=scorePosition>0?anchors[scorePosition+1]:anchors[1];
    if(!home||!away||home==="Detaylar"||away==="Detaylar"||canonicalTeam(home)===canonicalTeam(away))continue;
    const scoreLabel=scorePosition>0?anchors[scorePosition]:"";
    if(scorePosition<0 && !text.includes(`${home} - ${away}`) && !text.includes(`${home} – ${away}`))continue;
    const rawScore=scoreLabel.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    const hasScore=Boolean(rawScore);
    const status=hasScore?"FINISHED":"TIMED";
    const external_id=`tff-${code}-${kickoff.slice(0,10)}-${canonicalTeam(home)}-${canonicalTeam(away)}`;
    unique.set(external_id,{
      external_id,competition_code:code,kickoff_utc:kickoff,
      home_team:home,away_team:away,status,
      home_goals:rawScore?Number(rawScore[1]):null,
      away_goals:rawScore?Number(rawScore[2]):null,
      source_name:"TFF Fikstür",source_url:sourceUrl,
    });
  }
  return [...unique.values()];
}
function rounds(page:typeof TFF_SOURCES[number]) {
  const weeks=Math.max(1,Math.ceil((Date.now()-Date.parse(page.yearStart))/(7*86_400_000))+1);
  return [...new Set([weeks-1,weeks,weeks+1].map(x=>Math.max(1,Math.min(page.maxWeek,x))))];
}
async function requestText(url:string){
  const response=await fetch(url,{headers:{Accept:"text/html"},cache:"no-store",signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw Error(`TFF HTTP ${response.status}`);
  const bytes=await response.arrayBuffer();
  return new TextDecoder("windows-1254").decode(bytes);
}
async function requestEspn(league:string,day:string){
  const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${day}&limit=250`;
  const response=await fetch(url,{headers:{Accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(8_000)});
  if(!response.ok)throw Error(`ESPN HTTP ${response.status}`);
  const events=parseEspnScoreboard(await response.json(),url);
  return events.map(event=>({
    external_id:`espn-${league}-${event.eventId}`,competition_code:"",
    kickoff_utc:event.kickoffUtc,home_team:event.homeName,away_team:event.awayName,
    status:(event.final?"FINISHED":"TIMED") as ImportedMatch["status"],
    home_goals:event.final?event.homeScore:null,away_goals:event.final?event.awayScore:null,
    source_name:"ESPN Scoreboard",source_url:event.sourceUrl,
  }));
}

async function saveFixture(db:SqliteDb,fixture:ImportedMatch) {
  const kickoff=Date.parse(fixture.kickoff_utc);
  if(!Number.isFinite(kickoff)||!canonicalTeam(fixture.home_team)||!canonicalTeam(fixture.away_team)
    ||canonicalTeam(fixture.home_team)===canonicalTeam(fixture.away_team))return "ignored";
  const home=await db.run("INSERT OR IGNORE INTO teams(name) VALUES (?)",[fixture.home_team]);
  void home;
  await db.run("INSERT OR IGNORE INTO teams(name) VALUES (?)",[fixture.away_team]);
  const teams=await db.all("SELECT id, name FROM teams WHERE name IN (?, ?)",[fixture.home_team,fixture.away_team]);
  const h=teams.find(t=>t.name===fixture.home_team),a=teams.find(t=>t.name===fixture.away_team);
  if(!h||!a)return "ignored";
  const existing=await db.get("SELECT id, status FROM fixtures WHERE external_id=?",[fixture.external_id]) as {id:number;status:string}|undefined;
  // Avoid duplicating fixtures already imported from official season plans under another id.
  let duplicate: {id:number;status:string}|undefined;
  if(!existing){
    const similar=await db.all(`
      SELECT f.id,f.status, ht.name AS home_team,at.name AS away_team
      FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id
      JOIN teams at ON at.id=f.away_team_id
      WHERE f.competition_code=? AND ABS(strftime('%s',f.kickoff_utc)-strftime('%s',?))<=43200
    `,[fixture.competition_code,fixture.kickoff_utc]);
    const matches=similar.filter(m=>canonicalTeam(m.home_team)===canonicalTeam(fixture.home_team)
      &&canonicalTeam(m.away_team)===canonicalTeam(fixture.away_team));
    if(matches.length===1)duplicate={id:Number(matches[0].id),status:String(matches[0].status)};
  }
  const target=existing||duplicate;
  const verifiedFinal=fixture.status==="FINISHED"&&Number.isInteger(fixture.home_goals)&&Number.isInteger(fixture.away_goals);
  if(target){
    // Never replace manual results or downgrade a finished result to scheduled.
    const manual=await db.get("SELECT fixture_id FROM manual_fixture_results WHERE fixture_id=?",[target.id]);
    if(!manual){
      await db.run(`UPDATE fixtures SET
        kickoff_utc=CASE WHEN status IN ('FINISHED','POSTPONED','CANCELLED')
          THEN kickoff_utc ELSE ? END,
        status=CASE WHEN status IN ('FINISHED','POSTPONED','CANCELLED')
          THEN status WHEN ?=1 THEN 'FINISHED' ELSE ? END,
        home_goals=CASE WHEN ?=1 AND status NOT IN ('POSTPONED','CANCELLED')
          THEN ? ELSE home_goals END,
        away_goals=CASE WHEN ?=1 AND status NOT IN ('POSTPONED','CANCELLED')
          THEN ? ELSE away_goals END,
        source_url=?,source_name=?,source_checked_at=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,[
        fixture.kickoff_utc,verifiedFinal?1:0,fixture.status,
        verifiedFinal?1:0,fixture.home_goals,
        verifiedFinal?1:0,fixture.away_goals,
        fixture.source_url,fixture.source_name,new Date().toISOString(),target.id,
      ]);
    }
    return "updated";
  }
  await db.run(`INSERT INTO fixtures(external_id,competition_code,kickoff_utc,
    home_team_id,away_team_id,status,home_goals,away_goals,
    source_name,source_url,source_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[
      fixture.external_id,fixture.competition_code,fixture.kickoff_utc,Number(h.id),Number(a.id),
      verifiedFinal?"FINISHED":fixture.status,
      verifiedFinal?fixture.home_goals:null,verifiedFinal?fixture.away_goals:null,
      fixture.source_name,fixture.source_url,new Date().toISOString()
    ]);
  return "added";
}

export async function importLeagueFixtures(maxPerLeague = 24) {
  const perLeague=Math.max(6,Math.min(70,Math.floor(maxPerLeague)));
  const db=await getDb();
  await ensureSeedData(db);
  for(const league of [...LEAGUE_SOURCES,...TFF_SOURCES]){
    await db.run("INSERT OR IGNORE INTO competitions(code,name,country) VALUES (?,?,?)",
      [league.code,league.name,league.country]);
  }
  let added=0,updated=0,ignored=0;
  const sources: Array<{league:string;fetched:number;error?:string}>=[];
  const maxPast=Date.now()-28*86_400_000;
  const maxFuture=Date.now()+32*86_400_000;
  const orderByRelevance=(a:ImportedMatch,b:ImportedMatch)=>{
    const aDate=Date.parse(a.kickoff_utc), bDate=Date.parse(b.kickoff_utc);
    const rank=(d:number)=>d>=Date.now() ? d-Date.now() : (Date.now()-d)+14*86_400_000;
    return rank(aDate)-rank(bDate);
  };
  // Date ranges span recent history, today and the next 31 days.
  // ESPN supports range windows, avoiding hundreds of daily requests.
  for(const league of LEAGUE_SOURCES){
    let matches:ImportedMatch[]=[];
    try {
      const start=new Date(maxPast).toISOString().slice(0,10).replace(/-/g,"");
      const end=new Date(maxFuture).toISOString().slice(0,10).replace(/-/g,"");
      matches=(await requestEspn(league.feed,`${start}-${end}`))
        .map(f=>({...f,competition_code:league.code}));
      sources.push({league:league.name,fetched:matches.length});
    }catch(error){
      sources.push({league:league.name,fetched:0,error:error instanceof Error?error.message:String(error)});
    }
    for(const match of matches.filter(match=>Date.parse(match.kickoff_utc)>=maxPast&&Date.parse(match.kickoff_utc)<=maxFuture).sort(orderByRelevance).slice(0,perLeague)) {
      try {
        const result=await saveFixture(db,match);
        if(result==="added")added++;else if(result==="updated")updated++;else ignored++;
      }catch(error){ignored++; sources.push({league:league.name+" – kayıt",fetched:0,error:String(error).slice(0,160)});}
    }
  }
  for(const league of TFF_SOURCES){
    const baseUrl=`https://www.tff.org/default.aspx?pageID=${league.page}`;
    const failures:string[]=[];
    let baseHtml="";
    try{baseHtml=await requestText(baseUrl);}catch(error){
      failures.push(error instanceof Error?error.message:String(error));
    }
    const groupUrls=new Set<string>([baseUrl]);
    // Read group IDs from current season's own league selector links,
    // rather than guessing IDs from previous seasons.
    for(const anchor of baseHtml.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)){
      const label=plainHtml(anchor[2]).trim();
      if(!/^(?:beyaz|kırmızı|0?[1-4](?:\. grup)?|[1-4]\. grup)$/i.test(label))continue;
      const href=anchor[1].match(/href=["']([^"']+)["']/i)?.[1]||"";
      const groupId=decodeHtml(href).match(/grupID=(\d+)/i)?.[1];
      if(groupId)groupUrls.add(`https://www.tff.org/Default.aspx?pageID=${league.page}&grupID=${groupId}`);
      if(groupUrls.size>=5)break;
    }
    const addresses=[...new Set([...groupUrls].flatMap(url=>[
      url,...rounds(league).map(week=>`${url}&hafta=${week}`),
    ]))];
    const combined=new Map<string,ImportedMatch>();
    for(const item of parseTffRows(baseHtml,league.code,baseUrl))combined.set(item.external_id,item);
    const pages=await Promise.allSettled(addresses.filter(url=>url!==baseUrl).map(requestText));
    const otherAddresses=addresses.filter(url=>url!==baseUrl);
    for(let index=0;index<pages.length;index++){
      const result=pages[index];
      if(result.status==="rejected"){
        failures.push(result.reason instanceof Error?result.reason.message:String(result.reason));
        continue;
      }
      for(const item of parseTffRows(result.value,league.code,otherAddresses[index]))
        combined.set(item.external_id,item);
    }
    sources.push({league:league.name,fetched:combined.size,error:failures.length?failures[0]:undefined});
    for(const match of [...combined.values()].filter(match=>Date.parse(match.kickoff_utc)>=maxPast&&Date.parse(match.kickoff_utc)<=maxFuture).sort(orderByRelevance).slice(0,perLeague)){
      try{
        const result=await saveFixture(db,match);
        if(result==="added")added++;else if(result==="updated")updated++;else ignored++;
      }catch{ignored++;}
    }
  }
  return {added,updated,ignored,sources};
}
