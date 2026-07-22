"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Prediction = {
  id: number;
  market: number;
  selection: "ALT" | "UST";
  probability: number;
  expected_total: number;
  data_quality: number;
  sample_home: number;
  sample_away: number;
  sample_h2h: number;
  explanation_json: string;
};

type Fixture = {
  id: number;
  kickoff_utc: string;
  status: string;
  competition_code: string;
  competition: string;
  home_team: string;
  away_team: string;
  source_url: string;
  source_checked_at: string;
  predictions: Prediction[];
};

type Coupon = {
  id: number;
  generated_for: string;
  label: string;
  combined_probability: number;
  risk: string;
  selections: Array<{
    position: number;
    market: number;
    selection: "ALT" | "UST";
    probability: number;
    kickoff_utc: string;
    home_team: string;
    away_team: string;
    competition_code: string;
    competition: string;
  }>;
};

type DashboardData = {
  generatedAt: string;
  fixtures: Fixture[];
  coupons: Coupon[];
  metrics: { upcoming: number; analyzed: number; settled: number; hitRate: number | null };
  lastSync: null | { finished_at?: string; status?: string; notes?: string };
};

const leagues = [
  ["ALL", "Tüm ligler"],
  ["CL", "Şampiyonlar Ligi"],
  ["EL", "Avrupa Ligi"],
  ["ECL", "Konferans Ligi"],
  ["PL", "Premier Lig"],
  ["TSL", "Süper Lig"],
  ["LL", "La Liga"],
];

type DateRange = "TODAY" | "TOMORROW" | "NEXT3" | "NEXT7" | "ALL" | "CUSTOM";
type AnalysisFilter = "ALL" | "READY" | "WAITING";

const dateRanges: Array<[DateRange, string]> = [
  ["TODAY", "Bugün"],
  ["TOMORROW", "Yarın"],
  ["NEXT3", "3 gün"],
  ["NEXT7", "7 gün"],
  ["ALL", "Tüm 15 gün"],
];

function dateKey(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function dayDifference(value: string, today: string) {
  const toUtc = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(value) - toUtc(today)) / 86_400_000);
}

function matchesDateRange(value: string, range: DateRange, customDate: string, today: string) {
  if (range === "ALL") return true;
  const difference = dayDifference(dateKey(value), today);
  if (range === "TODAY") return difference === 0;
  if (range === "TOMORROW") return difference === 1;
  if (range === "NEXT3") return difference >= 0 && difference < 3;
  if (range === "NEXT7") return difference >= 0 && difference < 7;
  return dateKey(value) === customDate;
}

function percentage(value: number | null) {
  return value === null ? "—" : `%${Math.round(value * 100)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function marketLabel(prediction: Prediction) {
  return `${prediction.market.toFixed(1)} ${prediction.selection === "UST" ? "Üst" : "Alt"}`;
}

function bestPrediction(fixture: Fixture) {
  return [...fixture.predictions].sort((a, b) => b.probability - a.probability)[0];
}

function details(prediction?: Prediction) {
  if (!prediction) return null;
  try {
    return JSON.parse(prediction.explanation_json) as Record<string, number | null>;
  } catch {
    return null;
  }
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [league, setLeague] = useState("ALL");
  const [dateRange, setDateRange] = useState<DateRange>("TODAY");
  const [customDate, setCustomDate] = useState(dateKey(new Date()));
  const [analysisFilter, setAnalysisFilter] = useState<AnalysisFilter>("ALL");
  const [teamQuery, setTeamQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard?days=15", { cache: "no-store" });
      if (!response.ok) throw new Error("Panel verisi alınamadı.");
      setData(await response.json());
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Beklenmeyen bir hata oluştu.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/dashboard?days=15", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Panel verisi alınamadı.");
        return response.json() as Promise<DashboardData>;
      })
      .then((payload) => {
        if (!active) return;
        setData(payload);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Beklenmeyen bir hata oluştu.");
      });

    return () => { active = false; };
  }, []);

  const analyze = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 15 }),
      });
      if (!response.ok) throw new Error("Analiz tamamlanamadı.");
      await load();
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Analiz tamamlanamadı.");
    } finally {
      setBusy(false);
    }
  };

  const today = dateKey(new Date());
  const fixtureDates = useMemo(
    () => [...new Set((data?.fixtures || []).map((fixture) => dateKey(fixture.kickoff_utc)))].sort(),
    [data],
  );
  const fixtures = useMemo(() => {
    const query = teamQuery.trim().toLocaleLowerCase("tr-TR");
    return (data?.fixtures || []).filter((fixture) => {
      const leagueMatches = league === "ALL" || fixture.competition_code === league;
      const dateMatches = matchesDateRange(fixture.kickoff_utc, dateRange, customDate, today);
      const analysisMatches = analysisFilter === "ALL"
        || (analysisFilter === "READY" && fixture.predictions.length > 0)
        || (analysisFilter === "WAITING" && fixture.predictions.length === 0);
      const teamMatches = !query
        || fixture.home_team.toLocaleLowerCase("tr-TR").includes(query)
        || fixture.away_team.toLocaleLowerCase("tr-TR").includes(query);
      return leagueMatches && dateMatches && analysisMatches && teamMatches;
    });
  }, [analysisFilter, customDate, data, dateRange, league, teamQuery, today]);

  const coupons = useMemo(() => (data?.coupons || []).filter((coupon) => {
    const dateMatches = matchesDateRange(`${coupon.generated_for}T12:00:00+03:00`, dateRange, customDate, today);
    const leagueMatches = league === "ALL" || coupon.selections.some((pick) => pick.competition_code === league);
    return dateMatches && leagueMatches;
  }), [customDate, data, dateRange, league, today]);

  const resetFilters = () => {
    setLeague("ALL");
    setDateRange("TODAY");
    setCustomDate(today);
    setAnalysisFilter("ALL");
    setTeamQuery("");
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <div>
            <strong>Kupon Analiz</strong>
            <span>15 günlük gol tahmin paneli</span>
          </div>
        </div>
        <div className="top-actions">
          <span className="sync-dot" aria-hidden="true" />
          <span className="sync-text">
            {data?.lastSync?.finished_at ? `Son veri: ${formatDate(data.lastSync.finished_at)}` : "İlk veri güncellemesi bekleniyor"}
          </span>
          <button className="primary-button" onClick={analyze} disabled={busy}>
            {busy ? "Hesaplanıyor…" : "Analizi çalıştır"}
          </button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">DÜŞÜK RİSK ODAKLI</p>
          <h1>Golleri veriden oku,<br />kuponu olasılıkla kur.</h1>
          <p className="hero-copy">Son form, ev/deplasman performansı, H2H ve doğrulanmış oyuncu eksiklerini birlikte değerlendirir.</p>
        </div>
        <div className="window-card">
          <span>Analiz penceresi</span>
          <strong>15 gün</strong>
          <small>Her 15 günde bir 21:14’te yenilenir</small>
        </div>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="metrics" aria-label="Özet">
        <article><span>Yaklaşan maç</span><strong>{data?.metrics.upcoming ?? "—"}</strong><small>15 günlük fikstür</small></article>
        <article><span>Analizi hazır</span><strong>{data?.metrics.analyzed ?? "—"}</strong><small>Yeterli geçmiş verili</small></article>
        <article><span>Sonuçlanan tahmin</span><strong>{data?.metrics.settled ?? "—"}</strong><small>Model geri bildirimi</small></article>
        <article><span>İsabet oranı</span><strong>{percentage(data?.metrics.hitRate ?? null)}</strong><small>Tekil seçim başarısı</small></article>
      </section>

      <section className="filter-panel" aria-label="Maç filtreleri">
        <div className="filter-topline">
          <div><p className="eyebrow">FİLTRELE</p><h2>Günün maçlarını seç</h2></div>
          <button className="reset-button" type="button" onClick={resetFilters}>Filtreleri sıfırla</button>
        </div>

        <div className="filter-block">
          <span className="filter-label">Tarih</span>
          <div className="date-filter" role="group" aria-label="Tarih aralığı">
            {dateRanges.map(([code, name]) => (
              <button key={code} type="button" className={dateRange === code ? "active" : ""} onClick={() => setDateRange(code)}>{name}</button>
            ))}
            <label className={dateRange === "CUSTOM" ? "calendar-filter active" : "calendar-filter"}>
              <span>Tek gün</span>
              <input
                type="date"
                value={customDate}
                min={fixtureDates[0]}
                max={fixtureDates.at(-1)}
                onChange={(event) => { setCustomDate(event.target.value); setDateRange("CUSTOM"); }}
                aria-label="Belirli bir gün seç"
              />
            </label>
          </div>
        </div>

        <div className="filter-block">
          <span className="filter-label">Lig</span>
          <nav className="league-filter" aria-label="Lig filtresi">
            {leagues.map(([code, name]) => (
              <button key={code} type="button" className={league === code ? "active" : ""} onClick={() => setLeague(code)}>{name}</button>
            ))}
          </nav>
        </div>

        <div className="filter-fields">
          <label>
            <span>Analiz durumu</span>
            <select value={analysisFilter} onChange={(event) => setAnalysisFilter(event.target.value as AnalysisFilter)}>
              <option value="ALL">Tümü</option>
              <option value="READY">Analizi hazır</option>
              <option value="WAITING">Veri bekliyor</option>
            </select>
          </label>
          <label className="team-search">
            <span>Takım ara</span>
            <input type="search" value={teamQuery} onChange={(event) => setTeamQuery(event.target.value)} placeholder="Örn. Galatasaray" />
          </label>
          <div className="filter-result" aria-live="polite"><strong>{fixtures.length}</strong><span>eşleşen maç</span></div>
        </div>
      </section>

      <section className="content-grid">
        <div className="fixture-section">
          <div className="section-heading">
            <div><p className="eyebrow">FİKSTÜR & OLASILIK</p><h2>Önümüzdeki maçlar</h2></div>
            <span>{fixtures.length} karşılaşma</span>
          </div>

          <div className="fixture-list">
            {!data && <div className="empty-state">Panel hazırlanıyor…</div>}
            {data && fixtures.length === 0 && (
              <div className="empty-state"><strong>Bu filtrelerde maç bulunamadı.</strong><span>Tarih veya lig seçimini değiştirerek tekrar deneyebilirsin.</span></div>
            )}
            {fixtures.map((fixture) => {
              const best = bestPrediction(fixture);
              const detail = details(best);
              return (
                <article className="fixture-row" key={fixture.id}>
                  <div className="fixture-meta">
                    <span className="league-code">{fixture.competition_code}</span>
                    <time>{formatDate(fixture.kickoff_utc)}</time>
                  </div>
                  <div className="teams"><strong>{fixture.home_team}</strong><span>—</span><strong>{fixture.away_team}</strong></div>
                  <div className="markets">
                    {fixture.predictions.length ? fixture.predictions.map((prediction) => (
                      <span key={prediction.id} className={best?.id === prediction.id ? "market best" : "market"}>
                        <b>{marketLabel(prediction)}</b><em>{percentage(prediction.probability)}</em>
                      </span>
                    )) : <span className="waiting">Geçmiş veri bekleniyor</span>}
                  </div>
                  <a className="source-link" href={fixture.source_url} target="_blank" rel="noreferrer">Kaynak</a>
                  {detail && (
                    <details className="analysis-details">
                      <summary>Performans ayrıntıları</summary>
                      <div>
                        <span><b>Son 5 gol</b>{detail.home_last5_for?.toFixed(1) ?? "—"} / {detail.away_last5_for?.toFixed(1) ?? "—"}</span>
                        <span><b>Şut</b>{detail.home_avg_shots?.toFixed(1) ?? "—"} / {detail.away_avg_shots?.toFixed(1) ?? "—"}</span>
                        <span><b>İsabetli şut</b>{detail.home_avg_shots_on_target?.toFixed(1) ?? "—"} / {detail.away_avg_shots_on_target?.toFixed(1) ?? "—"}</span>
                        <span><b>Korner</b>{detail.home_avg_corners?.toFixed(1) ?? "—"} / {detail.away_avg_corners?.toFixed(1) ?? "—"}</span>
                        <span><b>Topa sahip olma</b>{detail.home_avg_possession?.toFixed(0) ?? "—"}% / {detail.away_avg_possession?.toFixed(0) ?? "—"}%</span>
                        <span><b>Beklenen toplam</b>{best.expected_total.toFixed(2)} gol</span>
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        </div>

        <aside className="coupon-section">
          <div className="section-heading"><div><p className="eyebrow">OTOMATİK SEÇİM</p><h2>Günün kuponları</h2></div></div>
          {!coupons.length && (
            <div className="coupon-empty"><span className="coupon-number">0</span><strong>Kupon oluşmadı</strong><p>En az dört maç %72 güven ve veri kalitesi eşiğini geçmelidir.</p></div>
          )}
          {coupons.map((coupon) => (
            <article className="coupon-card" key={coupon.id}>
              <div className="coupon-head"><div><span>{coupon.generated_for}</span><strong>{coupon.label}</strong></div><b>{percentage(coupon.combined_probability)}</b></div>
              <ol>
                {coupon.selections.map((pick) => (
                  <li key={`${coupon.id}-${pick.position}`}><div><strong>{pick.home_team} – {pick.away_team}</strong><span>{pick.market.toFixed(1)} {pick.selection === "UST" ? "Üst" : "Alt"}</span></div><b>{percentage(pick.probability)}</b></li>
                ))}
              </ol>
              <div className="coupon-foot"><span>Birleşik olasılık</span><strong>{percentage(coupon.combined_probability)}</strong></div>
            </article>
          ))}
        </aside>
      </section>

      <footer><span>Olasılık tahmindir, garanti değildir. Sistem riskli seçimleri zorla kupona eklemez.</span><span>Model: goal-poisson-1.1</span></footer>
    </main>
  );
}
