"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  conservativeProbability, expectedValue, rankSelections, kickoffSlot,
  type CouponCandidate, type RankedCandidate,
} from "@/lib/coupon-optimizer";

type Prediction = CouponCandidate & {
  expected_total: number;
  explanation_json: string;
};
type Fixture = {
  id: number;
  status: string;
  kickoff_utc: string;
  source_checked_at: string;
  competition: string;
  competition_code: string;
  home_team: string;
  away_team: string;
  home_team_id: number;
  away_team_id: number;
  predictions: Prediction[];
};
type Data = {
  generatedAt: string;
  fixtures: Fixture[];
  lastSync: null | {finished_at?: string; status?: string};
};
type MarketChoice = "TUMU" | "ALT" | "UST";

const pct = (p: number) => "%"+(p * 100).toFixed(1).replace(".", ",");
const dec = (v: number) => v.toFixed(2).replace(".", ",");
const day = (s: string | Date) => {
  const parts=new Intl.DateTimeFormat("en-CA", {
    timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date(s));
  const field=(type:string)=>parts.find(p=>p.type===type)?.value||"";
  return `${field("year")}-${field("month")}-${field("day")}`;
};
const tomorrow = () => day(new Date(Date.now() + 86_400_000));
const formatTime = (s: string) => new Intl.DateTimeFormat("tr-TR",{
  timeZone:"Europe/Istanbul", hour:"2-digit", minute:"2-digit",
}).format(new Date(s));
const selectionLabel = (p: {market:number;selection:string}) =>
  p.market.toFixed(1).replace(".", ",")+" "+(p.selection === "UST" ? "Üst" : "Alt");

function poissonUnder(market: number, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0) return 0.5;
  const lastGoal = Math.floor(market);
  let term = Math.exp(-lambda), sum = term;
  for(let i = 1; i <= lastGoal; i++) {term *= lambda / i; sum += term;}
  return Math.min(1, Math.max(0,sum));
}

function simulate(probabilities: number[], count = 10000) {
  // Reproducible independent-event simulations. Not a separate model.
  let seed = 0x4a39b70d;
  let wins = 0;
  for (let i = 0; i < count; i++) {
    let successful = true;
    for (const p of probabilities) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (seed / 4294967296 >= p) successful = false;
    }
    if(successful) wins++;
  }
  return wins;
}

export default function SmartCouponsPage() {
  const [data,setData] = useState<Data|null>(null);
  const [error,setError] = useState("");
  const [date,setDate] = useState("");
  const attemptedFirstImport=useRef(false);
  const [count,setCount] = useState(5);
  const [quality,setQuality] = useState(0.65);
  const [choice,setChoice] = useState<MarketChoice>("TUMU");
  const [league,setLeague] = useState("ALL");
  const [kickoffTime,setKickoffTime] = useState("AUTO");
  const [refreshing,setRefreshing] = useState(false);
  const [refreshMessage,setRefreshMessage] = useState("");
  const [loadingHistory,setLoadingHistory] = useState(false);
  const [historyCoverage,setHistoryCoverage] = useState<Array<{competition_code:string;played:number;complete_goals:number;detailed_stats:number}>>([]);
  const [historyProgress,setHistoryProgress] = useState<Array<{competition_code:string;provider:string;last_status:string;matches_processed:number;goal_sets_processed:number;last_error:string|null}>>([]);
  const [odds,setOdds] = useState<Record<number,string>>({});
  const [stake,setStake] = useState("");
  const [showAll,setShowAll] = useState(false);
  const [refresh,setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/dashboard?days=31",{cache:"no-store",signal:abort.signal})
      .then(async r=>{if(!r.ok)throw Error("Veri havuzuna erişilemiyor.");return r.json() as Promise<Data>;})
      .then(setData).catch((e: unknown)=>{
        if(!abort.signal.aborted) setError(e instanceof Error ? e.message : "Veri yüklenemedi.");
      });
    return ()=>abort.abort();
  },[refresh]);
  useEffect(()=>{
    const controller=new AbortController();
    fetch("/api/history-status",{cache:"no-store",signal:controller.signal})
      .then(async r=>{if(!r.ok)throw Error("Geçmiş veri durumu alınamadı");return r.json();})
      .then((payload:{coverage?:typeof historyCoverage;progress?:typeof historyProgress})=>{
        setHistoryCoverage(payload.coverage||[]);
        setHistoryProgress(payload.progress||[]);
      }).catch(()=>{});
    return()=>controller.abort();
  },[refresh]);

  async function updateHistory(){
    setLoadingHistory(true);
    setRefreshMessage("");
    try{
      const response=await fetch("/api/history-backfill",{method:"POST",cache:"no-store"});
      const payload=await response.json() as {
        ok?:boolean;error?:string;skipped?:boolean;
        history?:{ok?:boolean;league?:string;stored?:number;goalsSaved?:number;error?:string};
        detail?:{statsSaved?:number;goalSetsSaved?:number}
      };
      if(!response.ok||!payload.ok)throw Error(payload.error||"Geçmiş veriler yüklenemedi.");
      setRefreshMessage(payload.skipped
        ?"Yakın zamanda başlatılan geçmiş veri kontrolü zaten çalıştı."
        : `Tarihçe: ${payload.history?.league||"—"} · ${payload.history?.stored||0} maç · ${payload.history?.goalsSaved||0} doğrulanmış gol olayı seti · ${payload.detail?.statsSaved||0} ayrıntılı maç istatistiği. ${payload.history?.error||""}`);
    }catch(e){setRefreshMessage(e instanceof Error?e.message:"Geçmiş veri işlemi başarısız.");}
    finally{setLoadingHistory(false);setRefresh(x=>x+1);}
  }
  useEffect(()=>{
    const timer=window.setInterval(()=>setRefresh(value=>value+1),90_000);
    return ()=>window.clearInterval(timer);
  },[]);
  async function refreshResults(){
    setRefreshing(true);setRefreshMessage("");
    try{
      const fixtureResponse=await fetch("/api/refresh-fixtures",{method:"POST",cache:"no-store"});
      const fixtures=await fixtureResponse.json() as {ok?:boolean;update?:{added?:number};skipped?:boolean;error?:string};
      if(!fixtureResponse.ok||!fixtures.ok)throw Error(fixtures.error||"Fikstürler güncellenemedi.");
      const resultResponse=await fetch("/api/refresh-results",{method:"POST",cache:"no-store"});
      const result=await resultResponse.json() as {ok?:boolean;updated?:number;error?:string;skipped?:boolean};
      if(!resultResponse.ok||!result.ok)throw Error(result.error||"Skorlar güncellenemedi.");
      setRefreshMessage(`Kontrol edildi: ${fixtures.update?.added??0} yeni maç, ${result.updated??0} yeni final skor.`);
    }catch(error){setRefreshMessage(error instanceof Error?error.message:"Güncelleme başarısız.");}
    finally{setRefreshing(false);setRefresh(x=>x+1);}
  }

  const upcomingDays=useMemo(() =>
    [...new Set((data?.fixtures??[]).filter(f=>
      ["SCHEDULED","TIMED","TBC"].includes(f.status)
      && Date.parse(f.kickoff_utc)>Date.now()
      && (league==="ALL"||f.competition_code===league)
    ).map(f=>day(f.kickoff_utc)))].sort().slice(0,31),
  [data,league]);
  const effectiveDate = date || upcomingDays[0] || tomorrow();
  const dailyFixtures=useMemo(()=>(data?.fixtures??[]).filter(f=>
    day(f.kickoff_utc)===effectiveDate &&
    (league==="ALL"||f.competition_code===league) &&
    ["SCHEDULED","TIMED","TBC"].includes(f.status) &&
    Date.parse(f.kickoff_utc)>Date.now()
  ),[data,effectiveDate,league]);
  const fixtures = dailyFixtures.filter(f=>f.status!=="TBC");
  const selectionMap = useMemo(() => new Map(fixtures.map(f=>[f.id,f])),[dailyFixtures]);
  const available = useMemo(() => fixtures.flatMap(f=>
    f.predictions.filter(p=>choice==="TUMU"||p.selection===choice)
      .map(p=>({...p, fixture_id:f.id, kickoff_utc:f.kickoff_utc}))
  ),[fixtures,choice]);
  const ranked = useMemo(()=>rankSelections(available,quality),[available,quality]);
  const timeGroups=useMemo(()=>{
    const groups=new Map<string,RankedCandidate[]>();
    for (const pick of ranked) {
      const slot=kickoffSlot(pick.kickoff_utc);
      if(!slot)continue;
      const group=groups.get(slot)||[];
      group.push(pick);
      groups.set(slot,group);
    }
    return [...groups.entries()].sort((a,b)=> {
      const av=a[1].filter(p=>p.conservative_probability>=0.62);
      const bv=b[1].filter(p=>p.conservative_probability>=0.62);
      const aEnough=av.length>=count, bEnough=bv.length>=count;
      if(aEnough!==bEnough) return aEnough?-1:1;
      if(aEnough&&bEnough) {
        const ap=av.slice(0,count).reduce((sum,p)=>sum*p.conservative_probability,1);
        const bp=bv.slice(0,count).reduce((sum,p)=>sum*p.conservative_probability,1);
        if(ap!==bp) return bp-ap;
      }
      return bv.length-av.length || a[0].localeCompare(b[0]);
    });
  },[ranked,count]);
  const selectedTime=kickoffTime==="AUTO" ? timeGroups[0]?.[0] : kickoffTime;
  const sameTimeRanked=ranked.filter(p=>kickoffSlot(p.kickoff_utc)===selectedTime);
  const choices = sameTimeRanked.filter(p=>p.conservative_probability>=0.62).slice(0,count);
  const sufficient = choices.length === count;
  const joint = sufficient ? choices.reduce((value,p)=>value*p.conservative_probability,1) : null;
  const scenarioWins = useMemo(() => sufficient ? simulate(choices.map(p=>p.conservative_probability)):null,[choices,sufficient]);
  const allOdds = sufficient && choices.every(p=>Number(odds[p.fixture_id])>1);
  const totalOdds = allOdds ? choices.reduce((v,p)=>v*Number(odds[p.fixture_id]),1):null;
  const ev = joint!==null && totalOdds!==null ? expectedValue(joint,totalOdds):null;
  const stakeAmount = Number(stake);
  const sourceAge = data?.lastSync?.finished_at
    ? (Date.now()-new Date(data.lastSync.finished_at).getTime())/3600000 : Infinity;
  const stale = data!==null && (sourceAge>72 || data.lastSync?.status==="FAILED");

  useEffect(()=>{
    if(!data||attemptedFirstImport.current)return;
    attemptedFirstImport.current=true;
    const upcoming=(data.fixtures??[]).filter(f=>{
      const ms=Date.parse(f.kickoff_utc);
      return ["TIMED","SCHEDULED","TBC"].includes(f.status)
        && ms>Date.now() && ms<Date.now()+7*86_400_000;
    });
    if(upcoming.length>0)return;
    void (async()=>{
      setRefreshing(true);
      setRefreshMessage("Güncel maç fikstürü otomatik kontrol ediliyor…");
      try{
        const response=await fetch("/api/refresh-fixtures",{method:"POST",cache:"no-store"});
        const payload=await response.json() as {ok?:boolean;error?:string;update?:{added?:number;sources?:Array<{league:string;fetched:number;error?:string}>};skipped?:boolean};
        if(!response.ok||!payload.ok)throw Error(payload.error||"Fikstür kaynağına ulaşılamadı.");
        const sourceCount=(payload.update?.sources??[]).reduce((n,s)=>n+(s.fetched||0),0);
        setRefreshMessage(payload.skipped
          ? "Kaynaklar daha önce kontrol edilmiş. Listede maç yoksa filtreleri genişlet."
          : `Fikstür kaynaklarında ${sourceCount} maç bulundu, ${payload.update?.added??0} yeni kayıt eklendi.`);
        setRefresh(value=>value+1);
      }catch(error){
        setRefreshMessage(error instanceof Error ? error.message : "Otomatik fikstür yenileme başarısız.");
      }finally{setRefreshing(false);}
    })();
  },[data]);

  return <main className="mx-auto max-w-6xl px-4 py-7 md:px-8 text-[#12251a]">
    <header className="mb-9 flex flex-wrap items-center justify-between gap-4">
      <div>
        <Link href="/" className="text-sm font-semibold text-[#176b45]">← Ana panele dön</Link>
        <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-5xl">Akıllı Kupon Laboratuvarı</h1>
        <p className="mt-2 max-w-2xl text-sm text-[#566a5a]">
          Yalnızca aynı gün ve aynı saatteki maçlarla gol olasılıkları, veri kalitesi ve kupon riskini karşılaştırır.
        </p>
      </div>
      <button disabled={refreshing} className="rounded-xl border border-[#c8d6ce] bg-white px-4 py-3 text-sm font-semibold disabled:opacity-50"
        onClick={refreshResults}>{refreshing?"Skorlar kontrol ediliyor…":"Maç ve skorları güncelle"}</button>
    </header>

    <section className="mb-5 flex flex-wrap items-center gap-3">
      <button disabled={loadingHistory} onClick={updateHistory}
        className="rounded-xl border border-[#b7cbbd] bg-[#176b45] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
        {loadingHistory?"Geçmiş maçlar doğrulanıyor…":"Geçmiş maç / gol verilerini yükle"}
      </button>
      <span className="text-xs text-[#566a5a]">Geçmiş veriler kademeli ve kaynaklı işlenir. Günlük otomatik yenileme de etkin.</span>
    </section>
    {refreshMessage && <p role="status" className="mb-4 text-sm text-[#176b45]">{refreshMessage}</p>}
    {error && <p role="alert" className="mb-5 rounded-xl bg-red-50 p-4 text-red-800">{error}</p>}
    {stale && <p role="alert" className="mb-5 border-l-4 border-amber-500 bg-amber-50 p-4 text-sm">
      Son veri senkronizasyonu güncel değil veya başarısız. Tahminleri kullanmadan önce kaynakları doğrula.
    </p>}
    <section className="mb-6 grid gap-4 rounded-2xl border border-[#dce2dc] bg-white p-5 md:grid-cols-3 xl:grid-cols-6" aria-label="Analiz tercihleri">
      <label className="grid gap-2 text-sm font-semibold">Maç tarihi
        <input type="date" value={effectiveDate} min={day(new Date())} onChange={e=>{setDate(e.target.value);setKickoffTime("AUTO");}}
          className="w-full rounded-lg border border-[#c8d6ce] p-3"/>
      </label>
      <label className="grid gap-2 text-sm font-semibold">Kupondaki maç sayısı
        <select value={count} onChange={e=>setCount(Number(e.target.value))}
          className="rounded-lg border border-[#c8d6ce] p-3">
          {[2,3,4,5,6].map(n=><option key={n} value={n}>{n} maç</option>)}
        </select>
      </label>
      <label className="grid gap-2 text-sm font-semibold">Lig seçimi
        <select value={league} onChange={e=>{setLeague(e.target.value);setDate("");setKickoffTime("AUTO");}}
          className="rounded-lg border border-[#c8d6ce] p-3">
          {[
            ["ALL","Tüm ligler"],["TSL","Türkiye Süper Lig"],["T1","Türkiye 1. Lig"],
            ["T2","Türkiye 2. Lig"],["T3","Türkiye 3. Lig"],
            ["BL","Almanya Bundesliga"],["BL2","Almanya 2. Bundesliga"],["BL3","Almanya 3. Liga"],["SA","İtalya Serie A"],
            ["PL","İngiltere Premier Lig"],["LL","İspanya La Liga"],
            ["CL","Şampiyonlar Ligi"],["EL","Avrupa Ligi"],["ECL","Konferans Ligi"],
          ].map(([id,title])=><option key={id} value={id}>{title}</option>)}
        </select>
      </label>
      <label className="grid gap-2 text-sm font-semibold">Gol tercihi
        <select value={choice} onChange={e=>setChoice(e.target.value as MarketChoice)}
          className="rounded-lg border border-[#c8d6ce] p-3">
          <option value="TUMU">Alt ve üst</option><option value="UST">Yalnızca üst</option><option value="ALT">Yalnızca alt</option>
        </select>
      </label>
      <label className="grid gap-2 text-sm font-semibold">Başlama saati (Türkiye)
        <select value={kickoffTime} onChange={e=>setKickoffTime(e.target.value)}
          className="rounded-lg border border-[#c8d6ce] p-3">
          <option value="AUTO">Otomatik: en güçlü saat</option>
          {timeGroups.map(([slot,matches])=><option key={slot} value={slot}>{slot.slice(11)} · {matches.length} maç</option>)}
        </select>
      </label>
      <label className="grid gap-2 text-sm font-semibold">Asgari veri kalitesi
        <select value={quality} onChange={e=>setQuality(Number(e.target.value))}
          className="rounded-lg border border-[#c8d6ce] p-3">
          <option value={0.6}>%60</option><option value={0.65}>%65 (önerilen)</option><option value={0.75}>%75</option><option value={0.85}>%85</option>
        </select>
      </label>
    </section>
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      {[
        ["O günkü maç",String(dailyFixtures.length)],
        ["Analizi bulunan",String(dailyFixtures.filter(f=>f.predictions.length>0).length)],
        ["Filtreyi geçen",String(ranked.length)],
        ["Son güncelleme",data?.lastSync?.finished_at?new Date(data.lastSync.finished_at).toLocaleString("tr-TR",{timeZone:"Europe/Istanbul"}):"Bekleniyor"],
      ].map(([label,value])=><div key={label} className="rounded-xl border border-[#dce2dc] bg-white p-4">
        <div className="text-xs text-[#566a5a]">{label}</div>
        <div className="mt-2 text-lg font-bold">{value}</div>
      </div>)}
    </div>

    {historyCoverage.length>0 && <section className="mb-5 rounded-2xl border border-[#dce2dc] bg-white p-5">
      <h2 className="text-lg font-bold">Liglerde yüklenen gerçek veri kapsamı</h2>
      <p className="mt-1 text-xs text-[#566a5a]">Sayılar tamamlanan maçlara aittir; ayrıntılı veri her sağlayıcıda bulunmayabilir.</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {historyCoverage.map(row=><div key={row.competition_code} className="flex justify-between gap-3 border-b border-[#edf0eb] py-2 text-sm">
          <strong>{row.competition_code}</strong>
          <span>{row.played} sonuç · {row.complete_goals||0} gol dakika seti · {row.detailed_stats||0} istatistik</span>
        </div>)}
      </div>
      {historyProgress.filter(x=>x.last_status==="FAILED").length>0&&<p className="mt-2 text-xs text-amber-800">Bazı sağlayıcılar hata verdi; veriler tamamlanmamış olabilir.</p>}
    </section>}
    <section className="mb-6 rounded-2xl border border-[#dce2dc] bg-white p-5">
      <div className="mb-4">
        <h2 className="text-xl font-bold">Maç fikstürü · {effectiveDate}</h2>
        <p className="mt-1 text-sm text-[#566a5a]">Tahmini hazır olmasa bile doğrulanmış bütün maçları listeler. Kupon için sadece aynı gün ve aynı saatte başlayan, veri kalitesi yeterli maçlar seçilir.</p>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {upcomingDays.slice(0,14).map(key=><button type="button" key={key}
          onClick={()=>{setDate(key);setKickoffTime("AUTO");}}
          className={`rounded-lg border px-3 py-2 text-sm ${effectiveDate===key?"border-[#176b45] bg-[#e2efe5] font-bold":"border-[#dce2dc]"}`}>
          {key}{effectiveDate===key?" · Seçili":""}
        </button>)}
      </div>
      {!data && !error && <p role="status" className="py-3">Fikstür yükleniyor…</p>}
      {data && dailyFixtures.length===0 && <p className="rounded-xl bg-[#f0f3ed] p-4 text-sm">
        {upcomingDays.length
          ? "Bu tarihte maç bulunamadı. Yukarıdaki maç bulunan günlerden birini seç."
          : "Önümüzdeki 31 gün için doğrulanmış maç verisi henüz yok. Kaynakları yeniden güncelle; son denetim mesajını kontrol et."}
      </p>}
      <div className="divide-y divide-[#e7ece7]">
        {dailyFixtures.slice(0,showAll?200:40).map(f=><div key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div>
            <strong className="text-sm"><Link href={"/takim/"+f.home_team_id} className="underline decoration-[#b4c6b6]">{f.home_team}</Link> – <Link href={"/takim/"+f.away_team_id} className="underline decoration-[#b4c6b6]">{f.away_team}</Link></strong>
            <div className="mt-1 text-xs text-[#566a5a]">{f.competition}</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold">{f.status==="TBC"?"Saat onaylanmadı":formatTime(f.kickoff_utc)}</div>
            <div className="text-xs text-[#566a5a]">{f.predictions.length?"Analiz mevcut":"Geçmiş maç verisi / örneklem kontrol ediliyor"}</div>
          </div>
        </div>)}
      </div>
    </section>

    <div className="grid gap-6 lg:grid-cols-[1.55fr_1fr]">
      <section className="rounded-2xl border border-[#dce2dc] bg-white p-5">
        <div className="mb-5">
          <h2 className="text-2xl font-bold">Seçilen kupon {selectedTime?"· "+selectedTime.slice(11):""}</h2>
          <p className="mt-1 text-sm text-[#566a5a]">Her maçtan yalnızca bir gol bahsi seçilir. Olasılıklara veri eksikliği indirimi uygulanır.</p>
        </div>
        {!data && !error && <p role="status">Güncel maçlar yükleniyor…</p>}
        {data && !sufficient && <div className="rounded-xl bg-[#f0f3ed] p-5">
          <strong>Güvenilir kupon oluşturulamadı.</strong>
          <p className="mt-1 text-sm">Aynı gün ve aynı başlama saatinde {count} yeterli kaliteli maç bulunamadı. Farklı saatten maç eklenmez. Saati veya maç sayısını değiştirebilirsin.</p>
        </div>}
        {sufficient && <div className="space-y-3">
          {choices.map((p,index)=>{
            const f = selectionMap.get(p.fixture_id);
            if(!f) return null;
            return <article key={p.fixture_id} className="rounded-xl border border-[#dce2dc] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-xs text-[#566a5a]">{index+1}. {f.competition} · {formatTime(f.kickoff_utc)}</span>
                  <h3 className="mt-1 font-bold"><Link href={"/takim/"+f.home_team_id} className="underline">{f.home_team}</Link> – <Link href={"/takim/"+f.away_team_id} className="underline">{f.away_team}</Link></h3>
                  <div className="mt-1 text-sm text-[#176b45]">{selectionLabel(p)} · Veri kalitesi {pct(p.data_quality)}</div>
                </div>
                <div className="text-right"><strong className="text-xl">{pct(p.conservative_probability)}</strong>
                  <div className="text-xs text-[#566a5a]">Temkinli tahmin</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#e7ece7] pt-3">
                <span className="text-xs text-[#566a5a]">Ham/kalibre edilmiş model: {pct(p.probability)} · Veri kapsamı: {pct(p.stats_coverage)}</span>
                <label className="flex items-center gap-2 text-xs font-semibold">Bilyoner oranı
                  <input type="number" inputMode="decimal" step="0.01" min="1.01" placeholder="Örn. 1.35"
                    aria-label={f.home_team+" – "+f.away_team+" bahis oranı"}
                    value={odds[p.fixture_id]??""}
                    onChange={e=>setOdds(old=>({...old,[p.fixture_id]:e.target.value}))}
                    className="w-28 rounded-lg border border-[#c8d6ce] p-2"/>
                </label>
              </div>
            </article>;
          })}
        </div>}
      </section>

      <aside className="space-y-4">
        <div className="rounded-2xl bg-[#176b45] p-6 text-white">
          <h2 className="text-xl font-bold">Toplam risk analizi</h2>
          <div className="mt-5 text-sm text-[#d3eee0]">Hepsinin gerçekleşme olasılığı</div>
          <div className="mt-1 text-5xl font-bold">{joint===null?"—":pct(joint)}</div>
          <div className="mt-4 h-3 overflow-hidden rounded-full bg-[#315c45]">
            <div className="h-full bg-[#dff36b]" style={{width: ((joint??0)*100)+"%"}}/>
          </div>
          <div className="mt-4 text-sm">
            {joint===null?"Eksik veri nedeniyle risk hesaplanamadı.":
              `10.000 bağımsız senaryoda yaklaşık ${scenarioWins?.toLocaleString("tr-TR")} tam isabet. Kuponun kaybetme tahmini ${pct(1-joint)}.`}
          </div>
          <p className="mt-3 text-xs text-[#d3eee0]">Simülasyon olasılığı doğrulamaz; aynı modelin tekrar örneklenmesidir. Maçlar bağımsız varsayılmıştır.</p>
        </div>
        <div className="rounded-2xl border border-[#dce2dc] bg-white p-5">
          <h2 className="text-xl font-bold">Oran ve değer karşılaştırması</h2>
          <p className="mt-2 text-sm text-[#566a5a]">Sitede canlı bahis oranı bulunmuyor. Doğru oranları kendin girdiğinde kâr beklentisi hesaplanır.</p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4"><dt>Modelin adil toplam oranı</dt><dd className="font-bold">{joint?dec(1/joint):"—"}</dd></div>
            <div className="flex justify-between gap-4"><dt>Girilen toplam oran</dt><dd className="font-bold">{totalOdds?dec(totalOdds):"—"}</dd></div>
            <div className="flex justify-between gap-4"><dt>Beklenen değer (EV)</dt><dd className={ev!==null&&ev<0?"font-bold text-red-700":"font-bold text-[#176b45]"}>{ev===null?"Oran girilmeli":(ev>=0?"+":"")+pct(ev)}</dd></div>
            <div className="flex justify-between gap-4"><dt>Piyasa başabaş ihtimali</dt><dd className="font-bold">{totalOdds?pct(1/totalOdds):"—"}</dd></div>
          </dl>
          <label className="mt-5 grid gap-2 text-sm font-semibold">Varsayımsal kupon bedeli (TL)
            <input value={stake} onChange={e=>setStake(e.target.value)} type="number" min="0" step="1"
              placeholder="Tutar girilmedi" className="rounded-lg border border-[#c8d6ce] p-3"/>
          </label>
          <p className="mt-3 text-sm">Tüm maçlar tutarsa brüt ödeme: <strong>{
            totalOdds!==null && stakeAmount>0 && Number.isFinite(stakeAmount)
              ? (totalOdds*stakeAmount).toLocaleString("tr-TR",{style:"currency",currency:"TRY"}):"—"
          }</strong></p>
          <p className="mt-4 text-xs text-[#566a5a]">Pozitif EV kesin kazanç değildir. Model kalibre edilmediyse EV tahmini yanıltıcı olabilir. Hiç bahis yapmamak da geçerli seçenektir.</p>
        </div>
      </aside>
    </div>

    <section className="mt-6 rounded-2xl border border-[#dce2dc] bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h2 className="text-xl font-bold">Diğer maçların olasılıkları</h2>
          <p className="mt-1 text-sm text-[#566a5a]">Kalan uygun maçlar, en yüksek temkinli olasılıktan sıralanır.</p></div>
        <button onClick={()=>setShowAll(v=>!v)} className="rounded-xl bg-[#eef3ef] px-4 py-2 text-sm font-semibold">{showAll?"Daha az göster":"Tümünü göster"}</button>
      </div>
      <div className="mt-4 divide-y divide-[#e8ece8]">
        {ranked.slice(0,showAll?100:10).map(p=>{
          const f=selectionMap.get(p.fixture_id);if(!f)return null;
          const lambda=f.predictions.find(pred=>pred.id===p.id)?.expected_total;
          const alternatives = Number.isFinite(lambda)
            ? [1.5,2.5,3.5].map(m=>({m,u:poissonUnder(m,lambda as number)})): [];
          return <details key={p.fixture_id} className="py-3">
            <summary className="cursor-pointer font-semibold">{f.home_team} – {f.away_team}
              <span className="ml-3 text-sm text-[#176b45]">{selectionLabel(p)} · {pct(p.conservative_probability)}</span>
            </summary>
            <p className="mt-2 text-xs text-[#566a5a]">Alt ve üst için diğer sonuçların ham Poisson dağılımı (kalibrasyonsuz):</p>
            <div className="mt-2 flex flex-wrap gap-2">{alternatives.flatMap(a=>[
              <span key={a.m+"alt"} className="rounded-lg bg-[#eef3ef] px-3 py-2 text-xs">{a.m} Alt {pct(a.u)}</span>,
              <span key={a.m+"ust"} className="rounded-lg bg-[#eef3ef] px-3 py-2 text-xs">{a.m} Üst {pct(1-a.u)}</span>
            ])}</div>
          </details>;
        })}
        {data && ranked.length===0 && <p className="py-4 text-sm">Bu tarihte güvenilir veri eşiğini geçen maç bulunmuyor.</p>}
      </div>
    </section>
    <footer className="mt-8 text-xs text-[#566a5a]">
      Veriler kendi havuzundan alınır. Oranlar otomatik çekilmez. Gol modeli Poisson 2.2 / kalibrasyon.
      Veri tarihi, doğruluk ve oran avantajı ayrıca doğrulanmalıdır. Yatırılan para kaybedilebilir.
    </footer>
  </main>;
}
