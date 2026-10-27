import { runRecentResultSync } from "@/lib/cloud-sync";
import { runHistoryBackfill } from "@/lib/history-sync";
import { enrichEspnMatches } from "@/lib/espn-enrichment";
import { runAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) return request.headers.get("authorization") === `Bearer ${secret}`;
  return request.headers.get("user-agent")?.includes("vercel-cron/1.0")
    && Boolean(request.headers.get("x-vercel-id"));
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({error:"Yetkisiz cron isteği."},{status:401});
  try {
    const results=await runRecentResultSync({maxFixtures:16});
    const history=await runHistoryBackfill(25);
    const detail=await enrichEspnMatches(2);
    const analysis=await runAnalysis(2);
    return Response.json({ok:true,results,history,detail,analysis},{
      headers:{"Cache-Control":"no-store"}
    });
  } catch (error) {
    return Response.json({
      ok:false,error:error instanceof Error?error.message:"Sonuç yenileme başarısız."
    },{status:500});
  }
}
