import { getDb } from "@/lib/db";
import { runHistoryBackfill, historyCoverage } from "@/lib/history-sync";
import { enrichEspnMatches } from "@/lib/espn-enrichment";
import { runAnalysis } from "@/lib/analysis";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

// One history batch per user-triggered request. Locked to avoid hammering providers.
export async function POST() {
  const db=await getDb();
  const key="history-backfill-"+Math.floor(Date.now()/(4*60_000));
  const lock=await db.run("INSERT OR IGNORE INTO cloud_sync_locks(run_key,started_at,status) VALUES(?,?,'RUNNING')",
    [key,new Date().toISOString()]);
  if(!lock.changes){
    const existing=await db.get("SELECT status,finished_at,notes FROM cloud_sync_locks WHERE run_key=?",[key]);
    return Response.json({ok:true,skipped:true,existing},{headers:{"Cache-Control":"no-store"}});
  }
  try{
    const history=await runHistoryBackfill(32);
    const detail=await enrichEspnMatches(2);
    const analysis=await runAnalysis(3);
    const report={history,detail,analysis};
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
