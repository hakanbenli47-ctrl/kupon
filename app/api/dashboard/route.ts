import { getDashboard } from "@/lib/analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Math.max(1, Math.min(31, Number(searchParams.get("days") || 15)));
  return Response.json(await getDashboard(days), {
    headers: { "Cache-Control": "no-store" },
  });
}
