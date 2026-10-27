import "server-only";
import { getDb } from "./db";
import { ensureSeedData } from "./seed";
import { forecast, scoreModel, sampleScorelines,
  type HistoricalGame, type ScheduledGame, type ModelProfile, type MarketName } from "./model-v4";
import { kickoffSlot } from "./coupon-optimizer";

type DbRow=Record<string,unknown>;
const str=(v:unknown)=>String(v??"");
const num=(v:unknown)=>Number(v??0);
const nullable=(v:unknown)=>v===null||v===undefined?null:Number(v);
function historyRow(r:DbRow):HistoricalGame{
  return {
    id:num(r.id),competition:str(r.competition_code),kickoff:str(r.kickoff_utc),
    homeId:num(r.home_team_id),awayId:num(r.away_team_id),
    homeGoals:num(r.home_goals),awayGoals:num(r.away_goals),
    homeXg:nullable(r.home_xg),awayXg:nullable(r.away_xg),
    homeShotsOnTarget:nullable(r.home_shots_on_target),
    awayShotsOnTarget:nullable(r.away_shots_on_target),
  };
}
function fixtureRow(r:DbRow):ScheduledGame{
  return {
    id:num(r.id),competition:str(r.competition_code),kickoff:str(r.kickoff_utc),
    homeId:num(r.home_team_id),awayId:num(r.away_team_id),
    homeName:str(r.home_team),awayName:str(r.away_team),
    source:str(r.source_name),sourceCheckedAt:str(r.source_checked_at),
  };
}
export async function loadModelData(days=21){
  const db=await getDb();await ensureSeedData(db);
  const maxDays=Math.max(1,Math.min(31,Math.floor(days)));
  const past=await db.all([
    "SELECT f.id,f.competition_code,f.kickoff_utc,f.home_team_id,f.away_team_id,",
    "f.home_goals,f.away_goals,ms.home_xg,ms.away_xg,",
    "ms.home_shots_on_target,ms.away_shots_on_target",
    "FROM fixtures f LEFT JOIN match_stats ms ON ms.fixture_id=f.id",
    "WHERE f.status='FINISHED' AND f.home_goals IS NOT NULL AND f.away_goals IS NOT NULL",
    "AND f.home_goals BETWEEN 0 AND 30 AND f.away_goals BETWEEN 0 AND 30",
    "AND datetime(f.kickoff_utc) < datetime('now')",
    "AND datetime(f.kickoff_utc) >= datetime('now','-370 days')",
    "ORDER BY f.kickoff_utc DESC LIMIT 6500"
  ].join(" "));
  const future=await db.all([
    "SELECT f.id,f.competition_code,f.kickoff_utc,f.home_team_id,f.away_team_id,",
    "f.source_name,f.source_checked_at,ht.name AS home_team,at.name AS away_team",
    "FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id",
    "WHERE f.status IN ('TIMED','SCHEDULED') AND datetime(f.kickoff_utc)>datetime('now')",
    "AND datetime(f.kickoff_utc)<datetime('now',?)",
    "ORDER BY f.kickoff_utc LIMIT 800"
  ].join(" "),["+"+maxDays+" days"]);
  return {past:past.map(historyRow),future:future.map(fixtureRow)};
}
export type EngineFixture = {
  fixture:ScheduledGame;
  profile:Omit<ModelProfile,"matrix">;
  simulations:null | ReturnType<typeof sampleScorelines>;
  sameTimeSlot:string|null;
};
export async function analyzeUpcoming(days=21,league?:string){
  const {past,future}=await loadModelData(days);
  const chosen=future.filter(f=>!league||league==="ALL"||f.competition===league);
  const forecasts:EngineFixture[]=chosen.map(f=>{
    const profile=forecast(f,past);
    const {matrix,...display}=profile;
    return {
      fixture:f,profile:display,
      simulations:matrix?sampleScorelines(matrix,10000,((f.id*2654435761)>>>0)):null,
      sameTimeSlot:kickoffSlot(f.kickoff),
    };
  });
  const coverage=new Map<string,{played:number;ready:number;waiting:number;xgMatches:number}>();
  for(const g of past){
    const row=coverage.get(g.competition)||{played:0,ready:0,waiting:0,xgMatches:0};
    row.played++;
    if(g.homeXg!==null&&g.awayXg!==null)row.xgMatches++;
    coverage.set(g.competition,row);
  }
  for(const f of forecasts){
    const row=coverage.get(f.fixture.competition)||{played:0,ready:0,waiting:0,xgMatches:0};
    if(f.profile.status==="READY")row.ready++;else row.waiting++;
    coverage.set(f.fixture.competition,row);
  }
  const byTime=new Map<string,Array<{fixtureId:number;market:MarketName;probability:number;conservative:number;quality:number}>>();
  for(const item of forecasts){
    if(item.profile.status!=="READY"||!item.sameTimeSlot||!item.profile.markets)continue;
    if((item.profile.quality??0)<0.59)continue;
    // Fixed candidate family; never choose a huge market menu just to show 99% "accuracy".
    const markets=item.profile.markets.filter(x=>
      ["O1.5","U1.5","O2.5","U2.5","O3.5","U3.5"].includes(x.name)
      && x.conservative>=0.65);
    const pick=markets.sort((a,b)=>b.conservative-a.conservative)[0];
    if(!pick)continue;
    const group=byTime.get(item.sameTimeSlot)||[];
    group.push({fixtureId:item.fixture.id,market:pick.name,
      probability:pick.probability,conservative:pick.conservative,
      quality:item.profile.quality??0});
    byTime.set(item.sameTimeSlot,group);
  }
  const slots=[...byTime.entries()].map(([slot,picks])=>({
    slot,picks:picks.sort((a,b)=>b.conservative-a.conservative),
  })).sort((a,b)=>a.slot.localeCompare(b.slot));
  return {modelVersion:"engine-v4.0",generatedAt:new Date().toISOString(),
    fixtures:forecasts,slots,
    coverage:[...coverage.entries()].map(([competition,stats])=>({competition,...stats}))
      .sort((a,b)=>a.competition.localeCompare(b.competition)),
  };
}
export async function backtestEngine(league?:string){
  const {past}=await loadModelData(1);
  const allowed=past.filter(g=>!league||league==="ALL"||g.competition===league);
  const byLeague=new Map<string,HistoricalGame[]>();
  for(const row of allowed){
    const list=byLeague.get(row.competition)||[];
    list.push(row);
    byLeague.set(row.competition,list);
  }
  const rows=[...byLeague.entries()].map(([competition,games])=>{
    const result=scoreModel(games,120);
    const {rows:predictions,...stats}=result;
    void predictions;
    // No exaggerated accuracy label: n >= 80 before declaring a validation sample.
    return {competition,...stats,validated:stats.count>=80,
      beatsNaiveBaseline:stats.count>=80 && stats.brier<stats.baselineBrier};
  });
  const total=rows.reduce((v,x)=>v+x.count,0);
  const average=(key:"brier"|"baselineBrier"|"logLoss"|"over25Brier"|"winnerAccuracy"|"baselineAccuracy"|"over25Accuracy")=>
    total?rows.reduce((v,x)=>v+x[key]*x.count,0)/total:null;
  return {modelVersion:"engine-v4.0",asOf:new Date().toISOString(),
    total,totalBrier:average("brier"),baselineBrier:average("baselineBrier"),
    totalLogLoss:average("logLoss"),totalOver25Brier:average("over25Brier"),
    winnerAccuracy:average("winnerAccuracy"),baselineAccuracy:average("baselineAccuracy"),
    over25Accuracy:average("over25Accuracy"),
    leagues:rows,
    limitation:"Strict walk-forward matches only. Fixed naive baseline: 44% home, 27% draw, 29% away. Predictive scores do not guarantee future success.",
  };
}
