"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type Goal={scoring_team_id:number;minute:number;added_time:number;player_name:string|null;is_own_goal:number;is_penalty:number};
type Match={id:number;kickoff_utc:string;home_team:string;away_team:string;home_team_id:number;away_team_id:number;home_goals:number;away_goals:number;scored:number;conceded:number;venue:string;competition:string;source_url:string;source_name:string;goals:Goal[]|null;home_shots:number|null;away_shots:number|null;home_shots_on_target:number|null;away_shots_on_target:number|null;home_corners:number|null;away_corners:number|null;home_xg:number|null;away_xg:number|null;home_possession:number|null;away_possession:number|null};
type Profile={team:{id:number;name:string};summary:{played:number;wins:number;draws:number;losses:number;goalsFor:number;goalsAgainst:number;verifiedGoalMinuteMatches:number;statMatches:number};matches:Match[]};
const formatDate=(s:string)=>new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(s));
export default function TeamProfile(){
  const {id}=useParams<{id:string}>();
  const [data,setData]=useState<Profile|null>(null);
  const [error,setError]=useState("");
  const [more,setMore]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    fetch("/api/team/"+encodeURIComponent(id),{cache:"no-store",signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw Error("Takım geçmişi alınamadı.");
        return response.json() as Promise<Profile>;
      }).then(setData).catch(e=>{if(!controller.signal.aborted)setError(String(e));});
    return()=>controller.abort();
  },[id]);
  const s=data?.summary;
  return <main className="mx-auto max-w-5xl px-4 py-8 text-[#12251a]">
    <Link href="/akilli-kupon" className="text-sm font-semibold text-[#176b45]">← Akıllı Kupon Laboratuvarı</Link>
    <h1 className="mt-4 text-3xl font-bold">{data?.team.name||"Takımın maç geçmişi"}</h1>
    <p className="mt-2 text-sm text-[#55675b]">Kaynağı doğrulanmış sonuçlar gösterilir. Gol dakikaları veya ayrıntılı istatistikler yoksa tahmin edilmez.</p>
    {error&&<p role="alert" className="my-5 text-red-700">{error}</p>}
    {!data&&!error&&<p className="my-5">Geçmiş karşılaşmalar yükleniyor…</p>}
    {s&&<div className="my-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      {[
        ["Oynadığı maç",s.played],["Galibiyet",s.wins],["Beraberlik",s.draws],
        ["Mağlubiyet",s.losses],["Attığı gol",s.goalsFor],["Yediği gol",s.goalsAgainst],
        ["Gol dakikası tam",s.verifiedGoalMinuteMatches+"/"+s.played],
        ["Ayrıntılı istatistik",s.statMatches+"/"+s.played],
      ].map(([label,value])=><div key={label} className="rounded-xl border border-[#dce2dc] bg-white p-4">
        <div className="text-xs text-[#5e7165]">{label}</div><div className="mt-2 text-xl font-bold">{value}</div>
      </div>)}
    </div>}
    <h2 className="mb-4 mt-6 text-xl font-bold">Maç maç sonuçlar ve goller</h2>
    <div className="space-y-3">
      {data?.matches.slice(0,more?200:25).map(m=><article key={m.id} className="rounded-xl border border-[#dce2dc] bg-white p-4">
        <div className="flex flex-wrap justify-between gap-2">
          <div><div className="text-xs text-[#66776d]">{m.competition} · {formatDate(m.kickoff_utc)} · {m.venue}</div>
            <h3 className="mt-1 font-bold">{m.home_team} {m.home_goals} – {m.away_goals} {m.away_team}</h3></div>
          <div className="text-sm font-semibold">{m.scored>m.conceded?"Galibiyet":m.scored===m.conceded?"Beraberlik":"Mağlubiyet"}</div>
        </div>
        {m.goals===null
          ?<div className="mt-2 text-xs text-[#7c6759]">Gol dakikaları kaynaktan doğrulanamadı.</div>
          :<div className="mt-2 text-xs text-[#176b45]">
            {m.goals.length?m.goals.map((g,i)=><span key={i} className="mr-3 inline-block">
              {g.minute}{g.added_time?"+"+g.added_time:""}′ · {g.scoring_team_id===m.home_team_id?m.home_team:m.away_team}
              {g.player_name?" · "+g.player_name:""}{g.is_own_goal?" (K.K.)":""}{g.is_penalty?" (P)":""}
            </span>):"Doğrulanmış gol olayı yok (0-0)."}
          </div>}
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-[#56675d]">
          {m.home_shots!==null&&m.away_shots!==null&&<span>Şut: {m.home_shots}–{m.away_shots}</span>}
          {m.home_shots_on_target!==null&&m.away_shots_on_target!==null&&<span>İsabetli şut: {m.home_shots_on_target}–{m.away_shots_on_target}</span>}
          {m.home_corners!==null&&m.away_corners!==null&&<span>Korner: {m.home_corners}–{m.away_corners}</span>}
          {m.home_xg!==null&&m.away_xg!==null&&<span>xG: {m.home_xg}–{m.away_xg}</span>}
          {m.home_possession!==null&&m.away_possession!==null&&<span>Topa sahip olma: %{m.home_possession}–%{m.away_possession}</span>}
        </div>
        {m.source_url?.startsWith("https://")&&<a className="mt-3 inline-block text-xs text-[#176b45] underline" href={m.source_url} rel="noopener noreferrer" target="_blank">Maç veri kaynağı</a>}
      </article>)}
    </div>
    {(data?.matches.length||0)>25&&<button onClick={()=>setMore(v=>!v)} className="my-4 rounded-lg border border-[#bfd0c4] bg-white px-4 py-3 text-sm font-semibold">{more?"Daha az göster":"Tüm geçmişi göster"}</button>}
    {data&&data.matches.length===0&&<p>Bu takımın doğrulanmış maç geçmişi henüz yüklenmedi. Veriler geldikçe burada listelenecek.</p>}
  </main>;
}
