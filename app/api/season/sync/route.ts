import { getDb } from "@/lib/db";
import { runSeasonSyncStep } from "@/lib/season-2026";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function POST(request:Request){
 try{
  const body=await request.json().catch(()=>({})) as {league?:string};
  const league=typeof body.league==="string"?body.league.toUpperCase():"ALL";
  if(!/^(ALL|[A-Z0-9]{2,4})$/.test(league))
   return Response.json({error:"Lig parametresi geçersiz"},{status:400});
  const db=await getDb();
  // Shared database lock prevents overlapping imports from several visitors.
  const key="season-2026-27-"+league+"-"+Math.floor(Date.now()/180_000);
  const lock=await db.run("INSERT OR IGNORE INTO cloud_sync_locks(run_key,started_at,status) VALUES(?,?,'RUNNING')",[key,new Date().toISOString()]);
  if(!lock.changes){
   return Response.json({ok:true,skipped:true,reason:"Son 3 dakikada bir eşzamanlama kontrolü başlatıldı."});
  }
  try{
   const report=await runSeasonSyncStep(league,3);
   await db.run("UPDATE cloud_sync_locks SET status='SUCCESS',finished_at=?,notes=? WHERE run_key=?",
     [new Date().toISOString(),JSON.stringify(report).slice(0,3500),key]);
   return Response.json({ok:true,...report},{headers:{"Cache-Control":"no-store"}});
  }catch(e){
   const message=e instanceof Error?e.message:String(e);
   await db.run("UPDATE cloud_sync_locks SET status='FAILED',finished_at=?,notes=? WHERE run_key=?",
     [new Date().toISOString(),message,key]);
   return Response.json({ok:false,error:message},{status:500});
  }
 }catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:"Sezon eşzamanlaması başarısız"},{status:500});}
}
