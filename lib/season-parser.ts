// Pure season match parser. No network, database or browser dependencies.
export type SeasonFixture={
  external_id:string;competition_code:string;kickoff_utc:string;
  home_team:string;away_team:string;status:"FINISHED"|"TIMED";
  home_goals:number|null;away_goals:number|null;
  source_name:string;source_url:string;
};
const SEASON_START="2026-07-01T00:00:00Z";
const SEASON_END="2027-07-01T00:00:00Z";
const numeric=(v:unknown):number|null=>{
  if(v===null||v===undefined||String(v).trim()==="")return null;
  const n=Number(v);
  return Number.isInteger(n)&&n>=0&&n<=30?n:null;
};
export function parseOpenLigaSeason(raw:unknown,leagueCode:string):SeasonFixture[]{
  if(!Array.isArray(raw))throw Error("OpenLigaDB geçerli maç listesi döndürmedi");
  const result:SeasonFixture[]=[];
  for(const data of raw){
    if(!data||typeof data!=="object")continue;
    const m=data as Record<string,unknown>;
    const id=Number(m.matchID);
    const iso=String(m.matchDateTimeUTC||"");
    const ms=Date.parse(iso);
    const a=m.team1 as Record<string,unknown>|undefined;
    const b=m.team2 as Record<string,unknown>|undefined;
    const home=String(a?.teamName||"").trim(),away=String(b?.teamName||"").trim();
    if(!Number.isInteger(id)||id<1||!Number.isFinite(ms)||!home||!away
      ||ms<Date.parse(SEASON_START)||ms>=Date.parse(SEASON_END))continue;
    const done=m.matchIsFinished===true;
    const results=(Array.isArray(m.matchResults)?m.matchResults:[]) as Record<string,unknown>[];
    const ft=results.find(x=>Number(x.resultTypeID)===2||
      String((x.resultInfo as Record<string,unknown>|undefined)?.kind||"")==="After90Minutes");
    const h=numeric(ft?.pointsTeam1),aw=numeric(ft?.pointsTeam2);
    const finished=done&&h!==null&&aw!==null;
    result.push({
      external_id:"openliga-"+leagueCode+"-"+id,competition_code:leagueCode,
      kickoff_utc:new Date(ms).toISOString(),home_team:home,away_team:away,
      status:finished?"FINISHED":"TIMED",home_goals:finished?h:null,away_goals:finished?aw:null,
      source_name:"OpenLigaDB · 2026/27",
      source_url:"https://api.openligadb.de/getmatchdata/"+id,
    });
  }
  return result;
}
