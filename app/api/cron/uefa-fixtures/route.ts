import { runUefaFixtureDiscovery } from "@/lib/cloud-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  return (secret && authorization === `Bearer ${secret}`)
    || request.headers.get("user-agent")?.includes("vercel-cron/1.0")
    || request.headers.has("x-vercel-id");
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Yetkisiz UEFA fikstür isteği." }, { status: 401 });
  }
  const url = new URL(request.url);
  const batch = Math.max(1, Math.min(60, Number(url.searchParams.get("batch") || 24)));
  const analyze = url.searchParams.get("analyze") === "1";
  try {
    return Response.json(await runUefaFixtureDiscovery(batch, analyze), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("UEFA fikstür keşfi başarısız:", error);
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "UEFA fikstür keşfi başarısız.",
    }, { status: 500 });
  }
}
