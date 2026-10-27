import { getDb } from "@/lib/db";
import { ensureSeedData } from "@/lib/seed";
import { seasonCoverage } from "@/lib/season-2026";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

export async function GET(request:Request){
 try{
  const qp=new URL(request.url).searchParams;
  const league=String(qp.get("league")||"ALL").toUpperCase();
  const mode=String(qp.get("mode")||"upcoming");
  const search=String(qp.get("search")||"").trim().slice(0,70);
  const page=Math.max(1,Math.min(500,Number(qp.get("page")||1)||1));
  const limit=40;
  if(!/^(ALL|[A-Z0-9]{2,4})$/.test(league)||!["upcoming","played","all"].includes(mode))
   return Response.json({error:"Filtreler geçersiz"},{status:400});
  const db=await getDb();await ensureSeedData(db);
  const clauses=["f.kickoff_utc >= ?","f.kickoff_utc < ?"];
  const args:(string|number)[]=["2026-07-01T00:00:00Z","2027-07-01T00:00:00Z"];
  if(league!=="ALL"){clauses.push("f.competition_code=?");args.push(league);}
  if(mode==="played"){clauses.push("f.status='FINISHED' AND f.home_goals IS NOT NULL AND f.away_goals IS NOT NULL");}
  else if(mode==="upcoming"){clauses.push("f.status IN ('SCHEDULED','TIMED','TBC')");}
  if(search){
   clauses.push("(ht.name LIKE ? OR at.name LIKE ?)");
   const escaped=search.replace(/[%_\\]/g,"\\$&");
   args.push("%"+escaped+"%","%"+escaped+"%");
  }
  const where="WHERE "+clauses.join(" AND ");
  const joins="FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id LEFT JOIN competitions c ON c.code=f.competition_code LEFT JOIN goal_event_sets gs ON gs.fixture_id=f.id LEFT JOIN match_stats ms ON ms.fixture_id=f.id";
  const count=await db.get("SELECT COUNT(*) AS total "+joins+" "+where,args);
  const sort=mode==="upcoming"?"ASC":"DESC";
  const rows=await db.all([
   "SELECT f.id,f.external_id,f.competition_code,COALESCE(c.name,f.competition_code) AS competition,",
   "f.kickoff_utc,f.status,f.home_goals,f.away_goals,f.stage,f.source_name,f.source_url,",
   "f.source_checked_at,ht.name AS home_team,at.name AS away_team,",
   "f.home_team_id,f.away_team_id,",
   "COALESCE(gs.is_complete,0) AS goal_timeline_verified,",
   "CASE WHEN ms.fixture_id IS NULL THEN 0 ELSE 1 END AS has_detailed_stats",
   joins,where,"ORDER BY f.kickoff_utc "+sort+",f.id "+sort+" LIMIT ? OFFSET ?"
  ].join(" "),[...args,limit,(page-1)*limit]);
  return Response.json({season:"2026-2027",mode,league,page,limit,total:Number(count?.total||0),
    pages:Math.ceil(Number(count?.total||0)/limit),fixtures:rows,
    generatedAt:new Date().toISOString()},{
    headers:{"Cache-Control":"no-store"}
  });
 }catch(e){
  return Response.json({error:e instanceof Error?e.message:"Sezon veritabanı okunamadı"},{status:500});
 }
}
