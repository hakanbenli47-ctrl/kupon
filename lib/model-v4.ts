/**
 * Kupon Engine V4 — from-scratch, deterministic model.
 * No network access, no database calls, no bookmaker odds assumptions.
 * Predictions are conditional on the verified historical data provided.
 * Never call this a guaranteed or independently validated winning system.
 */
export type HistoricalGame = {
  id:number;
  competition:string;
  kickoff:string;
  homeId:number;
  awayId:number;
  homeGoals:number;
  awayGoals:number;
  homeXg?:number|null;
  awayXg?:number|null;
  homeShotsOnTarget?:number|null;
  awayShotsOnTarget?:number|null;
};
export type ScheduledGame = {
  id:number; competition:string; kickoff:string; homeId:number; awayId:number;
  homeName:string; awayName:string; source:string; sourceCheckedAt:string;
};
export type MarketName =
  "1"|"X"|"2"|"1X"|"X2"|"12"|"O1.5"|"U1.5"|"O2.5"|"U2.5"|
  "O3.5"|"U3.5"|"BTTS_Y"|"BTTS_N";
export type MarketProjection={name:MarketName;probability:number;conservative:number};
export type ModelProfile={
  status:"READY"|"INSUFFICIENT"; reason?:string; fixture:ScheduledGame;
  lambdaHome?:number;lambdaAway?:number;quality?:number;
  samples?:{home:number;away:number;homeVenue:number;awayVenue:number;league:number;xg:number};
  sources?:{scores:boolean;xg:boolean;goalMinutes:boolean};
  markets?:MarketProjection[];
  scores?:Array<{score:string;probability:number}>;
  matrix?:number[][];
  modelVersion:"engine-v4.0";
};
const VERSION="engine-v4.0" as const;
const clip=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const safeNumber=(n:unknown)=>typeof n==="number" && Number.isFinite(n);
const positive=(n:unknown)=>safeNumber(n)&&Number(n)>=0;
const DAY=86_400_000;

export function verifiedHistory(rows:HistoricalGame[]):HistoricalGame[]{
  return rows.filter(g=>Number.isInteger(g.id) && Number.isInteger(g.homeId)
    && Number.isInteger(g.awayId) && g.homeId!==g.awayId
    && Number.isInteger(g.homeGoals)&&Number.isInteger(g.awayGoals)
    && g.homeGoals>=0&&g.awayGoals>=0&&g.homeGoals<=30&&g.awayGoals<=30
    && Number.isFinite(Date.parse(g.kickoff)));
}
export function poisson(lambda:number,maxGoals=10):number[]{
  const values:number[]=[Math.exp(-lambda)];
  for(let i=1;i<=maxGoals;i++)values.push(values[i-1]*lambda/i);
  // Cap the final overflow bucket; no probability mass disappears.
  const remainder=Math.max(0,1-values.reduce((a,b)=>a+b,0));
  values[maxGoals]+=remainder;
  return values;
}
export function scoreMatrix(home:number,away:number,rho=-0.06):number[][]{
  const h=poisson(clip(home,0.2,3.8)),a=poisson(clip(away,0.2,3.8));
  const matrix=h.map((p,i)=>a.map((q,j)=>{
    let correction=1;
    // Dixon-Coles low-score dependence. A fixed regularizer, not fitted from these fixtures.
    if(i===0&&j===0)correction=1-home*away*rho;
    if(i===0&&j===1)correction=1+home*rho;
    if(i===1&&j===0)correction=1+away*rho;
    if(i===1&&j===1)correction=1-rho;
    return p*q*Math.max(0.05,correction);
  }));
  const total=matrix.flat().reduce((a,b)=>a+b,0);
  return matrix.map(row=>row.map(v=>v/total));
}
export function marketProbabilities(matrix:number[][]):Record<MarketName,number>{
  const result:Record<MarketName,number>={
    "1":0,"X":0,"2":0,"1X":0,"X2":0,"12":0,
    "O1.5":0,"U1.5":0,"O2.5":0,"U2.5":0,
    "O3.5":0,"U3.5":0,"BTTS_Y":0,"BTTS_N":0,
  };
  for(let h=0;h<matrix.length;h++)for(let a=0;a<matrix[h].length;a++){
    const p=matrix[h][a];
    if(h>a)result["1"]+=p;
    if(h===a)result["X"]+=p;
    if(h<a)result["2"]+=p;
    for(const threshold of [1,2,3] as const){
      const line=String(threshold)+".5" as "1.5"|"2.5"|"3.5";
      if(h+a>threshold)result["O"+line as MarketName]+=p;
      else result["U"+line as MarketName]+=p;
    }
    if(h>0&&a>0)result.BTTS_Y+=p;else result.BTTS_N+=p;
  }
  result["1X"]=result["1"]+result["X"];
  result["X2"]=result["X"]+result["2"];
  result["12"]=result["1"]+result["2"];
  return result;
}
type Perspective={scored:number;conceded:number;xgScored:number|null;xgConceded:number|null;
  atHome:boolean;weight:number;days:number};
function perspective(teamId:number,games:HistoricalGame[],asOf:number){
  const all:Perspective[]=[];
  for(const g of games){
    if(g.homeId!==teamId&&g.awayId!==teamId)continue;
    const ms=Date.parse(g.kickoff),days=(asOf-ms)/DAY;
    if(days<=0||days>365)continue;
    const atHome=g.homeId===teamId;
    const rate=Math.exp(-Math.LN2*days/95);
    all.push({
      scored:atHome?g.homeGoals:g.awayGoals,
      conceded:atHome?g.awayGoals:g.homeGoals,
      xgScored:positive(atHome?g.homeXg:g.awayXg)
        ? Number(atHome?g.homeXg:g.awayXg):null,
      xgConceded:positive(atHome?g.awayXg:g.homeXg)
        ? Number(atHome?g.awayXg:g.homeXg):null,
      atHome,weight:rate,days,
    });
  }
  // bounded history; old seasons and long lookbacks downweighted
  return all.sort((a,b)=>a.days-b.days).slice(0,32);
}
function shrinkMean(rows:Perspective[],kind:"scored"|"conceded",prior:number,priorGames:number){
  let weighted=prior*priorGames,total=priorGames;
  for(const row of rows){weighted+=row[kind]*row.weight;total+=row.weight;}
  return weighted/total;
}
function weightedXg(rows:Perspective[],key:"xgScored"|"xgConceded"){
  const observations=rows.filter(row=>row[key]!==null);
  const weight=observations.reduce((v,r)=>v+r.weight,0);
  if(observations.length<5 || weight<2)return null;
  return observations.reduce((v,r)=>v+Number(r[key])*r.weight,0)/weight;
}
const blended=(atVenue:Perspective[],all:Perspective[],kind:"scored"|"conceded",prior:number)=>{
  const venue=shrinkMean(atVenue,kind,prior,5.5);
  const general=shrinkMean(all,kind,prior,8);
  return 0.7*venue+0.3*general;
};
function restedFactor(rows:Perspective[]){
  if(!rows.length)return 1;
  const days=rows[0].days;
  if(days<2.5)return 0.94; // weaker attack after especially short rest
  if(days<4)return 0.975;
  return 1;
}
function projections(matrix:number[][],quality:number):MarketProjection[]{
  const probs=marketProbabilities(matrix);
  // Uncertainty is a penalty, not a statistical confidence interval.
  const penalty=0.025+0.075*(1-quality);
  return (Object.keys(probs) as MarketName[]).map(name=>({
    name,probability:clip(probs[name],0,1),
    conservative:clip(probs[name]-penalty,0.01,0.99),
  })).sort((a,b)=>b.conservative-a.conservative);
}
export function forecast(
  fixture:ScheduledGame,allRows:HistoricalGame[],asOf=fixture.kickoff,
):ModelProfile{
  const time=Date.parse(asOf);
  const empty=(reason:string):ModelProfile=>({
    status:"INSUFFICIENT",reason,fixture,modelVersion:VERSION
  });
  if(!Number.isFinite(time))return empty("Başlama saati geçersiz.");
  const games=verifiedHistory(allRows).filter(g=>g.competition===fixture.competition
    && Date.parse(g.kickoff)<time && Date.parse(g.kickoff)>=time-365*DAY);
  if(games.length<35)return empty("Ligde en az 35 doğrulanmış geçmiş maç gerekli.");
  const home=perspective(fixture.homeId,games,time);
  const away=perspective(fixture.awayId,games,time);
  if(home.length<6||away.length<6)return empty("İki takımın da en az 6 doğrulanmış eski maçına ihtiyaç var.");
  const homeVenue=home.filter(g=>g.atHome),awayVenue=away.filter(g=>!g.atHome);
  if(homeVenue.length<2||awayVenue.length<2)return empty("İç saha/deplasman örneklemi yetersiz.");
  const totalHome=games.reduce((sum,m)=>sum+m.homeGoals,0)/games.length;
  const totalAway=games.reduce((sum,m)=>sum+m.awayGoals,0)/games.length;
  const homeLeague=clip(totalHome,0.6,2.6),awayLeague=clip(totalAway,0.45,2.2);
  const homeScored=blended(homeVenue,home,"scored",homeLeague);
  const awayConceded=blended(awayVenue,away,"conceded",homeLeague);
  const awayScored=blended(awayVenue,away,"scored",awayLeague);
  const homeConceded=blended(homeVenue,home,"conceded",awayLeague);
  let goalHome=clip(homeScored*awayConceded/homeLeague,0.25,3.5);
  let goalAway=clip(awayScored*homeConceded/awayLeague,0.2,3.3);
  const hXg=weightedXg(homeVenue,"xgScored"),aXgConceded=weightedXg(awayVenue,"xgConceded");
  const aXg=weightedXg(awayVenue,"xgScored"),hXgConceded=weightedXg(homeVenue,"xgConceded");
  const xgPairs=(hXg!==null&&aXgConceded!==null?1:0)+(aXg!==null&&hXgConceded!==null?1:0);
  if(hXg!==null&&aXgConceded!==null)
    goalHome=0.84*goalHome+0.16*(hXg+aXgConceded)/2;
  if(aXg!==null&&hXgConceded!==null)
    goalAway=0.84*goalAway+0.16*(aXg+hXgConceded)/2;
  goalHome=clip(goalHome*restedFactor(home),0.25,3.5);
  goalAway=clip(goalAway*restedFactor(away),0.20,3.3);
  const quality=clip(0.32+0.24*Math.min(home.length,away.length)/20
    +0.16*Math.min(homeVenue.length,awayVenue.length)/10
    +0.15*Math.min(games.length,150)/150
    +0.13*xgPairs/2,0.32,0.98);
  const matrix=scoreMatrix(goalHome,goalAway);
  const scores=matrix.flatMap((row,h)=>row.map((p,a)=>({score:h+"-"+a,probability:p})))
    .sort((a,b)=>b.probability-a.probability).slice(0,8);
  return {
    status:"READY",fixture,lambdaHome:goalHome,lambdaAway:goalAway,
    samples:{home:home.length,away:away.length,homeVenue:homeVenue.length,
      awayVenue:awayVenue.length,league:games.length,xg:xgPairs},
    sources:{scores:true,xg:xgPairs>0,goalMinutes:false},
    quality,markets:projections(matrix,quality),scores,matrix,modelVersion:VERSION,
  };
}
export function sampleScorelines(matrix:number[][],iterations=10000,seed=32198765){
  let state=seed>>>0;
  const flattened=matrix.flat();
  const cdf:number[]=[];
  let sum=0;
  for(const value of flattened){sum+=value;cdf.push(sum);}
  const goals=new Map<string,number>(),marketHits:Partial<Record<MarketName,number>>={};
  const columns=matrix[0].length;
  for(let n=0;n<iterations;n++){
    state=(Math.imul(1664525,state)+1013904223)>>>0;
    const u=state/4294967296;
    let low=0,high=cdf.length-1;
    while(low<high){const mid=(low+high)>>>1;if(u<cdf[mid])high=mid;else low=mid+1;}
    const h=Math.floor(low/columns),a=low%columns,k=h+"-"+a;
    goals.set(k,(goals.get(k)||0)+1);
    const total=h+a;
    for(const line of [1.5,2.5,3.5]){
      const key=(total>line?"O":"U")+line as MarketName;
      marketHits[key]=(marketHits[key]||0)+1;
    }
    const keys:MarketName[]=[h>a?"1":h<a?"2":"X",h>0&&a>0?"BTTS_Y":"BTTS_N"];
    if(h>=a)keys.push("1X");
    if(h<=a)keys.push("X2");
    if(h!==a)keys.push("12");
    for(const key of keys)marketHits[key]=(marketHits[key]||0)+1;
  }
  return {iterations,
    scores:[...goals.entries()].map(([score,count])=>({score,count})).sort((a,b)=>b.count-a.count).slice(0,8),
    markets:marketHits,
  };
}
export function outcomeProbabilities(profile:ModelProfile){
  if(profile.status!=="READY"||!profile.markets)return null;
  const find=(name:MarketName)=>profile.markets?.find(x=>x.name===name)?.probability||0;
  return {home:find("1"),draw:find("X"),away:find("2"),over25:find("O2.5")};
}
export function scoreModel(
  games:HistoricalGame[], holdoutCount=120,
):{count:number;brier:number;baselineBrier:number;logLoss:number;over25Brier:number;rows:Array<{date:string;fixtureId:number;actual:string;home:number;draw:number;away:number}>}{
  const ordered=verifiedHistory(games).sort((a,b)=>a.kickoff.localeCompare(b.kickoff));
  const recent=ordered.slice(-Math.min(500,Math.max(20,holdoutCount)));
  let sumBrier=0,sumBase=0,sumLoss=0,sumO25=0,n=0;
  const rows:Array<{date:string;fixtureId:number;actual:string;home:number;draw:number;away:number}>=[];
  for(const g of recent){
    const f:ScheduledGame={
      id:g.id,competition:g.competition,kickoff:g.kickoff,
      homeId:g.homeId,awayId:g.awayId,homeName:"",awayName:"",
      source:"",sourceCheckedAt:"",
    };
    // Strictly earlier matches. Never include this fixture, its result, or future games.
    const history=ordered.filter(m=>m.competition===g.competition && m.kickoff<g.kickoff);
    const pred=forecast(f,history);
    if(pred.status!=="READY")continue;
    const p=outcomeProbabilities(pred)!;
    const actual=g.homeGoals>g.awayGoals?"1":g.homeGoals<g.awayGoals?"2":"X";
    const probs=[p.home,p.draw,p.away],truth=actual==="1"?0:actual==="X"?1:2;
    sumBrier+=probs.reduce((s,x,i)=>s+(x-(i===truth?1:0))**2,0);
    const base=[0.44,0.27,0.29];
    sumBase+=base.reduce((s,x,i)=>s+(x-(i===truth?1:0))**2,0);
    sumLoss-=Math.log(Math.max(0.001,probs[truth]));
    const over=g.homeGoals+g.awayGoals>2?1:0;
    sumO25+=(p.over25-over)**2;
    rows.push({date:g.kickoff,fixtureId:g.id,actual,home:p.home,draw:p.draw,away:p.away});
    n++;
  }
  return {count:n,brier:n?sumBrier/n:0,baselineBrier:n?sumBase/n:0,
    logLoss:n?sumLoss/n:0,over25Brier:n?sumO25/n:0,rows};
}
