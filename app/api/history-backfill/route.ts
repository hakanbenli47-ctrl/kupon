import { getDb } from "@/lib/db";
import { runHistoryBackfill } from "@/lib/history-sync";
import { enrichEspnMatches } from "@/lib/espn-enrichment";


export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

// One history batch per user-triggered request. Locked to avoid hammering providers.
export async function POST(request:Request) {
  const payload=await request.json().catch(()=>null) as {league?:string}|null;
  const selectedLeague=typeof payload?.league==="string"
    && /^[A-Z0-9]{2,4}$/.test(payload.league)?payload.league:undefined;
  const db=await getDb();
  const key="history-backfill-"+Math.floor(Date.now()/(4*60_000));
  const lock=await db.run("INSERT OR IGNORE INTO cloud_sync_locks(run_key,started_at,status) VALUES(?,?,'RUNNING')",
    [key,new Date().toISOString()]);
  if(!lock.changes){
    const existing=await db.get("SELECT status,finished_at,notes FROM cloud_sync_locks WHERE run_key=?",[key]);
    return Response.json({ok:true,skipped:true,existing},{headers:{"Cache-Control":"no-store"}});
  }
  try{
    // Import recent history first. Limit requests and wall-clock time per function.
    const started=Date.now();
    const batches:Awaited<ReturnType<typeof runHistoryBackfill>>[]=[];
    for(let attempt=0;attempt<3 && Date.now()-started<27_000;attempt++){
      const next=await runHistoryBackfill(55,selectedLeague);
      batches.push(next);
      if(next.ok===false || ("complete" in next && next.complete))break;
    }
    const history=batches[batches.length-1];
    const detail=Date.now()-started<35_000
      ?await enrichEspnMatches(2):{checked:0,statsSaved:0,goalSetsSaved:0,errors:[]};
    const report={history,batches,detail,analysis:"V4 upcoming predictions refresh from imported data on next request"};
    await db.run("UPDATE cloud_sync_locks SET status='SUCCESS',finished_at=?,notes=? WHERE run_key=?",
      [new Date().toISOString(),JSON.stringify(report).slice(0,3500),key]);
    return Response.json({ok:true,...report},{headers:{"Cache-Control":"no-store"}});
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    await db.run("UPDATE cloud_sync_locks SET status='FAILED',finished_at=?,notes=? WHERE run_key=?",
      [new Date().toISOString(),message,key]);
    return Response.json({ok:false,error:message},{status:500});
  }
}
