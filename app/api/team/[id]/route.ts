import { getDb } from "@/lib/db";
import { ensureSeedData } from "@/lib/seed";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  const {id:rawId}=await context.params;
  const teamId=Number(rawId);
  if(!Number.isInteger(teamId)||teamId<1) return Response.json({error:"Takım numarası geçersiz."},{status:400});
  const db=await getDb();await ensureSeedData(db);
  const team=await db.get("SELECT id,name,country FROM teams WHERE id=?",[teamId]);
  if(!team)return Response.json({error:"Takım bulunamadı."},{status:404});
  const matches=await db.all(
    "SELECT f.id,f.kickoff_utc,f.home_team_id,f.away_team_id,f.home_goals,f.away_goals,f.source_name,f.source_url, c.name AS competition, ht.name AS home_team,at.name AS away_team,ms.home_shots,ms.away_shots,ms.home_shots_on_target,ms.away_shots_on_target,ms.home_corners,ms.away_corners,ms.home_xg,ms.away_xg,ms.home_possession,ms.away_possession,ges.is_complete AS goal_minutes_complete FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id JOIN competitions c ON c.code=f.competition_code LEFT JOIN match_stats ms ON ms.fixture_id=f.id LEFT JOIN goal_event_sets ges ON ges.fixture_id=f.id WHERE f.status='FINISHED' AND f.home_goals IS NOT NULL AND f.away_goals IS NOT NULL AND (f.home_team_id=? OR f.away_team_id=?) ORDER BY f.kickoff_utc DESC LIMIT 200",
    [teamId,teamId]);
  const ids=matches.map(x=>Number(x.id));
  const goals=ids.length?await db.all(
    "SELECT fixture_id,scoring_team_id,minute,added_time,player_name,is_own_goal,is_penalty FROM goal_events WHERE fixture_id IN ("+ids.map(() => "?").join(",")+") ORDER BY minute,added_time",
    ids):[];
  const byFixture=new Map<number,Record<string,unknown>[]>();
  for(const goal of goals){
    const key=Number(goal.fixture_id);
    byFixture.set(key,[...(byFixture.get(key)||[]),goal]);
  }
  let gf=0,ga=0,w=0,d=0,l=0,goalsComplete=0,statsComplete=0;
  const history=matches.map(m=>{
    const isHome=Number(m.home_team_id)===teamId;
    const scored=Number(isHome?m.home_goals:m.away_goals);
    const conceded=Number(isHome?m.away_goals:m.home_goals);
    gf+=scored;ga+=conceded;
    if(scored>conceded)w++;else if(scored<conceded)l++;else d++;
    if(Number(m.goal_minutes_complete)===1)goalsComplete++;
    if(m.home_shots!==null||m.away_shots!==null||m.home_xg!==null||m.away_xg!==null)statsComplete++;
    return {...m,scored,conceded,venue:isHome?"İç saha":"Deplasman",
      goals:Number(m.goal_minutes_complete)===1?byFixture.get(Number(m.id))||[]:null};
  });
  return Response.json({team,summary:{
    played:matches.length,wins:w,draws:d,losses:l,goalsFor:gf,goalsAgainst:ga,
    verifiedGoalMinuteMatches:goalsComplete,statMatches:statsComplete,
  },matches:history},{headers:{"Cache-Control":"no-store"}});
}
