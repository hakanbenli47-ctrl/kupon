"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type MarketName="1"|"X"|"2"|"1X"|"X2"|"12"|"O1.5"|"U1.5"|"O2.5"|"U2.5"|"O3.5"|"U3.5"|"BTTS_Y"|"BTTS_N";
type Projection={name:MarketName;probability:number;conservative:number};
type Game={
 fixture:{id:number;competition:string;kickoff:string;homeId:number;awayId:number;homeName:string;awayName:string;source:string;sourceCheckedAt:string};
 sameTimeSlot:string|null;
 profile:{status:"READY"|"INSUFFICIENT";reason?:string;lambdaHome?:number;lambdaAway?:number;quality?:number;
 samples?:{home:number;away:number;homeVenue:number;awayVenue:number;league:number;xg:number};
 sources?:{scores:boolean;xg:boolean;goalMinutes:boolean};
 markets?:Projection[];scores?:Array<{score:string;probability:number}>;modelVersion:string};
 simulations?:{iterations:number;scores:Array<{score:string;count:number}>;markets:Record<string,number>}|null;
};
type Data={modelVersion:string;generatedAt:string;fixtures:Game[];
 coverage:Array<{competition:string;played:number;ready:number;waiting:number;xgMatches:number}>};
type TestData={total:number;totalBrier:number|null;baselineBrier:number|null;totalLogLoss:number|null;totalOver25Brier:number|null;winnerAccuracy:number|null;baselineAccuracy:number|null;over25Accuracy:number|null;leagues:Array<{
 competition:string;count:number;brier:number;baselineBrier:number;logLoss:number;over25Brier:number;winnerAccuracy:number;baselineAccuracy:number;over25Accuracy:number;validated:boolean;beatsNaiveBaseline:boolean
}>};
const names:Record<string,string>={
 TSL:"Türkiye Süper Lig",T1:"Türkiye 1. Lig",T2:"Türkiye 2. Lig",T3:"Türkiye 3. Lig",
 BL:"Bundesliga",BL2:"2. Bundesliga",BL3:"3. Liga",PL:"Premier Lig",LL:"La Liga",
 SA:"Serie A",CL:"Şampiyonlar Ligi",EL:"Avrupa Ligi",ECL:"Konferans Ligi",
};
const markets:MarketName[]=["O1.5","U1.5","O2.5","U2.5","O3.5","U3.5","1X","X2","12","1","X","2","BTTS_Y","BTTS_N"];
const label=(key:MarketName)=>({
 "O1.5":"1,5 Üst","U1.5":"1,5 Alt","O2.5":"2,5 Üst","U2.5":"2,5 Alt",
 "O3.5":"3,5 Üst","U3.5":"3,5 Alt","1":"MS 1","X":"MS X","2":"MS 2",
 "1X":"1X","X2":"X2","12":"12","BTTS_Y":"KG Var","BTTS_N":"KG Yok",
} as Record<MarketName,string>)[key];
const percent=(p:number)=>"%"+(100*p).toFixed(1).replace(".",",");
const money=(n:number)=>n.toLocaleString("tr-TR",{style:"currency",currency:"TRY"});
const localDate=(s:string)=>{
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(s));
 const v=(key:string)=>parts.find(x=>x.type===key)?.value||"";
 return v("year")+"-"+v("month")+"-"+v("day");
};
const localTime=(s:string)=>new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date(s));
const ci=(a:string,b:string)=>a.localeCompare(b,"tr");
const goalMarkets=new Set(["O1.5","U1.5","O2.5","U2.5","O3.5","U3.5"]);
export default function EnginePage(){
 const [data,setData]=useState<Data|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [reload,setReload]=useState(0);
 const [league,setLeague]=useState("ALL");
 const [date,setDate]=useState("");
 const [slot,setSlot]=useState("");
 const [length,setLength]=useState(5);
 const [kind,setKind]=useState("GOALS");
 const [odds,setOdds]=useState<Record<string,string>>({});
 const [choices,setChoices]=useState<Record<number,MarketName>>({});
 const [stake,setStake]=useState("");
 const [notice,setNotice]=useState("");
 const [importing,setImporting]=useState(false);
 const [test,setTest]=useState<TestData|null>(null);
 const [testing,setTesting]=useState(false);
 const [showDetails,setShowDetails]=useState<Record<number,boolean>>({});
 const warmedUp=useRef(false);
 const fetchData=useCallback(async()=>{
   setLoading(true);
   try{
     const response=await fetch("/api/v4?days=31",{cache:"no-store"});
     if(!response.ok)throw Error((await response.json()).error||"Analiz verileri alınamadı");
     setData(await response.json() as Data);
     setError("");
   }catch(e){setError(e instanceof Error?e.message:"Veri hatası");}
   finally{setLoading(false);}
 },[]);
 useEffect(()=>{void fetchData();},[fetchData,reload]);
 useEffect(()=>{
   if(!data||warmedUp.current)return;
   warmedUp.current=true;
   if(data.fixtures.length===0||data.fixtures.some(g=>g.profile.status==="READY"))return;
   // One cautious first-load history fetch; the scheduled cron continues from saved cursors.
   void fetch("/api/history-backfill",{
     method:"POST",headers:{"Content-Type":"application/json"},body:"{}"
   }).then(response=>response.ok?response.json():null).then(value=>{
     if(value&&!value.skipped)setReload(n=>n+1);
   }).catch(()=>{});
 },[data]);
 useEffect(()=>{
  const timer=window.setInterval(()=>setReload(x=>x+1),120000);
  return ()=>window.clearInterval(timer);
 },[]);
 const games=useMemo(()=>(data?.fixtures||[]).filter(g=>league==="ALL"||g.fixture.competition===league),[data,league]);
 const dates=useMemo(()=>[...new Set(games.map(g=>localDate(g.fixture.kickoff)))].sort(),[games]);
 const validForCoupon=(g:Game)=>g.profile.status==="READY" &&
   Number(g.profile.quality)>=0.59 && Boolean(g.profile.markets?.some(p=>
     (kind!=="GOALS"||goalMarkets.has(p.name)) && p.conservative>=0.62));
 const dayScore=(d:string)=>{
   const grouped=new Map<string,number>();
   for(const g of games){
     if(localDate(g.fixture.kickoff)!==d||!g.sameTimeSlot||!validForCoupon(g))continue;
     grouped.set(g.sameTimeSlot,(grouped.get(g.sameTimeSlot)||0)+1);
   }
   return Math.max(0,...grouped.values());
 };
 const bestDate=dates.slice().sort((a,b)=>{
   const aCount=dayScore(a),bCount=dayScore(b);
   return Number(bCount>=length)-Number(aCount>=length)||bCount-aCount||a.localeCompare(b);
 })[0]||"";
 const pickedDate=(date&&dates.includes(date)?date:bestDate)||"";
 const onDate=games.filter(g=>localDate(g.fixture.kickoff)===pickedDate);
 const timeSlots=[...new Set(onDate.map(g=>g.sameTimeSlot).filter((x):x is string=>Boolean(x)))].sort();
 const bestSlot=timeSlots.slice().sort((a,b)=>{
   const av=onDate.filter(g=>g.sameTimeSlot===a&&validForCoupon(g)).length;
   const bv=onDate.filter(g=>g.sameTimeSlot===b&&validForCoupon(g)).length;
   return Number(bv>=length)-Number(av>=length)||bv-av||a.localeCompare(b);
 })[0]||"";
 const visibleSlot=slot&&timeSlots.includes(slot)?slot:bestSlot;
 const sameTime=onDate.filter(g=>g.sameTimeSlot===visibleSlot);
 const useful=useMemo(()=>sameTime.flatMap(g=>{
  if(g.profile.status!=="READY"||!g.profile.markets||Number(g.profile.quality)<0.59)return [];
  const allowed=g.profile.markets.filter(p=>kind==="GOALS"?goalMarkets.has(p.name):true);
  const best=allowed.find(p=>p.conservative>=0.62);
  if(!best)return [];
  const chosen=allowed.find(p=>p.name===choices[g.fixture.id])||best;
  return [{g,p:chosen}];
 }).sort((a,b)=>b.p.conservative-a.p.conservative),[sameTime,kind,choices]);
 const selected=useful.slice(0,length);
 const complete=selected.length===length;
 const joint=complete?selected.reduce((v,{p})=>v*p.conservative,1):null;
 const selectedOdds=selected.map(({g,p})=>Number((odds[g.fixture.id+":"+p.name]||"").replace(",",".")));
 const validOdds=complete&&selectedOdds.every(o=>o>1&&Number.isFinite(o));
 const combinedOdds=validOdds?selectedOdds.reduce((v,n)=>v*n,1):null;
 const expectedValue=joint!==null&&combinedOdds!==null?joint*combinedOdds-1:null;
 const stakeValue=Number(stake);
 const payment=combinedOdds!==null && stakeValue>0 && Number.isFinite(stakeValue)?combinedOdds*stakeValue:null;
 const haveReady=games.filter(g=>g.profile.status==="READY").length;
 async function refreshHistory(){
  setImporting(true);setNotice("");
  try{
   const response=await fetch("/api/history-backfill",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({league:league==="ALL"?undefined:league})});
   const value=await response.json() as {ok:boolean;skipped?:boolean;history?:{league?:string;scanned?:number;stored?:number;goalsSaved?:number;error?:string};error?:string};
   if(!response.ok||!value.ok)throw Error(value.error||"Veri aktarımı başarısız");
   setNotice(value.skipped?"Veri aktarımı yakın zamanda kontrol edilmiş.":
     "Kaynak: "+(value.history?.league||"otomatik")+" · taranan "+(value.history?.scanned||0)+
     " maç · kaydedilen "+(value.history?.stored||0)+
     (value.history?.error?" · hata: "+value.history.error:""));
   setReload(x=>x+1);
  }catch(e){setNotice(e instanceof Error?e.message:"Veri alınamadı");}
  finally{setImporting(false);}
 }
 async function runBacktest(){
  setTesting(true);setTest(null);
  try{
   const response=await fetch("/api/v4/backtest?league="+encodeURIComponent(league),{cache:"no-store"});
   if(!response.ok)throw Error("Geriye dönük test başarısız.");
   setTest(await response.json() as TestData);
  }catch(e){setNotice(e instanceof Error?e.message:"Backtest hatası");}
  finally{setTesting(false);}
 }
 return <main className="mx-auto max-w-7xl px-4 py-7 text-[#142b23] md:px-7">
  <header className="flex flex-wrap items-start justify-between gap-4">
   <div>
    <Link href="/" className="text-sm font-semibold text-[#176b45]">← Ana sayfa</Link>
    <div className="mt-3 text-xs font-extrabold uppercase tracking-[0.2em] text-[#176b45]">İstatistiksel karar laboratuvarı</div>
    <h1 className="mt-1 text-3xl font-bold tracking-tight md:text-5xl">Kupon Motoru V4</h1>
    <p className="mt-3 max-w-3xl text-sm text-[#65786f]">
     Tamamen yeni skor modeli · her maçta 10.000 simülasyon · geçmiş sonuçlarla test · aynı tarih ve aynı saat.
     Kesin sonuç veya yüksek isabet garantisi yoktur.
    </p>
   </div>
   <div className="flex flex-wrap gap-2">
    <button type="button" disabled={importing} onClick={refreshHistory}
      className="rounded-xl border border-[#ccd8d1] bg-white px-4 py-3 text-sm font-semibold disabled:opacity-50">
     {importing?"Veriler doğrulanıyor…":"Geçmiş maçları yenile"}
    </button>
    <button type="button" onClick={()=>setReload(x=>x+1)}
      className="rounded-xl bg-[#176b45] px-4 py-3 text-sm font-semibold text-white">Modeli yeniden hesapla</button>
   </div>
  </header>
  {notice&&<p role="status" className="my-5 rounded-xl bg-[#e5f1e8] p-4 text-sm">{notice}</p>}
  {error&&<p role="alert" className="my-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p>}
  <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
   {[
     ["Gelecek maç",data?.fixtures.length??"—"],
     ["Modeli hazır",data?.fixtures.filter(g=>g.profile.status==="READY").length??"—"],
     ["Verisi yetersiz",data?.fixtures.filter(g=>g.profile.status!=="READY").length??"—"],
     ["Simülasyon", "10.000 / maç"],
   ].map(([k,v])=><div className="rounded-xl border border-[#dbe5dd] bg-white p-4" key={k}>
    <div className="text-xs text-[#708076]">{k}</div>
    <div className="mt-2 text-2xl font-extrabold">{v}</div>
   </div>)}
  </div>
  <section className="mt-5 grid gap-3 rounded-2xl border border-[#dbe5dd] bg-white p-4 md:grid-cols-5">
   <label className="grid gap-2 text-xs font-semibold">Lig
    <select value={league} onChange={e=>{setLeague(e.target.value);setDate("");setSlot("");setTest(null);}}
     className="rounded-lg border border-[#ccd8d1] bg-white p-3 text-sm">
     <option value="ALL">Tüm ligler</option>
     {Object.keys(names).sort(ci).map(k=><option key={k} value={k}>{names[k]}</option>)}
    </select>
   </label>
   <label className="grid gap-2 text-xs font-semibold">Maç günü
    <select value={pickedDate} onChange={e=>{setDate(e.target.value);setSlot("");}}
      className="rounded-lg border border-[#ccd8d1] bg-white p-3 text-sm">
      {dates.length===0&&<option value="">Fikstür yok</option>}
      {dates.map(k=><option key={k} value={k}>{k}</option>)}
    </select>
   </label>
   <label className="grid gap-2 text-xs font-semibold">Aynı başlama saati (TR)
    <select value={visibleSlot} onChange={e=>setSlot(e.target.value)}
      className="rounded-lg border border-[#ccd8d1] bg-white p-3 text-sm">
      {timeSlots.length===0&&<option value="">Saat bulunamadı</option>}
      {timeSlots.map(k=><option key={k} value={k}>{k.slice(11)} · {onDate.filter(g=>g.sameTimeSlot===k).length} maç</option>)}
    </select>
   </label>
   <label className="grid gap-2 text-xs font-semibold">Piyasa
    <select value={kind} onChange={e=>setKind(e.target.value)}
     className="rounded-lg border border-[#ccd8d1] bg-white p-3 text-sm">
     <option value="GOALS">Alt / Üst</option><option value="ALL">Bütün piyasalar</option>
    </select>
   </label>
   <label className="grid gap-2 text-xs font-semibold">Kupon uzunluğu
    <select value={length} onChange={e=>setLength(Number(e.target.value))}
      className="rounded-lg border border-[#ccd8d1] bg-white p-3 text-sm">
     {[2,3,4,5,6].map(n=><option key={n} value={n}>{n} maç</option>)}
    </select>
   </label>
  </section>
  <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(290px,1fr)]">
   <section className="rounded-2xl border border-[#dbe5dd] bg-white p-4 md:p-6">
    <h2 className="text-xl font-bold">Modelin aynı saat kuponu</h2>
    <p className="mt-1 text-xs text-[#65786f]">{pickedDate||"Tarih yok"} · {visibleSlot?visibleSlot.slice(11)+" Türkiye saati":"Maç saati bulunamadı"} · Seçimler geçmiş veriye göre sıralanır.</p>
    {loading&&!data&&<p role="status" className="py-6">Maç geçmişi hesaplanıyor…</p>}
    {data&&!complete&&<p className="mt-4 rounded-xl bg-[#f5f1e7] p-4 text-sm">
      Bu saat için {length} yeterli veri ve risk eşiğine sahip karşılaşma bulunamadı.
      {useful.length>0?" İncelenebilen maç sayısı: "+useful.length+".":""}
      Farklı saat, gün veya daha az maç seçebilirsin; eksik maç otomatik eklenmez.
    </p>}
    <div className="mt-4 space-y-3">
     {selected.map(({g,p})=><article key={g.fixture.id} className="rounded-xl border border-[#e1e9e3] p-4">
      <div className="flex items-start justify-between gap-4">
       <div className="min-w-0">
        <p className="text-xs text-[#677a6f]">{names[g.fixture.competition]||g.fixture.competition} · {localTime(g.fixture.kickoff)}</p>
        <p className="mt-1 font-bold">
         <Link className="underline decoration-[#b6c7b9]" href={"/takim/"+g.fixture.homeId}>{g.fixture.homeName}</Link>
         {" – "}
         <Link className="underline decoration-[#b6c7b9]" href={"/takim/"+g.fixture.awayId}>{g.fixture.awayName}</Link>
        </p>
       </div>
       <div className="text-right"><div className="text-xl font-extrabold">{percent(p.conservative)}</div>
        <div className="text-[11px] text-[#677a6f]">Temkinli model</div>
       </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
       <label className="flex items-center gap-2 text-xs font-semibold">Seçim
        <select className="rounded-lg border border-[#cbd8cf] p-2" value={p.name}
         onChange={e=>setChoices(old=>({...old,[g.fixture.id]:e.target.value as MarketName}))}>
         {markets.filter(name=>kind!=="GOALS"||goalMarkets.has(name))
           .map(name=><option key={name} value={name}>{label(name)}</option>)}
        </select>
       </label>
       <label className="flex items-center gap-2 text-xs font-semibold">Gerçek bahis oranı
        <input type="text" inputMode="decimal" placeholder="Örn. 1,42"
         value={odds[g.fixture.id+":"+p.name]||""}
         onChange={e=>setOdds(old=>({...old,[g.fixture.id+":"+p.name]:e.target.value}))}
         className="w-24 rounded-lg border border-[#cbd8cf] p-2"/>
       </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 border-t border-[#e1e9e3] pt-3 text-xs text-[#586f60]">
       <span>Ham model {percent(p.probability)}</span>
       <span>Veri kapsamı puanı {percent(g.profile.quality??0)}</span>
       <span>Beklenen gol {(g.profile.lambdaHome??0).toFixed(2)} – {(g.profile.lambdaAway??0).toFixed(2)}</span>
      </div>
     </article>)}
    </div>
   </section>
   <aside className="space-y-4">
    <section className="rounded-2xl bg-[#123a2b] p-5 text-white">
     <h2 className="text-lg font-bold">Kupon risk analizi</h2>
     <p className="mt-4 text-xs text-[#b6d2c2]">Bütün maçların birlikte gelme ihtimali</p>
     <div className="mt-1 text-5xl font-black">{joint===null?"—":percent(joint)}</div>
     <div className="mt-4 h-3 overflow-hidden rounded-full bg-[#2f6650]">
      <div className="h-full bg-[#dbed8a]" style={{width:((joint||0)*100)+"%"}}/>
     </div>
     <p className="mt-3 text-xs text-[#c6dccf]">
      {joint===null?"Geçerli kupon oluşturulmadı.": "Bağımsız maç varsayımıyla kaybetme olasılığı "+percent(1-joint)+". Tahmin hataları birlikte ortaya çıkabilir."}
     </p>
    </section>
    <section className="rounded-2xl border border-[#dbe5dd] bg-white p-5">
     <h2 className="text-lg font-bold">Piyasa değeri</h2>
     <p className="mt-1 text-xs text-[#65786f]">Oranlar canlı çekilmez. Girilmediyse kârlılık tahmini yapılmaz.</p>
     <div className="mt-4 space-y-3 text-sm">
      <div className="flex justify-between"><span>Modelin adil oranı</span><strong>{joint?(1/joint).toFixed(2):"—"}</strong></div>
      <div className="flex justify-between"><span>Gerçek toplam oran</span><strong>{combinedOdds?combinedOdds.toFixed(2):"—"}</strong></div>
      <div className="flex justify-between"><span>Beklenen değer (EV)</span><strong className={expectedValue!==null&&expectedValue<0?"text-red-700":"text-[#176b45]"}>
       {expectedValue===null?"Oran eksik":(expectedValue>0?"+":"")+percent(expectedValue)}
      </strong></div>
     </div>
     <label className="mt-5 grid gap-2 text-xs font-semibold">Varsayımsal kupon tutarı (TL)
      <input type="number" min="0" step="1" value={stake} onChange={e=>setStake(e.target.value)}
       placeholder="Örn. 100" className="rounded-lg border border-[#cbd8cf] p-3 text-sm"/>
     </label>
     <p className="mt-3 text-sm">Hepsi tutarsa brüt ödeme: <strong>{payment===null?"—":money(payment)}</strong></p>
     <p className="mt-3 text-xs text-[#65786f]">Pozitif EV garanti değildir; model geçmiş testlerde doğrulanmadan parayla risk almak için güvenilir sayılmaz.</p>
    </section>
   </aside>
  </div>
  <section className="mt-6 rounded-2xl border border-[#dbe5dd] bg-white p-5">
   <div className="flex flex-wrap items-start justify-between gap-3">
    <div><h2 className="text-xl font-bold">Maç bazında 10.000 skor simülasyonu</h2>
     <p className="mt-1 text-sm text-[#63776b]">Skor, 1X2, alt/üst, KG; bütün sonuçlar aynı olasılık matrisinden gelir.</p></div>
    <p className="text-xs text-[#63776b]">{onDate.length} maç · hazır {onDate.filter(x=>x.profile.status==="READY").length}</p>
   </div>
   {onDate.length===0&&<p className="mt-4 text-sm">Bu gün için fikstür bulunamadı. Tarihi veya ligi değiştir.</p>}
   <div className="mt-4 divide-y divide-[#e8eee9]">
    {onDate.map(g=>{
     const isOpen=Boolean(showDetails[g.fixture.id]);
     const p=g.profile;
     const pm=(k:MarketName)=>p.markets?.find(m=>m.name===k);
     return <article key={g.fixture.id} className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
       <div><p className="text-xs text-[#617469]">{names[g.fixture.competition]||g.fixture.competition} · {localTime(g.fixture.kickoff)}</p>
        <h3 className="mt-1 font-semibold">{g.fixture.homeName} – {g.fixture.awayName}</h3>
       </div>
       <div className="flex flex-wrap items-center gap-3">
        {p.status==="READY"&&<span className="text-sm font-bold text-[#176b45]">2,5 Üst {percent(pm("O2.5")?.probability||0)}</span>}
        {p.status!=="READY"&&<span className="text-xs text-[#8e6730]">Veri eksik</span>}
        <button type="button" onClick={()=>setShowDetails(old=>({...old,[g.fixture.id]:!isOpen}))}
         className="rounded-lg border border-[#cbd8cf] px-3 py-2 text-xs font-semibold">{isOpen?"Kapat":"Detayları aç"}</button>
       </div>
      </div>
      {p.status!=="READY"&&<p className="mt-2 text-xs text-[#8e6730]">{p.reason}</p>}
      {isOpen&&p.status==="READY"&&<div className="mt-4 space-y-4 rounded-xl bg-[#f5f8f5] p-4">
       <p className="text-sm">Beklenen gol: <strong>{p.lambdaHome?.toFixed(2)} / {p.lambdaAway?.toFixed(2)}</strong>.
        Örneklem: {p.samples?.home} / {p.samples?.away} takım maçı · {p.samples?.league} lig maçı.
        {p.sources?.xg?" xG verisi de kullanıldı.":" Yeterli xG verisi yok, skor ağırlıklı model."}
       </p>
       <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(["1","X","2","1X","X2","O1.5","O2.5","U2.5","O3.5","BTTS_Y","BTTS_N"] as MarketName[])
         .map(key=><div key={key} className="rounded-lg border border-[#dfebe2] bg-white p-3 text-sm">
          <div className="text-xs text-[#66796d]">{label(key)}</div>
          <strong>{percent(pm(key)?.probability||0)}</strong>
         </div>)}
       </div>
       <p className="text-xs font-semibold">En olası skorlar</p>
       <div className="flex flex-wrap gap-2">{g.simulations?.scores.slice(0,6).map(s=>
        <div key={s.score} className="rounded-lg bg-white px-3 py-2 text-sm">{s.score} <strong>{percent(s.count/10000)}</strong></div>)}</div>
       <p className="text-xs text-[#65786f]">10.000 rastgele senaryo, modelin tahmini dağılımını örnekler. Tek başına doğruluk kanıtı değildir.</p>
      </div>}
     </article>;
    })}
   </div>
  </section>
  <section className="mt-6 rounded-2xl border border-[#dbe5dd] bg-white p-5">
   <div className="flex flex-wrap justify-between gap-4">
    <div><h2 className="text-xl font-bold">Gerçek doğruluk testi</h2>
     <p className="mt-1 max-w-xl text-sm text-[#65786f]">Yalnızca test maçından önce oynanmış karşılaşmalar kullanılır. Brier skoru ne kadar düşükse o kadar iyidir.</p></div>
    <button type="button" disabled={testing} onClick={runBacktest}
     className="rounded-xl bg-[#123a2b] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
      {testing?"Geçmiş maçlarla karşılaştırılıyor…":"Geriye dönük testi çalıştır"}
    </button>
   </div>
   {test&&<div className="mt-5">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
     {[
      ["Test maçı",String(test.total)],
      ["Brier",test.total?test.totalBrier?.toFixed(3)||"—":"Yetersiz"],
      ["Basit referans",test.total?test.baselineBrier?.toFixed(3)||"—":"Yetersiz"],
      ["MS 1X2 isabeti",test.total?percent(test.winnerAccuracy??0):"Yetersiz"],
      ["MS referans isabeti",test.total?percent(test.baselineAccuracy??0):"Yetersiz"],
      ["2,5 alt/üst isabeti",test.total?percent(test.over25Accuracy??0):"Yetersiz"],
      ["Ortalama log loss",test.total?test.totalLogLoss?.toFixed(3)||"—":"Yetersiz"],
     ].map(([key,value])=><div key={key} className="rounded-xl bg-[#eff5ef] p-4">
      <div className="text-xs text-[#65786f]">{key}</div><div className="mt-2 text-xl font-bold">{value}</div>
     </div>)}
    </div>
    <div className="mt-3 divide-y divide-[#e7ece7]">
     {test.leagues.map(x=><div key={x.competition} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
      <strong>{names[x.competition]||x.competition} · {x.count} maç</strong>
      <span>{x.count?"Brier "+x.brier.toFixed(3)+" / referans "+x.baselineBrier.toFixed(3):"Test verisi yok"} · {x.validated?(x.beatsNaiveBaseline?"Referanstan iyi":"Referanstan iyi değil"):"Güvenilir örneklem yetersiz"}</span>
     </div>)}
    </div>
    <p className="mt-3 text-xs text-[#677b6e]">Bu test gelecekteki sonuçları garanti etmez. Sağlayıcı kapsamı sınırlı liglerde güvenilir bir isabet oranı iddia edilmez.</p>
   </div>}
  </section>
  <footer className="my-7 text-xs text-[#677b6e]">
   Motor V4.0 · Poisson + düşük skor bağımlılığı · iç/deplasman gücü · zaman ağırlığı · veri yetersizliğinde tahmin yok.
   Takım kadro/haber/sakatlık bilgisi doğrulanmadıkça modelde kullanılmaz. Gerçek oran olmadan değer avantajı iddia edilmez.
  </footer>
 </main>;
}
