import { runSeasonSyncStep } from "@/lib/season-2026";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET;
 if(secret ? request.headers.get("authorization")!=="Bearer "+secret :
    !(request.headers.get("user-agent")||"").includes("vercel-cron/1.0")){
   return Response.json({error:"Yetkisiz"},{status:401});
 }
 try{return Response.json({ok:true,...await runSeasonSyncStep("ALL",5)});}
 catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:"Sync error"},{status:500});}
}
