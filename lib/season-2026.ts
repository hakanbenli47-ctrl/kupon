import "server-only";
import { getDb, type SqliteDb } from "./db";
import { ensureSeedData } from "./seed";
import { parseOpenLigaSeason } from "./season-parser";
import { LEAGUE_SOURCES, TFF_SOURCES, requestEspn, parseTffRows, saveFixture,
  type ImportedMatch } from "./league-fixtures";

const SEASON_START="2026-07-01T00:00:00Z";
const SEASON_END="2027-07-01T00:00:00Z";
const DAY=86_400_000;
const ESPN=LEAGUE_SOURCES.filter(l=>!["BL","BL2","BL3"].includes(l.code));
const GERMAN=[
  {code:"BL",name:"Bundesliga",slug:"bl1"},
  {code:"BL2",name:"2. Bundesliga",slug:"bl2"},
  {code:"BL3",name:"3. Liga",slug:"bl3"},
];
type Progress={
  provider:string;competition_code:string;part_key:string;cursor_index:number;
  state:string;imported:number;checked_at:string;error:string|null;
};
type Job={provider:"OPENLIGA"|"ESPN"|"TFF";code:string;part:string;cursor:number;max:number};
const dateCompact=(ms:number)=>new Date(ms).toISOString().slice(0,10).replace(/-/g,"");

async function jsonFrom(url:string){
  const res=await fetch(url,{cache:"no-store",headers:{Accept:"application/json"},signal:AbortSignal.timeout(12_000)});
  if(!res.ok)throw Error("HTTP "+res.status+" "+new URL(url).host);
  return res.json() as Promise<unknown>;
}
async function textFrom(url:string){
  const res=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(13_000)});
  if(!res.ok)throw Error("HTTP "+res.status+" "+new URL(url).host);
  return new TextDecoder("windows-1254").decode(await res.arrayBuffer());
}
async function groupCodes(league:{code:string;page:number}):Promise<Array<{id:string;name:string}>>{
  if(league.code==="T1")return [{id:"",name:"1. Lig"}];
  const html=await textFrom("https://www.tff.org/Default.aspx?pageID="+league.page);
  const matched=new Map<string,string>();
  for(const row of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)){
    const name=row[2].replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
    if(league.code==="T2"&&!/^(?:beyaz|kırmızı)(?:\s+grup)?$/i.test(name))continue;
    if(league.code==="T3"&&!/^(?:0?[1-4]|[1-4]\.\s*grup)$/i.test(name))continue;
    const url=(row[1].match(/href=["']([^"']+)["']/i)||[])[1]||"";
    const group=url.match(/grupID=(\d+)/i)?.[1];
    if(group)matched.set(group,name);
  }
  // Official group selectors occasionally use form options instead of links.
  for(const row of html.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([^<]+)<\/option>/gi)){
    const name=row[2].trim(),value=row[1];
    if(league.code==="T2"&&!/beyaz|kırmızı/i.test(name))continue;
    if(league.code==="T3"&&!/^(?:0?[1-4]|[1-4]\.\s*grup)$/i.test(name))continue;
    const group=value.match(/grupID=(\d+)/i)?.[1] || ( /^\d+$/.test(value)?value:"");
    if(group)matched.set(group,name);
  }
  if(!matched.size)throw Error(league.code+" için resmî TFF grup kimlikleri doğrulanamadı");
  return [...matched].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name));
}

async function bulkGerman(db:SqliteDb,leagueCode:string,list:ImportedMatch[]){
  // The 2026/27 full-season snapshot is importable in DB batches, not
  // hundreds of individual transactions. This avoids serverless timeouts.
  const names=[...new Set(list.flatMap(g=>[g.home_team,g.away_team]))];
  for(let i=0;i<names.length;i+=70){
    await db.batch(names.slice(i,i+70).map(name=>({
      sql:"INSERT OR IGNORE INTO teams(name) VALUES(?)",args:[name],
    })));
  }
  const teams=await db.all("SELECT id,name FROM teams");
  const ids=new Map(teams.map(t=>[String(t.name),Number(t.id)]));
  const sourceTime=new Date().toISOString();
  let saved=0;
  for(let i=0;i<list.length;i+=35){
    const statements=list.slice(i,i+35).flatMap(m=>{
      const h=ids.get(m.home_team),a=ids.get(m.away_team);
      if(!h||!a||h===a)return [];
      return [{
        sql:[
          "INSERT INTO fixtures(external_id,competition_code,kickoff_utc,home_team_id,away_team_id,",
          "status,home_goals,away_goals,stage,source_name,source_url,source_checked_at)",
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          "ON CONFLICT(external_id) DO UPDATE SET",
          "kickoff_utc=CASE WHEN fixtures.status='FINISHED' THEN fixtures.kickoff_utc ELSE excluded.kickoff_utc END,",
          "status=CASE WHEN fixtures.status IN ('FINISHED','CANCELLED','POSTPONED') THEN fixtures.status ELSE excluded.status END,",
          "home_goals=CASE WHEN fixtures.status='FINISHED' THEN fixtures.home_goals ELSE excluded.home_goals END,",
          "away_goals=CASE WHEN fixtures.status='FINISHED' THEN fixtures.away_goals ELSE excluded.away_goals END,",
          "source_url=excluded.source_url,source_checked_at=excluded.source_checked_at",
        ].join(" "),
        args:[m.external_id,m.competition_code,m.kickoff_utc,h,a,m.status,m.home_goals,m.away_goals,
          "2026/27",m.source_name,m.source_url,sourceTime]
      }];
    });
    if(statements.length){await db.batch(statements);saved+=statements.length;}
  }
  return saved;
}
async function saveProgress(db:SqliteDb,job:Job,state:string,imported:number,error?:string){
  await db.run([
    "INSERT INTO season_sync_progress(provider,competition_code,part_key,cursor_index,state,imported,checked_at,error)",
    "VALUES(?,?,?,?,?,?,?,?)",
    "ON CONFLICT(provider,competition_code,part_key) DO UPDATE SET",
    "cursor_index=excluded.cursor_index,state=excluded.state,imported=season_sync_progress.imported+excluded.imported,",
    "checked_at=excluded.checked_at,error=excluded.error"
  ].join(" "),[job.provider,job.code,job.part,job.cursor+1,state,imported,new Date().toISOString(),error||null]);
}
async function plan(db:SqliteDb,onlyLeague?:string):Promise<Job[]>{
  const progress=await db.all("SELECT provider,competition_code,part_key,cursor_index,state,checked_at FROM season_sync_progress");
  const previous=new Map(progress.map(r=>[String(r.provider)+"/"+r.competition_code+"/"+r.part_key,r]));
  const jobs:Job[]=[];
  for(const german of GERMAN){
    jobs.push({provider:"OPENLIGA",code:german.code,part:"2026",cursor:0,max:1});
  }
  const seasonStart=Date.parse("2026-07-01T00:00:00Z");
  const weeks=Math.ceil((Date.parse(SEASON_END)-seasonStart)/(14*DAY));
  for(const league of ESPN){
    jobs.push({provider:"ESPN",code:league.code,part:"2026-27",cursor:0,max:weeks});
  }
  for(const league of TFF_SOURCES){
    const groups=await groupCodes(league).catch(()=>[]);
    if(groups.length===0){
      jobs.push({provider:"TFF",code:league.code,part:"GROUP-DISCOVERY",cursor:0,max:1});
      continue;
    }
    for(const g of groups){
      jobs.push({provider:"TFF",code:league.code,part:g.id||"general",cursor:0,max:league.maxWeek});
    }
  }
  const current=Date.now();
  return jobs.filter(job=>!onlyLeague||onlyLeague==="ALL"||job.code===onlyLeague)
    .map(job=>{
      const row=previous.get(job.provider+"/"+job.code+"/"+job.part);
      const cursor=Number(row?.cursor_index||0);
      // Recheck finished providers periodically to capture revised scores/kickoff times.
      const previousCheck=Date.parse(String(row?.checked_at||""));
      const shouldRefresh=cursor>=job.max && (current-previousCheck>14*DAY);
      const recentFailure=String(row?.state||"")==="FAILED"
        && Number.isFinite(previousCheck) && current-previousCheck<20*60_000;
      return {...job,cursor:shouldRefresh?0:cursor,paused:recentFailure};
    })
    .filter(job=>job.cursor<job.max&&!job.paused)
    .sort((a,b)=>{
      // Fill German full-season feeds first, followed by official lower-division fixtures;
      // retain per-league cursor progress to avoid repeating the same matchday.
      const priority=(j:Job)=>j.provider==="OPENLIGA"?0:j.provider==="TFF"?1:2;
      return priority(a)-priority(b)||a.cursor-b.cursor||a.code.localeCompare(b.code);
    });
}
async function execute(db:SqliteDb,job:Job):Promise<number>{
  if(job.provider==="OPENLIGA"){
    const league=GERMAN.find(l=>l.code===job.code)!;
    const raw=await jsonFrom("https://api.openligadb.de/getmatchdata/"+league.slug+"/2026");
    const matches=parseOpenLigaSeason(raw,job.code);
    if(matches.length===0)throw Error(league.name+" 2026/27 veri kümesi boş");
    return bulkGerman(db,job.code,matches);
  }
  if(job.provider==="ESPN"){
    const league=ESPN.find(l=>l.code===job.code)!;
    const start=Date.parse(SEASON_START)+job.cursor*14*DAY;
    const end=Math.min(start+14*DAY-1,Date.parse(SEASON_END)-1);
    if(start>Date.now()+35*DAY){
      // Officially unpublished future windows remain pending; never mark as fetched.
      throw Error("Daha ileri tarihli maç programı henüz yayımlanmadı.");
    }
    const range=dateCompact(start)+"-"+dateCompact(end);
    const matches=await requestEspn(league.feed,range);
    let saved=0;
    for(const fixture of matches){
      if(Date.parse(fixture.kickoff_utc)<Date.parse(SEASON_START)
         || Date.parse(fixture.kickoff_utc)>=Date.parse(SEASON_END))continue;
      const result=await saveFixture(db,{...fixture,competition_code:job.code});
      if(result==="added"||result==="updated")saved++;
    }
    return saved;
  }
  if(job.part==="GROUP-DISCOVERY"){
    throw Error(job.code+" resmî grup bağlantıları bulunamadı; TFF sayfası incelenmeli");
  }
  const league=TFF_SOURCES.find(l=>l.code===job.code)!;
  const base="https://www.tff.org/Default.aspx?pageID="+league.page;
  const url=base+(job.part==="general"?"":"&grupID="+job.part)+"&hafta="+(job.cursor+1);
  const html=await textFrom(url);
  const list=parseTffRows(html,job.code,url);
  if(!list.length)throw Error(job.code+" "+(job.cursor+1)+". hafta resmî sayfadan çözümlenemedi");
  let saved=0;
  for(const m of list){
    const result=await saveFixture(db,m);
    if(result==="added"||result==="updated")saved++;
  }
  return saved;
}
export async function runSeasonSyncStep(league="ALL",steps=4){
  const db=await getDb();await ensureSeedData(db);
  const maxSteps=Math.max(1,Math.min(6,Math.floor(steps)));
  const available=await plan(db,league);
  const results:Array<{provider:string;league:string;part:string;position:number;saved:number;status:string;error?:string}>=[];
  for(const job of available.slice(0,maxSteps)){
    try{
      const saved=await execute(db,job);
      await saveProgress(db,job,job.cursor+1>=job.max?"COMPLETE":"RUNNING",saved);
      results.push({provider:job.provider,league:job.code,part:job.part,position:job.cursor+1,saved,status:"SUCCESS"});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await db.run([
        "INSERT INTO season_sync_progress(provider,competition_code,part_key,cursor_index,state,imported,checked_at,error)",
        "VALUES(?,?,?,?,'FAILED',0,?,?)",
        "ON CONFLICT(provider,competition_code,part_key) DO UPDATE SET",
        "state='FAILED',checked_at=excluded.checked_at,error=excluded.error",
      ].join(" "),
      [job.provider,job.code,job.part,job.cursor,new Date().toISOString(),message.slice(0,350)]);
      results.push({provider:job.provider,league:job.code,part:job.part,position:job.cursor+1,
        saved:0,status:"FAILED",error:message});
    }
  }
  return {season:"2026-2027",processed:results.length,results,remaining:Math.max(0,available.length-results.length)};
}
export async function seasonCoverage(){
  const db=await getDb();await ensureSeedData(db);
  const rows=await db.all([
    "SELECT c.code,c.name,c.country,",
    "COUNT(f.id) AS fixtures,",
    "SUM(CASE WHEN f.status='FINISHED' THEN 1 ELSE 0 END) AS finished,",
    "SUM(CASE WHEN f.status IN ('TIMED','SCHEDULED','TBC') THEN 1 ELSE 0 END) AS upcoming,",
    "SUM(CASE WHEN ges.is_complete=1 THEN 1 ELSE 0 END) AS goals_verified,",
    "SUM(CASE WHEN ms.fixture_id IS NOT NULL THEN 1 ELSE 0 END) AS detailed_stats,",
    "MAX(f.source_checked_at) AS last_checked",
    "FROM competitions c LEFT JOIN fixtures f ON f.competition_code=c.code",
    "AND f.kickoff_utc>=? AND f.kickoff_utc<?",
    "LEFT JOIN goal_event_sets ges ON ges.fixture_id=f.id",
    "LEFT JOIN match_stats ms ON ms.fixture_id=f.id",
    "GROUP BY c.code ORDER BY c.country,c.name"
  ].join(" "),[SEASON_START,SEASON_END]);
  const progress=await db.all("SELECT provider,competition_code,part_key,cursor_index,state,imported,checked_at,error FROM season_sync_progress ORDER BY provider,competition_code");
  const totals={
    fixtures:rows.reduce((n,r)=>n+Number(r.fixtures||0),0),
    finished:rows.reduce((n,r)=>n+Number(r.finished||0),0),
    upcoming:rows.reduce((n,r)=>n+Number(r.upcoming||0),0),
  };
  return {season:"2026-2027",asOf:new Date().toISOString(),totals,
    leagues:rows.map(r=>({...r,fixtures:Number(r.fixtures||0),finished:Number(r.finished||0),
      upcoming:Number(r.upcoming||0),goals_verified:Number(r.goals_verified||0),
      detailed_stats:Number(r.detailed_stats||0)})),progress};
}
