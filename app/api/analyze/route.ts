import { runAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let days = 15;
  try {
    const body = await request.json();
    days = Math.max(1, Math.min(31, Number(body?.days || 15)));
  } catch {
    // Empty bodies use the default rolling window.
  }
  return Response.json({ ok: true, ...runAnalysis(days) });
}
