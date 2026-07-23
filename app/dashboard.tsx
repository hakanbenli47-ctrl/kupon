"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Prediction = {
  id: number;
  market: number;
  selection: "ALT" | "UST";
  probability: number;
  expected_total: number;
  data_quality: number;
  stats_coverage: number;
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
  status: "ACTIVE" | "PENDING" | "WON" | "LOST";
  manually_reviewed: boolean;
  selections: Array<{
    position: number;
    fixture_id: number;
    market: number;
    selection: "ALT" | "UST";
    probability: number;
    kickoff_utc: string;
    home_team: string;
    away_team: string;
    competition_code: string;
    competition: string;
    outcome: "WON" | "LOST" | "VOID" | null;
    fixture_status: string;
    home_goals: number | null;
    away_goals: number | null;
  }>;
};

type DashboardData = {
  generatedAt: string;
  fixtures: Fixture[];
  coupons: Coupon[];
  metrics: {
    upcoming: number;
    analyzed: number;
    settled: number;
    hitRate: number | null;
    historicalMatches: number;
    detailedStatsMatches: number;
    goalTimingMatches: number;
    teams: number;
    teamsReady: number;
  };
  sources: Array<{ name: string; matches: number; results: number; lastCheckedAt: string | null }>;
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
type CouponTab = "READY" | "SELECTED" | "HISTORY";

const dateRanges: Array<[DateRange, string]> = [
  ["TODAY", "Bugün"],
  ["TOMORROW", "Yarın"],
  ["NEXT3", "3 gün"],
  ["NEXT7", "7 gün"],
  ["ALL", "Tüm 31 gün"],
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

function formatFixtureDate(value: string, status: string) {
  if (status !== "TBC") return formatDate(value);
  const date = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
  }).format(new Date(value));
  return `${date} · Saat bekleniyor`;
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

function couponStatusLabel(status: Coupon["status"]) {
  if (status === "WON") return "Tuttu";
  if (status === "LOST") return "Tutmadı";
  if (status === "PENDING") return "Sonuç bekliyor";
  return "Hazır";
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
  const [couponTab, setCouponTab] = useState<CouponTab>("READY");
  const [selectedCouponIds, setSelectedCouponIds] = useState<number[]>([]);
  const [couponRobotOpen, setCouponRobotOpen] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [scoreDrafts, setScoreDrafts] = useState<Record<number, { home: string; away: string }>>({});
  const [savingCouponId, setSavingCouponId] = useState<number | null>(null);
  const [manualMessage, setManualMessage] = useState("");

  useEffect(() => {
    let storedIds: number[] = [];
    try {
      const stored = JSON.parse(localStorage.getItem("selectedCouponIds") || "[]");
      if (Array.isArray(stored)) storedIds = stored.filter((id) => Number.isInteger(id));
    } catch {
      localStorage.removeItem("selectedCouponIds");
    }
    const storedToken = localStorage.getItem("manualEntryToken") || "";
    const timer = window.setTimeout(() => {
      setSelectedCouponIds(storedIds);
      setManualToken(storedToken);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard?days=31", { cache: "no-store" });
      if (!response.ok) throw new Error("Panel verisi alınamadı.");
      setData(await response.json());
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Beklenmeyen bir hata oluştu.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/dashboard?days=31", { cache: "no-store" })
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
        body: JSON.stringify({ days: 31 }),
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
    const selected = selectedCouponIds.includes(coupon.id);
    if (couponTab === "SELECTED") return selected;
    if (couponTab === "HISTORY") return coupon.status !== "ACTIVE";
    return coupon.status === "ACTIVE" && coupon.generated_for === today;
  }), [couponTab, data, selectedCouponIds, today]);

  const updateScore = (fixtureId: number, side: "home" | "away", value: string) => {
    if (value !== "" && !/^\d{1,2}$/.test(value)) return;
    setScoreDrafts((current) => {
      const previous = current[fixtureId] || { home: "", away: "" };
      return { ...current, [fixtureId]: { ...previous, [side]: value } };
    });
  };

  const saveManualResult = async (coupon: Coupon, status: "WON" | "LOST") => {
    setSavingCouponId(coupon.id);
    setManualMessage("");
    localStorage.setItem("manualEntryToken", manualToken);
    try {
      const results = coupon.selections.map((pick) => {
        const homeValue = scoreDrafts[pick.fixture_id]?.home
          ?? (pick.home_goals === null ? "" : String(pick.home_goals));
        const awayValue = scoreDrafts[pick.fixture_id]?.away
          ?? (pick.away_goals === null ? "" : String(pick.away_goals));
        return {
          fixtureId: pick.fixture_id,
          homeGoals: homeValue === "" ? null : Number(homeValue),
          awayGoals: awayValue === "" ? null : Number(awayValue),
        };
      });
      const response = await fetch("/api/manual-result", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": manualToken },
        body: JSON.stringify({ couponId: coupon.id, status, results }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Sonuç kaydedilemedi.");
      setManualMessage("Skorlar ve kupon sonucu kalıcı veri havuzuna kaydedildi.");
      await load();
    } catch (saveError) {
      setManualMessage(saveError instanceof Error ? saveError.message : "Sonuç kaydedilemedi.");
    } finally {
      setSavingCouponId(null);
    }
  };

  const toggleCoupon = (couponId: number) => {
    setSelectedCouponIds((current) => {
      const next = current.includes(couponId)
        ? current.filter((id) => id !== couponId)
        : [...current, couponId];
      localStorage.setItem("selectedCouponIds", JSON.stringify(next));
      return next;
    });
  };

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
            <span>31 günlük gol tahmin paneli</span>
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
          <p className="hero-copy">Son form, ev/deplasman performansı, şut kalitesi, H2H, oyuncu eksikleri ve gol dakikalarını birlikte değerlendirir.</p>
        </div>
        <div className="window-card">
          <span>Analiz penceresi</span>
          <strong>31 gün</strong>
          <small>Veri her gün bulutta yenilenir</small>
        </div>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="metrics" aria-label="Özet">
        <article><span>Yaklaşan maç</span><strong>{data?.metrics.upcoming ?? "—"}</strong><small>31 günlük fikstür</small></article>
        <article><span>Analizi hazır</span><strong>{data?.metrics.analyzed ?? "—"}</strong><small>Yeterli geçmiş verili</small></article>
        <article><span>Sonuçlanan tahmin</span><strong>{data?.metrics.settled ?? "—"}</strong><small>Model geri bildirimi</small></article>
        <article><span>İsabet oranı</span><strong>{percentage(data?.metrics.hitRate ?? null)}</strong><small>Tekil seçim başarısı</small></article>
      </section>

      <section className="pool-panel" aria-label="Veri havuzu">
        <div>
          <p className="eyebrow">KENDİ VERİ HAVUZUMUZ</p>
          <h2>{data?.metrics.historicalMatches ?? "—"} doğrulanmış maç sonucu</h2>
          <p>Lig, kupa ve UEFA maçları aynı takım geçmişinde birleşir. Model her takımın son 5 maçını sezon ayrımı yapmadan kullanır.</p>
        </div>
        <dl>
          <div><dt>5+ maç verili takım</dt><dd>{data?.metrics.teamsReady ?? "—"} / {data?.metrics.teams ?? "—"}</dd></div>
          <div><dt>Ayrıntılı istatistikli maç</dt><dd>{data?.metrics.detailedStatsMatches ?? "—"}</dd></div>
          <div><dt>Gol dakikası tam maç</dt><dd>{data?.metrics.goalTimingMatches ?? "—"}</dd></div>
        </dl>
        <div className="source-chips">
          {(data?.sources || []).map((source) => (
            <span key={source.name}><b>{source.name}</b>{source.results} sonuç / {source.matches} maç</span>
          ))}
        </div>
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
                    <time>{formatFixtureDate(fixture.kickoff_utc, fixture.status)}</time>
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
                        <span><b>Atak</b>{detail.home_avg_attacks?.toFixed(0) ?? "—"} / {detail.away_avg_attacks?.toFixed(0) ?? "—"}</span>
                        <span><b>Pas isabeti</b>{detail.home_pass_accuracy?.toFixed(0) ?? "—"}% / {detail.away_pass_accuracy?.toFixed(0) ?? "—"}%</span>
                        <span><b>Top kazanma</b>{detail.home_recoveries?.toFixed(0) ?? "—"} / {detail.away_recoveries?.toFixed(0) ?? "—"}</span>
                        <span><b>Rakibe verilen isabetli şut</b>{detail.home_sot_allowed?.toFixed(1) ?? "—"} / {detail.away_sot_allowed?.toFixed(1) ?? "—"}</span>
                        <span><b>Gol atma dakikası ort.</b>{detail.home_avg_goal_minute?.toFixed(0) ?? "—"} / {detail.away_avg_goal_minute?.toFixed(0) ?? "—"}</span>
                        <span><b>Gol yeme dakikası ort.</b>{detail.home_avg_conceded_minute?.toFixed(0) ?? "—"} / {detail.away_avg_conceded_minute?.toFixed(0) ?? "—"}</span>
                        <span><b>76+ gol atma oranı</b>{detail.home_late_scoring_share == null ? "—" : percentage(detail.home_late_scoring_share)} / {detail.away_late_scoring_share == null ? "—" : percentage(detail.away_late_scoring_share)}</span>
                        <span><b>76+ gol yeme oranı</b>{detail.home_late_conceding_share == null ? "—" : percentage(detail.home_late_conceding_share)} / {detail.away_late_conceding_share == null ? "—" : percentage(detail.away_late_conceding_share)}</span>
                        <span><b>Gol dakikası kapsamı</b>{percentage(detail.goal_timing_coverage ?? null)}</span>
                        <span><b>Detay veri kapsamı</b>{percentage(best.stats_coverage)}</span>
                        <span><b>Veri kalitesi</b>{percentage(best.data_quality)}</span>
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
          <div className="section-heading"><div><p className="eyebrow">OTOMATİK SEÇİM</p><h2>Kupon Robotu</h2></div></div>
          <button
            type="button"
            className="robot-button"
            onClick={() => { setCouponRobotOpen(true); setCouponTab("READY"); }}
          >
            Bugünün Kuponunu Getir
          </button>
          <div className="coupon-tabs" role="tablist" aria-label="Kupon görünümü">
            <button type="button" className={couponTab === "READY" ? "active" : ""} onClick={() => setCouponTab("READY")}>Bugün</button>
            <button type="button" className={couponTab === "SELECTED" ? "active" : ""} onClick={() => setCouponTab("SELECTED")}>Seçtiklerim ({selectedCouponIds.length})</button>
            <button type="button" className={couponTab === "HISTORY" ? "active" : ""} onClick={() => setCouponTab("HISTORY")}>Geçmiş</button>
          </div>
          {couponTab === "READY" && !couponRobotOpen && (
            <div className="coupon-empty"><span className="coupon-number">K</span><strong>Robot hazır</strong><p>Yalnızca bugünün düşük risk eşiğini geçen 4–5 maçlık kuponlarını görmek için düğmeye bas.</p></div>
          )}
          {(couponTab !== "READY" || couponRobotOpen) && !coupons.length && (
            <div className="coupon-empty"><span className="coupon-number">0</span><strong>Bu bölümde kupon yok</strong><p>Robot zorla seçim üretmez. En az dört maç %72 güven ve %68 veri kalitesi eşiğini geçmelidir.</p></div>
          )}
          {(couponTab !== "READY" || couponRobotOpen) && coupons.map((coupon) => (
            <article className={`coupon-card status-${coupon.status.toLowerCase()}`} key={coupon.id}>
              <div className="coupon-head">
                <div><span>{coupon.generated_for} · {couponStatusLabel(coupon.status)}{coupon.manually_reviewed ? " · Manuel kayıt" : ""}</span><strong>{coupon.label}</strong></div>
                <b>{coupon.status === "WON" ? "✓" : coupon.status === "LOST" ? "×" : percentage(coupon.combined_probability)}</b>
              </div>
              <ol>
                {coupon.selections.map((pick) => (
                  <li key={`${coupon.id}-${pick.position}`}>
                    <div>
                      <strong>{pick.home_team} – {pick.away_team}</strong>
                      <span>
                        {pick.market.toFixed(1)} {pick.selection === "UST" ? "Üst" : "Alt"}
                        {pick.home_goals !== null && pick.away_goals !== null ? ` · ${pick.home_goals}-${pick.away_goals}` : ""}
                      </span>
                    </div>
                    <b className={pick.outcome ? `pick-${pick.outcome.toLowerCase()}` : ""}>
                      {pick.outcome === "WON" ? "✓" : pick.outcome === "LOST" ? "×" : percentage(pick.probability)}
                    </b>
                  </li>
                ))}
              </ol>
              <div className="coupon-foot">
                <span>Birleşik olasılık <strong>{percentage(coupon.combined_probability)}</strong></span>
                <button type="button" onClick={() => toggleCoupon(coupon.id)}>
                  {selectedCouponIds.includes(coupon.id) ? "Seçimi kaldır" : "Kuponu seç"}
                </button>
              </div>
              <details className="manual-result">
                <summary>Skorları ve kupon sonucunu elle gir</summary>
                <label>
                  <span>Yönetici anahtarı</span>
                  <input
                    type="password"
                    value={manualToken}
                    onChange={(event) => setManualToken(event.target.value)}
                    placeholder="Gizli anahtar"
                    autoComplete="current-password"
                  />
                </label>
                <div className="score-grid">
                  {coupon.selections.map((pick) => (
                    <div className="score-row" key={`score-${coupon.id}-${pick.fixture_id}`}>
                      <span>{pick.home_team} – {pick.away_team}</span>
                      <input
                        type="number"
                        min="0"
                        max="30"
                        inputMode="numeric"
                        aria-label={`${pick.home_team} gol`}
                        value={scoreDrafts[pick.fixture_id]?.home ?? (pick.home_goals ?? "")}
                        onChange={(event) => updateScore(pick.fixture_id, "home", event.target.value)}
                      />
                      <b>–</b>
                      <input
                        type="number"
                        min="0"
                        max="30"
                        inputMode="numeric"
                        aria-label={`${pick.away_team} gol`}
                        value={scoreDrafts[pick.fixture_id]?.away ?? (pick.away_goals ?? "")}
                        onChange={(event) => updateScore(pick.fixture_id, "away", event.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="manual-actions">
                  <button type="button" disabled={savingCouponId === coupon.id} onClick={() => saveManualResult(coupon, "WON")}>Kupon tuttu</button>
                  <button type="button" disabled={savingCouponId === coupon.id} onClick={() => saveManualResult(coupon, "LOST")}>Kupon tutmadı</button>
                </div>
              </details>
            </article>
          ))}
          {manualMessage && <p className="manual-message" role="status">{manualMessage}</p>}
        </aside>
      </section>

      <footer><span>Olasılık tahmindir, garanti değildir. Sistem riskli seçimleri zorla kupona eklemez.</span><span>Model: goal-poisson-2.1-timing</span></footer>
    </main>
  );
}
