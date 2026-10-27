import test from "node:test";
import assert from "node:assert/strict";
import {parseOpenLigaSeason} from "../lib/season-parser.ts";

const valid=(override={})=>({
 matchID:731298,
 matchDateTimeUTC:"2026-10-28T18:30:00Z",
 team1:{teamName:"Bayern München"},team2:{teamName:"Borussia Dortmund"},
 matchIsFinished:true,
 matchResults:[
  {resultTypeID:1,pointsTeam1:1,pointsTeam2:0},
  {resultTypeID:2,pointsTeam1:2,pointsTeam2:1}
 ],
 ...override
});
test("imports a full-time result, not the half-time score",()=>{
 const [game]=parseOpenLigaSeason([valid()],"BL");
 assert.equal(game.external_id,"openliga-BL-731298");
 assert.equal(game.home_goals,2);
 assert.equal(game.away_goals,1);
 assert.equal(game.status,"FINISHED");
 assert.match(game.source_url,/getmatchdata\/731298$/);
});
test("unplayed matches never inherit scores from a stale provider",()=>{
 const [game]=parseOpenLigaSeason([valid({matchIsFinished:false})],"BL");
 assert.equal(game.status,"TIMED");
 assert.equal(game.home_goals,null);
 assert.equal(game.away_goals,null);
});
test("finished status requires a complete 90-minute result",()=>{
 const [game]=parseOpenLigaSeason([valid({matchResults:[
  {resultTypeID:1,pointsTeam1:1,pointsTeam2:0}
 ]})],"BL");
 assert.equal(game.status,"TIMED");
 assert.equal(game.home_goals,null);
});
test("rejects fixtures with missing identities or invalid dates",()=>{
 const rows=[valid({matchID:0}),valid({matchDateTimeUTC:"invalid"}),
   valid({team1:{teamName:""}}),valid({matchDateTimeUTC:"2025-10-28T18:30:00Z"})];
 assert.equal(parseOpenLigaSeason(rows,"BL").length,0);
});
test("does not import any event in another season",()=>{
 assert.equal(parseOpenLigaSeason([
  valid({matchDateTimeUTC:"2027-08-01T18:00:00Z"})],"BL").length,0);
});
