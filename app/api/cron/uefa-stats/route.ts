import { runUefaStatsBackfill } from "@/lib/cloud-sync";

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
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Yetkisiz istatistik isteği." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const batch = Math.max(1, Math.min(25, Number(params.get("batch") || 20)));
  const analyze = params.get("analyze") === "1";
  try {
    return Response.json(await runUefaStatsBackfill(batch, analyze), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("UEFA istatistik güncellemesi başarısız:", error);
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "UEFA istatistik güncellemesi başarısız.",
    }, { status: 500 });
  }
}
