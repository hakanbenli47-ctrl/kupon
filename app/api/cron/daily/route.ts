import { runDailyCloudSync } from "@/lib/cloud-sync";

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
    return Response.json({ ok: false, error: "Yetkisiz cron isteği." }, { status: 401 });
  }
  try {
    return Response.json(await runDailyCloudSync(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Günlük güncelleme başarısız.",
    }, { status: 500 });
  }
}
