import "server-only";
import { getDb, type SqliteDb } from "./db";
import { ensureSeedData } from "./seed";
import { LEAGUE_SOURCES, TFF_SOURCES, requestEspn, saveFixture, parseTffRows, type ImportedMatch } from "./league-fixtures";

type Goal = { side:"home"|"away"; minute:number; player:string|null; ownGoal:boolean; penalty:boolean; id:string };
type Job = {provider:"ESPN"|"OPENLIGA"|"TFF";league:string;season:string;source:string};
const jobs:Job[] = [
  ...LEAGUE_SOURCES.filter(x=>!["BL","BL2","BL3"].includes(x.code))
    .map(x=>({provider:"ESPN" as const,league:x.code,season:"2026",source:x.feed})),
  ...[{league:"BL",source:"bl1"},{league:"BL2",source:"bl2"},{league:"BL3",source:"bl3"}]
    .map(x=>({provider:"OPENLIGA" as const,league:x.league,season:"2026",source:x.source})),
  ...TFF_SOURCES.map(x=>({provider:"TFF" as const,league:x.code,season:"2026",source:String(x.page)})),
];

function validScore(v:unknown):number|null {
  if(v===null||v===undefined||v==="")return null;
  const n=Number(v);
  return Number.isInteger(n)&&n>=0&&n<=30?n:null;
}
function openLigaMatches(raw:unknown,league:string):Array<{fixture:ImportedMatch;goals:Goal[]}> {
  if(!Array.isArray(raw))return [];
  const output:Array<{fixture:ImportedMatch;goals:Goal[]}>=[];
  for(const item of raw){
    const m=item as Record<string,unknown>;
    if(!m||typeof m!=="object"||m.matchIsFinished!==true)continue;
    const ft=(Array.isArray(m.matchResults)?m.matchResults as Record<string,unknown>[]:[])
      .find(x=>Number(x.resultTypeID)===2||String(x.resultName||"").toLowerCase()==="endergebnis");
    const homeScore=validScore(ft?.pointsTeam1),awayScore=validScore(ft?.pointsTeam2);
    const home=String((m.team1 as Record<string,unknown>|undefined)?.teamName||"");
    const away=String((m.team2 as Record<string,unknown>|undefined)?.teamName||"");
    const date=Date.parse(String(m.matchDateTimeUTC||""));
    const matchId=Number(m.matchID);
    if(homeScore===null||awayScore===null||!home||!away||!Number.isFinite(date)
      ||!Number.isInteger(matchId)||matchId<=0||date>Date.now())continue;
    let previousHome=0,previousAway=0,complete=true;
    const goals:Goal[]=[];
    const rawGoals=Array.isArray(m.goals)?m.goals as Record<string,unknown>[]:[];
    for(const [n,g] of rawGoals.entries()){
      const h=validScore(g.scoreTeam1),a=validScore(g.scoreTeam2),minute=Number(g.matchMinute);
      if(h===null||a===null||!Number.isInteger(minute)||minute<1||minute>130){complete=false;break;}
      const deltaHome=h-previousHome,deltaAway=a-previousAway;
      if(!((deltaHome===1&&deltaAway===0)||(deltaHome===0&&deltaAway===1))){complete=false;break;}
      goals.push({side:deltaHome===1?"home":"away",minute,id:String(g.goalID||matchId+"-"+n),
        player:typeof g.goalGetterName==="string"?g.goalGetterName:null,
        ownGoal:g.isOwnGoal===true,penalty:g.isPenalty===true});
      previousHome=h;previousAway=a;
    }
    const countValid=complete&&previousHome===homeScore&&previousAway===awayScore
      &&goals.length===homeScore+awayScore;
    output.push({fixture:{
      external_id:"openliga-"+league+"-"+matchId,competition_code:league,
      kickoff_utc:new Date(date).toISOString(),home_team:home,away_team:away,
      status:"FINISHED",home_goals:homeScore,away_goals:awayScore,
      source_name:"OpenLigaDB",source_url:"https://api.openligadb.de/getmatchdata/"+matchId,
    },goals:countValid?goals:[]});
  }
  return output;
}
async function storeGoals(db:SqliteDb,f:ImportedMatch,goals:Goal[]):Promise<boolean> {
  const total=Number(f.home_goals||0)+Number(f.away_goals||0);
  if(goals.length!==total)return false;
  if(goals.filter(g=>g.side==="home").length!==f.home_goals
    ||goals.filter(g=>g.side==="away").length!==f.away_goals)return false;
  const match=await db.get("SELECT f.id, f.home_goals, f.away_goals, f.home_team_id, f.away_team_id FROM fixtures f WHERE f.external_id=?",[f.external_id]);
  if(!match||Number(match.home_goals)!==f.home_goals||Number(match.away_goals)!==f.away_goals)return false;
  const id=Number(match.id);
  const existing=await db.get("SELECT is_complete FROM goal_event_sets WHERE fixture_id=?",[id]);
  if(Number(existing?.is_complete)===1)return true;
  const manual=await db.get("SELECT fixture_id FROM manual_fixture_results WHERE fixture_id=?",[id]);
  if(manual)return false;
  const checked=new Date().toISOString();
  await db.run("DELETE FROM goal_events WHERE fixture_id=?",[id]);
  for(const g of goals){
    await db.run("INSERT OR IGNORE INTO goal_events(fixture_id,source_event_id,scoring_team_id,minute,added_time,period,player_name,event_type,is_own_goal,is_penalty,source_url,checked_at) VALUES(?,?,?,?,0,NULL,?,'GOAL',?,?,?,?)",
      [id,"openliga-"+g.id,g.side==="home"?Number(match.home_team_id):Number(match.away_team_id),
        g.minute,g.player,g.ownGoal?1:0,g.penalty?1:0,f.source_url,checked]);
  }
  await db.run("INSERT INTO goal_event_sets(fixture_id,event_count,is_complete,source_name,source_url,checked_at) VALUES(?,?,1,?,?,?) ON CONFLICT(fixture_id) DO UPDATE SET event_count=excluded.event_count,is_complete=1,source_name=excluded.source_name,source_url=excluded.source_url,checked_at=excluded.checked_at",
    [id,goals.length,"OpenLigaDB",f.source_url,checked]);
  return true;
}
async function snapshotJSON(url:string):Promise<unknown>{
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(15000),headers:{Accept:"application/json"}});
  if(!response.ok)throw Error("Source HTTP "+response.status);
  return response.json();
}
async function snapshotText(url:string){
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(14000)});
  if(!response.ok)throw Error("TFF HTTP "+response.status);
  return new TextDecoder("windows-1254").decode(await response.arrayBuffer());
}
async function importBatch(job:Job,index:number,limit:number,db:SqliteDb){
  let fixtures:Array<{fixture:ImportedMatch;goals:Goal[]}>=[];
  let more=true;
  if(job.provider==="OPENLIGA"){
    const raw=await snapshotJSON("https://api.openligadb.de/getmatchdata/"+job.source+"/"+job.season);
    const sorted=openLigaMatches(raw,job.league).sort((a,b)=>b.fixture.kickoff_utc.localeCompare(a.fixture.kickoff_utc));
    fixtures=sorted.slice(index*limit,(index+1)*limit);
    more=(index+1)*limit<sorted.length;
  } else if(job.provider==="ESPN"){
    const start=Date.parse("2026-08-01T00:00:00Z")+index*14*86_400_000;
    const end=Math.min(start+14*86_400_000-1,Date.now());
    if(start>=Date.now())return {more:false,stored:0,goalsSaved:0,scanned:0};
    const since=new Date(start).toISOString().slice(0,10).replace(/-/g,"");
    const until=new Date(end).toISOString().slice(0,10).replace(/-/g,"");
    const list=await requestEspn(job.source,since+"-"+until);
    const finished=list.filter(f=>f.status==="FINISHED"&&f.home_goals!==null&&f.away_goals!==null);
    if(finished.length>limit)throw Error("Too many historic fixtures in time window; reduce interval size");
    fixtures=finished.map(f=>({fixture:{...f,competition_code:job.league},goals:[]}));
    more=start+14*86_400_000<Date.now();
  } else {
    const src=TFF_SOURCES.find(x=>x.code===job.league);
    if(!src)return {more:false,stored:0,goalsSaved:0,scanned:0};
    const week=index+1;
    if(week>src.maxWeek)return {more:false,stored:0,goalsSaved:0,scanned:0};
    const url="https://www.tff.org/Default.aspx?pageID="+src.page+"&hafta="+week;
    const raw=await snapshotText(url);
    const found=parseTffRows(raw,job.league,url).filter(f=>f.status==="FINISHED");
    if(found.length>limit)throw Error("TFF weekly results exceed batch capacity");
    fixtures=found.map(f=>({fixture:f,goals:[]}));
    more=week<src.maxWeek;
  }
  let stored=0,goalsSaved=0;
  for(const item of fixtures){
    const saved=await saveFixture(db,item.fixture);
    if(saved==="added"||saved==="updated")stored++;
    if(item.fixture.source_name==="OpenLigaDB"&&await storeGoals(db,item.fixture,item.goals))goalsSaved++;
  }
  return {more,stored,goalsSaved,scanned:fixtures.length};
}
export async function runHistoryBackfill(limit=55){
  const db=await getDb();await ensureSeedData(db);
  const cap=Math.max(15,Math.min(100,Math.floor(limit)));
  const entries=await db.all("SELECT provider,competition_code,season,cursor_index,last_status,last_checked_at FROM history_backfill_cursors");
  const key=(j:Job)=>j.provider+"/"+j.league+"/"+j.season;
  const lookup=new Map(entries.map(x=>[String(x.provider)+"/"+x.competition_code+"/"+x.season,x]));
  const pending=jobs.filter(j=>{
    const progress=lookup.get(key(j));
    if(progress?.last_status==="COMPLETE")return false;
    if(progress?.last_status==="FAILED"&&progress.last_checked_at
      &&Date.now()-Date.parse(String(progress.last_checked_at))<20*60_000)return false;
    return true;
  })
    .sort((a,b)=>Number(lookup.get(key(a))?.cursor_index||0)-Number(lookup.get(key(b))?.cursor_index||0)
      || a.league.localeCompare(b.league));
  const job=pending[0];
  if(!job)return {ok:true,complete:true,remaining:0};
  const index=Number(lookup.get(key(job))?.cursor_index||0);
  try{
    const result=await importBatch(job,index,cap,db);
    await db.run("INSERT INTO history_backfill_cursors(provider,competition_code,season,cursor_index,last_checked_at,last_status,matches_processed,goal_sets_processed) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider,competition_code,season) DO UPDATE SET cursor_index=excluded.cursor_index,last_checked_at=excluded.last_checked_at,last_status=excluded.last_status,matches_processed=history_backfill_cursors.matches_processed+excluded.matches_processed,goal_sets_processed=history_backfill_cursors.goal_sets_processed+excluded.goal_sets_processed,last_error=NULL",
      [job.provider,job.league,job.season,index+1,new Date().toISOString(),result.more?"RUNNING":"COMPLETE",result.stored,result.goalsSaved]);
    return {ok:true,league:job.league,provider:job.provider,step:index+1,remaining:pending.length-(result.more?0:1),...result};
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    await db.run("INSERT INTO history_backfill_cursors(provider,competition_code,season,cursor_index,last_checked_at,last_status,last_error) VALUES(?,?,?,?,?,'FAILED',?) ON CONFLICT(provider,competition_code,season) DO UPDATE SET last_checked_at=excluded.last_checked_at,last_status='FAILED',last_error=excluded.last_error",
      [job.provider,job.league,job.season,index,new Date().toISOString(),message.slice(0,600)]);
    return {ok:false,league:job.league,provider:job.provider,error:message};
  }
}
export async function historyCoverage(){
  const db=await getDb();await ensureSeedData(db);
  const progress=await db.all("SELECT provider,competition_code,season,cursor_index,last_status,matches_processed,goal_sets_processed,last_checked_at,last_error FROM history_backfill_cursors ORDER BY competition_code");
  const coverage=await db.all("SELECT competition_code,COUNT(*) AS played, SUM(CASE WHEN ges.is_complete=1 THEN 1 ELSE 0 END) AS complete_goals, SUM(CASE WHEN ms.fixture_id IS NOT NULL THEN 1 ELSE 0 END) AS detailed_stats FROM fixtures f LEFT JOIN goal_event_sets ges ON ges.fixture_id=f.id LEFT JOIN match_stats ms ON ms.fixture_id=f.id WHERE f.status='FINISHED' AND f.home_goals IS NOT NULL AND f.away_goals IS NOT NULL GROUP BY competition_code");
  return {progress,coverage};
}
