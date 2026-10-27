"use client";

import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import Link from "next/link";

type Screen="fixture"|"analysis"|"sources";
type Filter="upcoming"|"played"|"all";
type Match={
 id:number;competition_code:string;competition:string;kickoff_utc:string;
 status:string;home_goals:number|null;away_goals:number|null;stage:string|null;
 home_team:string;away_team:string;home_team_id:number;away_team_id:number;
 source_name:string;source_url:string;source_checked_at:string;
 goal_timeline_verified:number;has_detailed_stats:number;
};
type MatchPage={fixtures:Match[];total:number;pages:number;page:number;generatedAt:string};
type League={code:string;name:string;country:string;fixtures:number;finished:number;upcoming:number;
 goals_verified:number;detailed_stats:number;last_checked:string|null};
type Progress={provider:string;competition_code:string;part_key:string;cursor_index:number;
 state:string;imported:number;checked_at:string;error:string|null};
type Coverage={totals:{fixtures:number;finished:number;upcoming:number};leagues:League[];
 progress:Progress[];asOf:string;season:string};
type Market={name:string;probability:number;conservative:number};
type Forecast={
 fixture:{id:number;competition:string;kickoff:string;homeName:string;awayName:string;homeId:number;awayId:number};
 sameTimeSlot:string|null;
 profile:{status:string;reason?:string;quality?:number;lambdaHome?:number;lambdaAway?:number;
  markets?:Market[];scores?:Array<{score:string;probability:number}>;
  samples?:{home:number;away:number;homeVenue:number;awayVenue:number;league:number;xg:number}};
 simulations?:{iterations:number;scores:Array<{score:string;count:number}>}|null;
};
type ForecastFeed={fixtures:Forecast[];generatedAt:string};
type Backtest={total:number;winnerAccuracy:number|null;over25Accuracy:number|null;
 totalBrier:number|null;baselineBrier:number|null;leagues:Array<{competition:string;count:number;validated:boolean;winnerAccuracy:number;brier:number;baselineBrier:number}>};
const knownLeagues:Record<string,string>={
 TSL:"Süper Lig",T1:"1. Lig",T2:"2. Lig",T3:"3. Lig",BL:"Bundesliga",
 BL2:"2. Bundesliga",BL3:"3. Liga",PL:"Premier League",LL:"La Liga",
 SA:"Serie A",CL:"Şampiyonlar Ligi",EL:"Avrupa Ligi",ECL:"Konferans Ligi"
};
const fmt=(v:number)=>new Intl.NumberFormat("tr-TR").format(v);
const pct=(v:number)=>"%"+(Math.max(0,Math.min(1,v))*100).toFixed(1).replace(".",",");
const local=(iso:string,kind:"date"|"time"="date")=>{
 const options: Intl.DateTimeFormatOptions=kind==="date"
  ?{timeZone:"Europe/Istanbul",day:"2-digit",month:"long",year:"numeric"}
  :{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"};
 return new Intl.DateTimeFormat("tr-TR",options).format(new Date(iso));
};
const seasonDate=(iso:string)=>{
 const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(iso));
 const get=(k:string)=>parts.find(p=>p.type===k)?.value||"";
 return get("year")+"-"+get("month")+"-"+get("day");
};
function Signal({status}:{status:string}){
 return <span className={"fl-state fl-"+(status==="FINISHED"?"done":status==="FAILED"?"failed":"scheduled")}>
  {status==="FINISHED"?"Tamamlandı":status==="FAILED"?"Hata":status==="TBC"?"Saat bekleniyor":
    status==="COMPLETE"?"Tam":status==="RUNNING"?"İşleniyor":status==="SUCCESS"?"Başarılı":"Planlandı"}
 </span>;
}
function PartTabs({value,onChange}:{value:Filter;onChange:(v:Filter)=>void}){
 return <div className="fl-tabs" role="group" aria-label="Maç durumu">
  {([["upcoming","Oynanacak"],["played","Oynanan"],["all","Tüm sezon"]] as const).map(([k,t])=>
   <button key={k} aria-pressed={value===k} className={value===k?"fl-active":""} onClick={()=>onChange(k)}>{t}</button>
  )}
 </div>;
}
export default function SeasonDesk({initialView="fixture"}:{initialView?:Screen}){
 const [view,setView]=useState<Screen>(initialView);
 const [mode,setMode]=useState<Filter>("upcoming");
 const [league,setLeague]=useState("ALL");
 const [page,setPage]=useState(1);
 const [search,setSearch]=useState("");
 const [query,setQuery]=useState("");
 const [coverage,setCoverage]=useState<Coverage|null>(null);
 const [list,setList]=useState<MatchPage|null>(null);
 const [forecasts,setForecasts]=useState<ForecastFeed|null>(null);
 const [backtest,setBacktest]=useState<Backtest|null>(null);
 const [testing,setTesting]=useState(false);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(false);
 const [message,setMessage]=useState("");
 const firstImport=useRef(false);
 const [serial,setSerial]=useState(0);
 const [kickoff,setKickoff]=useState("");
 const [picks,setPicks]=useState(3);
 const [preferred,setPreferred]=useState<Record<number,string>>({});
 const [odds,setOdds]=useState<Record<number,string>>({});
 const [stake,setStake]=useState("");
 const [details,setDetails]=useState<Record<number,boolean>>({});

 const syncView=useCallback(async()=>{
  const r=await fetch("/api/season/coverage",{cache:"no-store"});
  if(!r.ok)throw Error("Veri kapsamı okunamadı.");
  setCoverage(await r.json() as Coverage);
 },[]);
 useEffect(()=>{void syncView().catch(e=>setMessage(String(e)));},[serial,syncView]);
 useEffect(()=>{
  if(!coverage||firstImport.current)return;
  firstImport.current=true;
  // Bootstrap the 2026/27 archive when the initial database contains
  // only seed fixtures. A shared three-minute lock protects provider limits.
  const german=["BL","BL2","BL3"].some(code=>
   !(coverage.leagues.find(l=>l.code===code)?.fixtures||0));
  if(!german)return;
  void fetch("/api/season/sync",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({league:"ALL"})
  }).then(r=>r.ok?r.json():null)
    .then(v=>{if(v&&!v.skipped)setSerial(x=>x+1);})
    .catch(()=>{});
 },[coverage]);
 useEffect(()=>{
  if(view!=="fixture")return;
  let stopped=false;
  setLoading(true);
  const url="/api/season?"+new URLSearchParams({mode,league,page:String(page),search:query});
  fetch(url,{cache:"no-store"})
   .then(async r=>{if(!r.ok)throw Error((await r.json()).error||"Fikstür alınamadı");return r.json() as Promise<MatchPage>;})
   .then(value=>{if(!stopped){setList(value);setMessage("");}})
   .catch(e=>{if(!stopped)setMessage(String(e));})
   .finally(()=>{if(!stopped)setLoading(false);});
  return()=>{stopped=true;};
 },[view,mode,league,page,query,serial]);
 useEffect(()=>{
  if(view!=="analysis")return;
  let stopped=false;
  setLoading(true);
  fetch("/api/v4?days=31"+(league!=="ALL"?"&league="+encodeURIComponent(league):""),{cache:"no-store"})
   .then(async r=>{if(!r.ok)throw Error("Model veri havuzu yanıt vermedi");return r.json() as Promise<ForecastFeed>;})
   .then(v=>{if(!stopped)setForecasts(v);})
   .catch(e=>{if(!stopped)setMessage(String(e));})
   .finally(()=>{if(!stopped)setLoading(false);});
  return()=>{stopped=true;};
 },[view,league,serial]);
 useEffect(()=>{const handle=setInterval(()=>setSerial(s=>s+1),120000);return()=>clearInterval(handle);},[]);

 const leagues=useMemo(()=>{
  const known=(coverage?.leagues||[]).filter(x=>x.fixtures>0 || knownLeagues[x.code]);
  return known.sort((a,b)=>(a.country||"").localeCompare(b.country||"","tr")||a.name.localeCompare(b.name,"tr"));
 },[coverage]);
 const visible=(list?.fixtures||[]);
 const groupRows=useMemo(()=>{
  const grouped:Array<{day:string;rows:Match[]}>=[],items=new Map<string,Match[]>();
  for(const f of visible){
   const day=seasonDate(f.kickoff_utc);
   if(!items.has(day)){items.set(day,[]);grouped.push({day,rows:items.get(day)!});}
   items.get(day)!.push(f);
  }
  return grouped;
 },[visible]);
 const forecastRows=forecasts?.fixtures||[];
 const slots=useMemo(()=>{
  const grouped=new Map<string,Forecast[]>();
  for(const g of forecastRows){
   if(!g.sameTimeSlot)continue;
   const list=grouped.get(g.sameTimeSlot)||[];list.push(g);grouped.set(g.sameTimeSlot,list);
  }
  return [...grouped].sort((a,b)=>{
   const capable=(x:Forecast[])=>x.filter(g=>g.profile.status==="READY"&&Number(g.profile.quality||0)>=0.57).length;
   return Number(capable(b[1])>=picks)-Number(capable(a[1])>=picks)
    ||capable(b[1])-capable(a[1])||a[0].localeCompare(b[0]);
  });
 },[forecastRows,picks]);
 const selectedSlot=(kickoff&&slots.some(s=>s[0]===kickoff)?kickoff:slots[0]?.[0])||"";
 const eligible=(slots.find(s=>s[0]===selectedSlot)?.[1]||[])
  .filter(g=>g.profile.status==="READY"&&Number(g.profile.quality||0)>=0.57)
  .map(g=>{
   const allowed=(g.profile.markets||[]).filter(m=>/^[OU][123]\.5$/.test(m.name));
   const rawPick=allowed.find(m=>m.name===preferred[g.fixture.id])||
    allowed.sort((a,b)=>b.conservative-a.conservative)[0];
   return rawPick?{fixture:g,market:rawPick}:null;
  }).filter((x):x is {fixture:Forecast;market:Market}=>x!==null)
  .sort((a,b)=>b.market.conservative-a.market.conservative);
 const picked=eligible.slice(0,picks);
 const full=picked.length===picks;
 const combined=full?picked.reduce((v,p)=>v*p.market.conservative,1):null;
 const totalOdds=full&&picked.every(p=>Number(odds[p.fixture.fixture.id])>1)
  ?picked.reduce((v,p)=>v*Number(odds[p.fixture.fixture.id]),1):null;
 const ev=totalOdds&&combined!==null?combined*totalOdds-1:null;
 const staked=Number(stake);
 const paid=totalOdds!==null&&Number.isFinite(staked)&&staked>0?totalOdds*staked:null;

 function navigate(v:Screen){
  setView(v);setKickoff("");setMessage("");setPage(1);
  const path=v==="analysis"?"/akilli-kupon":"/";
  if(typeof window!=="undefined")window.history.replaceState(null,"",path);
 }
 function filterLeague(v:string){setLeague(v);setPage(1);setKickoff("");}
 async function importSeason(){
  setBusy(true);setMessage("");
  try{
   const r=await fetch("/api/season/sync",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({league})});
   const result=await r.json() as {ok?:boolean;error?:string;skipped?:boolean;processed?:number;
    remaining?:number;results?:Array<{status:string;saved:number;league:string;error?:string}>};
   if(!r.ok||!result.ok)throw Error(result.error||"Aktarım başarısız");
   const errors=result.results?.filter(x=>x.status==="FAILED")||[];
   setMessage(result.skipped?"Son üç dakikada kaynak tarandı.":
    "Taranan veri partisi: "+fmt(result.processed||0)+" · kaydedilen maç: "+
    fmt((result.results||[]).reduce((v,x)=>v+x.saved,0))+
    (errors.length?" · kaynağı hatalı: "+errors.map(x=>x.league).join(", "):""));
   setSerial(s=>s+1);
  }catch(e){setMessage(e instanceof Error?e.message:"Kaynak hatası");}
  finally{setBusy(false);}
 }
 async function testModel(){
  setTesting(true);setMessage("");
  try{
   const r=await fetch("/api/v4/backtest?league="+league,{cache:"no-store"});
   if(!r.ok)throw Error("Model doğruluk testi çalışmadı.");
   setBacktest(await r.json() as Backtest);
  }catch(e){setMessage(e instanceof Error?e.message:"Test hatası");}
  finally{setTesting(false);}
 }

 return <div className="fl-root">
  <header className="fl-top">
   <div className="fl-identity" onClick={()=>navigate("fixture")} role="button" tabIndex={0}
    onKeyDown={e=>{if(e.key==="Enter")navigate("fixture");}}>
    <span className="fl-symbol"><i></i><i></i><i></i></span>
    <div><strong>FİKSTÜR / LAB</strong><small>VERİ VE OLASILIK MERKEZİ</small></div>
   </div>
   <nav className="fl-navigation" aria-label="Ana bölümler">
    {([["fixture","Fikstür"],["analysis","Tahmin motoru"],["sources","Veri merkezi"]] as const)
      .map(([k,t])=><button type="button" key={k} className={view===k?"fl-selected":""} onClick={()=>navigate(k)}>{t}</button>)}
   </nav>
   <button className="fl-outline fl-sync" type="button" onClick={importSeason} disabled={busy}>
    <span className="fl-sync-icon">↻</span> {busy?"Kaynaklar taranıyor":"Verileri eşitle"}
   </button>
  </header>
  <div className="fl-frame">
   <aside className="fl-rail">
    <div className="fl-rail-title">FUTBOL · 2026/27</div>
    <h2>Ligler <span>{leagues.length}</span></h2>
    <button className={league==="ALL"?"fl-league fl-chosen":"fl-league"}
      onClick={()=>filterLeague("ALL")}><span>Tüm ligler</span><b>{fmt(coverage?.totals.fixtures||0)}</b></button>
    {leagues.map(l=><button key={l.code}
      className={league===l.code?"fl-league fl-chosen":"fl-league"}
      onClick={()=>filterLeague(l.code)}><span>{knownLeagues[l.code]||l.name}</span>
      <b>{fmt(l.fixtures)}</b></button>)}
    <div className="fl-rail-foot">Resmî ve açık kaynaklı maç kayıtları kullanılır. Eksik maçlar sonuç olarak gösterilmez.</div>
   </aside>
   <main className="fl-main">
    <div className="fl-eyebrow"><span className="fl-live-dot"></span> 2026 — 2027 SEZONU <span className="fl-sep">/</span> TÜRKİYE SAATİ</div>
    <div className="fl-hero">
     <div>
      <h1>{view==="fixture"?"Bütün maçlar.":view==="analysis"?"Olasılık, kanıtla.":"Veri kaynağı, açık."}</h1>
      <p>{view==="fixture"
       ?"Sezonun oynanan ve oynanacak karşılaşmaları. Her sonuç, kaynak ve veri kapsamıyla birlikte."
       :view==="analysis"
        ?"Skor dağılımı, 10.000 simülasyon, aynı saatte başlayan maçlar ve gerçek olasılık testi."
        :"Hangi ligin kaç maçı yüklendi, hangi veriler eksik, hangi kaynak hata verdi: tamamı görünür."}</p>
     </div>
     <div className="fl-hero-mark">26<span>/</span>27</div>
    </div>
    <div className="fl-numbers">
     {[["Sezon maçı",coverage?.totals.fixtures],["Tamamlanan",coverage?.totals.finished],
       ["Oynanacak",coverage?.totals.upcoming],
       ["Doğrulanmış gol olayı",coverage?.leagues.reduce((v,x)=>v+x.goals_verified,0)]]
       .map(([t,v])=><div className="fl-number" key={String(t)}><small>{t}</small><strong>{v===undefined?"—":fmt(Number(v))}</strong></div>)}
    </div>
    {message&&<div role="status" className="fl-notice">{message}<button onClick={()=>setMessage("")} aria-label="Kapat">×</button></div>}
    {view==="fixture"&&<>
     <div className="fl-section-head">
      <div><h2>Sezon fikstürü</h2><p>Gerçek maç kayıtları · kaynaklara doğrudan bağlantı</p></div>
      <PartTabs value={mode} onChange={v=>{setMode(v);setPage(1);}}/>
     </div>
     <form className="fl-searchline" onSubmit={e=>{e.preventDefault();setPage(1);setQuery(search);}}>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Takım ara: Galatasaray, Bayern, Fenerbahçe…" aria-label="Takım ismi"/>
      <button type="submit">Ara</button>
      {query&&<button type="button" className="fl-clear" onClick={()=>{setSearch("");setQuery("");setPage(1);}}>Temizle</button>}
      <span className="fl-total">{fmt(list?.total||0)} maç</span>
     </form>
     {loading&&<div className="fl-empty">Sezon kayıtları yükleniyor…</div>}
     {!loading&&visible.length===0&&<div className="fl-empty">Bu filtre için kayıt yok. Başka lig veya maç durumu seç; veri kapsamını Veri merkezinden kontrol et.</div>}
     <div className="fl-games">
      {groupRows.map(({day,rows})=><section key={day}>
       <h3 className="fl-day">{local(day+"T12:00:00Z")} <small>{rows.length} KARŞILAŞMA</small></h3>
       {rows.map(g=><div key={g.id} className="fl-game">
        <div className="fl-hour">{local(g.kickoff_utc,"time")}<span>{g.competition_code}</span></div>
        <div className="fl-match-names">
         <Link href={"/takim/"+g.home_team_id}>{g.home_team}</Link>
         <div className="fl-match-v">—</div>
         <Link href={"/takim/"+g.away_team_id}>{g.away_team}</Link>
         <small>{g.stage||g.competition}</small>
        </div>
        <div className="fl-score">{g.status==="FINISHED"
          ?<><strong>{g.home_goals} : {g.away_goals}</strong><small>MAÇ SONU</small></>
          :<Signal status={g.status}/>}</div>
        <div className="fl-origin">
         <a href={g.source_url?.startsWith("https://")?g.source_url:"#"}
          target="_blank" rel="noopener noreferrer">{g.source_name||"Kaynak"} ↗</a>
         <small>{g.goal_timeline_verified?"Gol dakikaları ✓":g.has_detailed_stats?"Ayrıntılı veri ✓":"Skor / fikstür"}</small>
        </div>
       </div>)}
      </section>)}
     </div>
     {list&&list.pages>1&&<div className="fl-pagination">
      <button disabled={page<=1} onClick={()=>setPage(v=>v-1)}>← Önceki</button>
      <span>{page} / {list.pages} sayfa</span>
      <button disabled={page>=list.pages} onClick={()=>setPage(v=>v+1)}>Sonraki →</button>
     </div>}
    </>}
    {view==="analysis"&&<>
     <div className="fl-section-head"><div><h2>Kupon tasarım masası</h2><p>Olasılık hesabı ve kupon riski; kazanma garantisi değil.</p></div>
      <button className="fl-outline" onClick={testModel} disabled={testing}>{testing?"Test çalışıyor…":"Geçmiş doğruluğu ölç"}</button>
     </div>
     <div className="fl-controls">
      <label>Ortak başlama saati<select value={selectedSlot} onChange={e=>setKickoff(e.target.value)}>
       {!slots.length&&<option value="">Yeterli fikstür yok</option>}
       {slots.map(([s,rs])=><option key={s} value={s}>{s.slice(0,10)} · {s.slice(11)} · {rs.length} maç</option>)}
      </select></label>
      <label>Kupon uzunluğu<select value={picks} onChange={e=>setPicks(Number(e.target.value))}>
       {[2,3,4,5,6].map(n=><option key={n} value={n}>{n} maç</option>)}
      </select></label>
      <div className="fl-control-summary"><small>Birlikte gerçekleşme</small>
       <strong>{combined===null?"Yetersiz veri":pct(combined)}</strong></div>
     </div>
     {loading&&<div className="fl-empty">Olasılık matrisi hesaplanıyor…</div>}
     {!full&&<div className="fl-caution">Bu başlama saatinde {picks} kaliteli ve doğrulanmış geçmişe dayanan maç yok. Sistem boşluğu rastgele kuponlarla doldurmaz.</div>}
     <div className="fl-picks">
      {picked.map(({fixture:g,market:m},i)=><div className="fl-pick" key={g.fixture.id}>
       <span className="fl-pick-index">{String(i+1).padStart(2,"0")}</span>
       <div className="fl-pick-name"><small>{g.fixture.competition} · {local(g.fixture.kickoff,"time")}</small>
        <strong>{g.fixture.homeName} — {g.fixture.awayName}</strong>
        <small>Beklenen goller: {(g.profile.lambdaHome||0).toFixed(2)} / {(g.profile.lambdaAway||0).toFixed(2)}</small>
       </div>
       <label className="fl-pick-market">Bahis<select value={m.name}
        onChange={e=>setPreferred(o=>({...o,[g.fixture.id]:e.target.value}))}>
        {(g.profile.markets||[]).filter(v=>/^[OU][123]\.5$/.test(v.name))
          .map(v=><option key={v.name} value={v.name}>{v.name.replace("O","Üst ").replace("U","Alt ")} · {pct(v.conservative)}</option>)}
       </select></label>
       <div className="fl-pick-p"><strong>{pct(m.conservative)}</strong><small>Temkinli tahmin</small></div>
       <label className="fl-pick-odds">Gerçek oran<input inputMode="decimal" placeholder="1.45"
        value={odds[g.fixture.id]||""} onChange={e=>setOdds(o=>({...o,[g.fixture.id]:e.target.value.replace(",",".")}))}/></label>
      </div>)}
     </div>
     <div className="fl-risk">
      <div><small>Kuponun matematiksel birleşik ihtimali</small><strong>{combined===null?"—":pct(combined)}</strong></div>
      <div><small>Modelin adil oranı</small><strong>{combined? (1/combined).toFixed(2):"—"}</strong></div>
      <div><small>Gerçek toplam oran</small><strong>{totalOdds?totalOdds.toFixed(2):"Oran girilmeli"}</strong></div>
      <div><small>Beklenen değer (EV)</small><strong>{ev===null?"—":(ev>=0?"+":"")+pct(ev)}</strong></div>
     </div>
     <label className="fl-stake">Varsayımsal kupon bedeli (TL)
       <input type="number" inputMode="decimal" min="0" step="1" placeholder="Tutar gir"
       value={stake} onChange={e=>setStake(e.target.value)}/>
       <span>Hepsi tutarsa brüt ödeme: <strong>{paid===null?"—":paid.toLocaleString("tr-TR",{style:"currency",currency:"TRY"})}</strong></span>
     </label>
     <div className="fl-detail-head"><h2>Tek maç analizleri</h2><p>Skor dağılımını ayrıntılı incele.</p></div>
     <div className="fl-reports">
      {(slots.find(s=>s[0]===selectedSlot)?.[1]||[]).map(g=><div className="fl-report" key={g.fixture.id}>
       <button onClick={()=>setDetails(o=>({...o,[g.fixture.id]:!o[g.fixture.id]}))} aria-expanded={!!details[g.fixture.id]}>
        <span>{g.fixture.homeName} — {g.fixture.awayName}<small>{g.profile.status==="READY"?
         "Geçmiş "+g.profile.samples?.league+" lig maçı · 10.000 skor simülasyonu":g.profile.reason||"Veri eksik"}</small></span>
        <strong>{g.profile.status==="READY"?pct(g.profile.markets?.find(m=>m.name==="O2.5")?.probability||0):"Veri yok"}</strong>
        <span>{details[g.fixture.id]?"−":"+"}</span>
       </button>
       {!!details[g.fixture.id]&&g.profile.status==="READY"&&<div className="fl-report-body">
        <div className="fl-score-grid">{g.simulations?.scores.slice(0,8).map(s=>
         <span key={s.score}><b>{s.score}</b><small>{pct(s.count/(g.simulations?.iterations||10000))}</small></span>)}</div>
        <div className="fl-market-grid">{(g.profile.markets||[]).slice(0,12).map(m=>
         <span key={m.name}>{m.name}<b>{pct(m.probability)}</b></span>)}</div>
        <small>Model belirsizlikleri, sakatlık ve kadro haberlerinin doğrulanmadığı durumlar ayrıca risk yaratır.</small>
       </div>}
      </div>)}
     </div>
     {backtest&&<section className="fl-backtest">
      <h2>Geçmiş sonuçlarla test</h2>
      <p>{backtest.total} tarihsel maç · test dönemi öncesindeki verilerle değerlendirme</p>
      <div className="fl-numbers">
       {[["1X2 isabet",backtest.total?pct(backtest.winnerAccuracy||0):"—"],
         ["2,5 gol isabet",backtest.total?pct(backtest.over25Accuracy||0):"—"],
         ["Brier",backtest.total?backtest.totalBrier?.toFixed(3):"—"],
         ["Basit referans",backtest.total?backtest.baselineBrier?.toFixed(3):"—"]].map(([a,b])=>
         <div className="fl-number" key={String(a)}><small>{a}</small><strong>{b||"—"}</strong></div>)}
      </div>
      <p className="fl-warning">Sınırlı örneklem veya referanstan kötü sonuç, modelin yüksek doğruluğunun kanıtlanmadığını gösterir.</p>
     </section>}
    </>}
    {view==="sources"&&<>
     <div className="fl-section-head"><div><h2>Veri kapsamı</h2><p>Sezon kayıtları, gol dakikaları, detay istatistikleri ve sağlayıcı durumu</p></div>
      <button className="fl-outline" onClick={importSeason} disabled={busy}>{busy?"Eşitleniyor":"Kaynak taramasını başlat"}</button>
     </div>
     <div className="fl-coverage-head"><span>LİG / KAYNAK</span><span>TOPLAM</span><span>MS</span><span>GOL OLAYI</span><span>DETAY</span></div>
     <div className="fl-coverage">
      {leagues.map(l=><div className="fl-coverage-row" key={l.code}>
       <span><strong>{knownLeagues[l.code]||l.name}</strong><small>{l.country} · {l.code}</small></span>
       <b>{fmt(l.fixtures)}</b><b>{fmt(l.finished)}</b>
       <b>{fmt(l.goals_verified)}</b><b>{fmt(l.detailed_stats)}</b>
      </div>)}
     </div>
     <div className="fl-detail-head"><h2>Aktarım geçmişi</h2><p>Hangi sağlayıcıda hangi hafta veya sezon bölümü kontrol edildi?</p></div>
     <div className="fl-progress-list">
      {(coverage?.progress||[]).map(p=><div className="fl-progress" key={p.provider+"/"+p.competition_code+"/"+p.part_key}>
       <div><strong>{p.competition_code} <span>· {p.provider}</span></strong>
        <small>{p.part_key} · işlenen adım {p.cursor_index} · {fmt(p.imported)} kayıt</small>
        {p.error&&<small className="fl-error">{p.error}</small>}</div>
       <Signal status={p.state}/>
      </div>)}
      {!(coverage?.progress||[]).length&&<div className="fl-empty">Henüz bu sürümde kaynak aktarımı kaydedilmedi. Veri eşitlemeyi başlat.</div>}
     </div>
    </>}
   </main>
  </div>
  <footer className="fl-footer"><span>FİKSTÜR/LAB · 2026–27</span>
   <span>Resmî kaynaklar öncelikli · Kaynaklı istatistikler · Tahminler kesinlik içermez</span>
   <Link href="/akilli-kupon">Model V4 →</Link></footer>
 </div>;
}
