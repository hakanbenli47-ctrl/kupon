import { getDb } from "@/lib/db";
import { importLeagueFixtures } from "@/lib/league-fixtures";
import { runAnalysis } from "@/lib/analysis";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

export async function POST() {
  const db=await getDb();
  const key=`fixtures-refresh-v3-${Math.floor(Date.now()/3600000)}`;
  const lock=await db.run(
    "INSERT OR IGNORE INTO cloud_sync_locks(run_key,started_at,status) VALUES (?,?, 'RUNNING')",
    [key,new Date().toISOString()]
  );
  if(!lock.changes){
    const record=await db.get("SELECT status,finished_at,notes FROM cloud_sync_locks WHERE run_key=?",[key]);
    if(record?.status === "FAILED"){
      const retry=await db.run(`UPDATE cloud_sync_locks
        SET status='RUNNING',started_at=?,finished_at=NULL,notes=NULL WHERE run_key=? AND status='FAILED'`,
        [new Date().toISOString(),key]);
      if(!retry.changes)return Response.json({ok:true,skipped:true,record});
    }else if(record?.status === "RUNNING"){
      const retry=await db.run(`UPDATE cloud_sync_locks
        SET status='RUNNING',started_at=?,finished_at=NULL,notes=NULL
        WHERE run_key=? AND status='RUNNING' AND datetime(started_at)<datetime('now','-10 minutes')`,
        [new Date().toISOString(),key]);
      if(!retry.changes)return Response.json({ok:true,skipped:true,record});
    }else{
      return Response.json({ok:true,skipped:true,record});
    }
  }
  try{
    const update=await importLeagueFixtures(24);
    const sourcesChecked=update.sources.filter(source=>source.fetched>0);
    if(sourcesChecked.length===0) {
      const details=update.sources.map(source=>
        source.error ? `${source.league}: ${source.error}` : `${source.league}: veri bulunamadı`
      ).slice(0,8).join(" · ");
      throw new Error(`Fikstür sağlayıcılarından maç alınamadı. ${details}`);
    }
    const analysis=await runAnalysis(3);
    await db.run("UPDATE cloud_sync_locks SET finished_at=?,status='SUCCESS',notes=? WHERE run_key=?",
      [new Date().toISOString(),JSON.stringify({update,analysis}).slice(0,3500),key]);
    return Response.json({ok:true,update,analysis},{
      headers:{"Cache-Control":"no-store"}
    });
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    await db.run("UPDATE cloud_sync_locks SET finished_at=?,status='FAILED',notes=? WHERE run_key=?",
      [new Date().toISOString(),message,key]);
    return Response.json({ok:false,error:message},{status:500});
  }
}
