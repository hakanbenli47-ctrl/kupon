import "server-only";
import { getDb } from "./db";
import { ensureSeedData } from "./seed";
import { canonicalTeam } from "./scoreboard-feed";

const feeds:Record<string,string>={
  PL:"eng.1",LL:"esp.1",TSL:"tur.1",BL:"ger.1",SA:"ita.1",BL2:"ger.2",BL3:"ger.3",
};
type Stats=Record<string,number>;
const statNames:Record<string,string>={
  totalshots:"shots",shots:"shots",shotsongoal:"shots_on_target",
  shotsontarget:"shots_on_target",corners:"corners",cornerkicks:"corners",
  possession:"possession",possessionpct:"possession",ballpossession:"possession",
  fouls:"fouls",totalfouls:"fouls",yellowcards:"yellow_cards",redcards:"red_cards",
  expectedgoals:"xg",xg:"xg",saves:"saves",
};
function valid(value:unknown){
  const cleaned=String(value??"").replace("%","").replace(",",".").trim();
  if(!/^\d+(\.\d+)?$/.test(cleaned))return null;
  const n=Number(cleaned);
  return Number.isFinite(n)&&n>=0&&n<400?n:null;
}
function getStats(root:Record<string,unknown>,home:string,away:string){
  const box=(root.boxscore as Record<string,unknown>|undefined)?.teams;
  if(!Array.isArray(box))return null;
  const bySide:[Stats,Stats]=[{},{}];
  for(const entry of box){
    const r=entry as Record<string,unknown>;
    const team=r.team as Record<string,unknown>|undefined;
    const key=canonicalTeam(team?.displayName||team?.name);
    const side=key===canonicalTeam(home)?0:key===canonicalTeam(away)?1:-1;
    if(side<0||!Array.isArray(r.statistics))continue;
    for(const item of r.statistics as Record<string,unknown>[]){
      const stat=statNames[canonicalTeam(item.name||item.label)];
      const value=valid(item.displayValue??item.value);
      if(stat&&value!==null)bySide[side][stat]=value;
    }
  }
  return bySide;
}
type Goal = {id:string;side:0|1;minute:number;added:number;name:string|null;own:boolean;penalty:boolean};
function getGoals(root:Record<string,unknown>,home:string,away:string,homeGoals:number,awayGoals:number):Goal[]|null{
  const events=Array.isArray(root.keyEvents)?root.keyEvents as Record<string,unknown>[]:[];
  const output:Goal[]=[];
  for(const [i,event] of events.entries()){
    const kind=event.type as Record<string,unknown>|string|undefined;
    const tag=typeof kind==="object"&&kind!==null?
      String(kind.text||kind.name||kind.slug||kind.type||""):String(kind||"");
    const eventText=String(event.text||event.shortText||"");
    const scoring=event.scoringPlay===true||/\bgoal\b/i.test(tag);
    if(!scoring||/disallow|overturn|shootout|no goal/i.test(tag+" "+eventText))continue;
    const team=event.team as Record<string,unknown>|undefined;
    const name=canonicalTeam(team?.displayName||team?.name||event.teamName);
    const side:0|1|-1=name===canonicalTeam(home)?0:name===canonicalTeam(away)?1:-1;
    if(side<0)return null;
    const clock=event.clock as Record<string,unknown>|undefined;
    const timeText=String(clock?.displayValue||event.clock||"");
    const minuteParts=timeText.match(/(\d{1,3})(?:\s*['’]?\s*\+\s*(\d{1,2}))?/);
    if(!minuteParts)return null;
    const minute=Number(minuteParts[1]),added=Number(minuteParts[2]||0);
    if(minute<1||minute>130||added>30)return null;
    const athlete=event.athlete as Record<string,unknown>|undefined;
    output.push({id:String(event.id||"espn-"+i),side,minute,added,
      name:typeof athlete?.displayName==="string"?athlete.displayName:null,
      own:/own.goal/i.test(tag+" "+eventText),penalty:/penalty/i.test(tag)});
  }
  if(output.filter(g=>g.side===0).length!==homeGoals
    ||output.filter(g=>g.side===1).length!==awayGoals)return null;
  return output;
}
export async function enrichEspnMatches(limit=4){
  const db=await getDb();await ensureSeedData(db);
  const target=Math.max(1,Math.min(8,Math.floor(limit)));
  const fixtures=await db.all(
    "SELECT f.id,f.external_id,f.competition_code,f.home_goals,f.away_goals,f.home_team_id,f.away_team_id,ht.name AS home_team,at.name AS away_team,ms.fixture_id AS has_stats,ges.is_complete AS goals_complete FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id LEFT JOIN match_stats ms ON ms.fixture_id=f.id LEFT JOIN goal_event_sets ges ON ges.fixture_id=f.id WHERE f.external_id LIKE 'espn-%' AND f.status='FINISHED' AND (ms.fixture_id IS NULL OR ges.is_complete IS NULL OR ges.is_complete<>1) ORDER BY f.kickoff_utc DESC LIMIT ?",[target]);
  let statsSaved=0,goalSetsSaved=0,checked=0;
  const errors:string[]=[];
  for(const fixture of fixtures){
    const code=String(fixture.competition_code),feed=feeds[code];
    const matchId=String(fixture.external_id).match(/-(\d+)$/)?.[1];
    if(!feed||!matchId)continue;
    try{
      const url="https://site.api.espn.com/apis/site/v2/sports/soccer/"+feed+"/summary?event="+matchId;
      const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(9000)});
      if(!response.ok)throw Error("HTTP "+response.status);
      const raw=await response.json() as Record<string,unknown>;
      checked++;
      const home=String(fixture.home_team),away=String(fixture.away_team);
      const stats=getStats(raw,home,away);
      if(stats && !fixture.has_stats){
        const pairs=Object.entries(statNames).map(x=>x[1]);
        const fields=[...new Set(pairs)].filter(x=>stats[0][x]!==undefined||stats[1][x]!==undefined);
        if(fields.length>0){
          const cols=fields.flatMap(f=>["home_"+f,"away_"+f]);
          const values=fields.flatMap(f=>[stats[0][f]??null,stats[1][f]??null]);
          const assignments=cols.map(f=>f+"=COALESCE(excluded."+f+",match_stats."+f+")").join(",");
          const sql="INSERT INTO match_stats(fixture_id,"+cols.join(",")+",source_url,checked_at) VALUES("+
            Array(cols.length+3).fill("?").join(",")+") ON CONFLICT(fixture_id) DO UPDATE SET "+assignments+
            ",source_url=excluded.source_url,checked_at=excluded.checked_at";
          await db.run(sql,[fixture.id,...values,url,new Date().toISOString()]);
          statsSaved++;
        }
      }
      if(Number(fixture.goals_complete)!==1){
        const goals=getGoals(raw,home,away,Number(fixture.home_goals),Number(fixture.away_goals));
        if(goals){
          const checkedAt=new Date().toISOString();
          await db.run("DELETE FROM goal_events WHERE fixture_id=?",[fixture.id]);
          for(const g of goals){
            await db.run("INSERT OR IGNORE INTO goal_events(fixture_id,source_event_id,scoring_team_id,minute,added_time,period,player_name,event_type,is_own_goal,is_penalty,source_url,checked_at) VALUES(?,?,?,?,?,?,?,'GOAL',?,?,?,?)",
              [fixture.id,"espn-"+g.id,g.side===0?fixture.home_team_id:fixture.away_team_id,
                g.minute,g.added,g.minute<=45?"FIRST_HALF":"SECOND_HALF",g.name,g.own?1:0,g.penalty?1:0,url,checkedAt]);
          }
          await db.run("INSERT INTO goal_event_sets(fixture_id,event_count,is_complete,source_name,source_url,checked_at) VALUES(?,?,1,'ESPN',?,?) ON CONFLICT(fixture_id) DO UPDATE SET event_count=excluded.event_count,is_complete=1,source_name=excluded.source_name,source_url=excluded.source_url,checked_at=excluded.checked_at",
            [fixture.id,goals.length,url,checkedAt]);
          goalSetsSaved++;
        }
      }
    }catch(error){errors.push(code+"/"+matchId+": "+(error instanceof Error?error.message:String(error)));}
  }
  return {checked,statsSaved,goalSetsSaved,errors:errors.slice(0,5)};
}
