import { timingSafeEqual } from "node:crypto";

import { runAnalysis } from "@/lib/analysis";
import { withTransaction } from "@/lib/db";

export const runtime = "nodejs";

type ManualResult = {
  fixtureId?: unknown;
  homeGoals?: unknown;
  awayGoals?: unknown;
};

function authorized(request: Request) {
  const expected = process.env.MANUAL_ENTRY_TOKEN;
  const received = request.headers.get("x-admin-token") || "";
  if (!expected || !received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function score(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 30 ? Number(value) : null;
}

export async function POST(request: Request) {
  if (!process.env.MANUAL_ENTRY_TOKEN) {
    return Response.json({ error: "Manuel giriş anahtarı yapılandırılmamış." }, { status: 503 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Yönetici anahtarı yanlış." }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as {
    couponId?: unknown;
    status?: unknown;
    results?: ManualResult[];
  } | null;
  const couponId = Number(body?.couponId);
  const status = body?.status === "WON" || body?.status === "LOST" ? body.status : null;
  const results = Array.isArray(body?.results) ? body.results : [];
  if (!Number.isInteger(couponId) || couponId <= 0 || !status || results.length === 0) {
    return Response.json({ error: "Kupon, durum ve skorlar eksiksiz girilmeli." }, { status: 400 });
  }

  try {
    await withTransaction(async (db) => {
      const allowedRows = await db.all(`
        SELECT DISTINCT f.id
        FROM coupon_selections cs
        JOIN predictions p ON p.id = cs.prediction_id
        JOIN fixtures f ON f.id = p.fixture_id
        WHERE cs.coupon_id = ?
      `, [couponId]);
      const allowed = new Set(allowedRows.map((row) => Number(row.id)));
      if (!allowed.size || results.length !== allowed.size) throw new Error("Kupon bulunamadı veya tüm maç skorları girilmedi.");

      for (const item of results) {
        const fixtureId = Number(item.fixtureId);
        const homeGoals = score(item.homeGoals);
        const awayGoals = score(item.awayGoals);
        if (!allowed.has(fixtureId) || homeGoals === null || awayGoals === null) {
          throw new Error("Skor alanlarından biri geçersiz.");
        }
        await db.run(`
          INSERT INTO manual_fixture_results(fixture_id, home_goals, away_goals)
          VALUES (?, ?, ?)
          ON CONFLICT(fixture_id) DO UPDATE SET
            home_goals=excluded.home_goals,
            away_goals=excluded.away_goals,
            updated_at=CURRENT_TIMESTAMP
        `, [fixtureId, homeGoals, awayGoals]);
        await db.run(`
          UPDATE fixtures
          SET status='FINISHED', home_goals=?, away_goals=?, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `, [homeGoals, awayGoals, fixtureId]);
      }

      await db.run(`
        INSERT INTO manual_coupon_reviews(coupon_id, status)
        VALUES (?, ?)
        ON CONFLICT(coupon_id) DO UPDATE SET status=excluded.status, updated_at=CURRENT_TIMESTAMP
      `, [couponId, status]);
    });
    await runAnalysis(31);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Manuel sonuç kaydedilemedi." },
      { status: 400 },
    );
  }
}
