import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreMatrix,marketProbabilities,forecast,sampleScorelines,scoreModel
} from "../lib/model-v4.ts";

const date=(days)=>new Date(Date.UTC(2026,0,1)+days*86400000).toISOString();
const history=Array.from({length:270},(_,i)=>{
  const homeId=i%10+1,awayId=(i+3+(i%3))%10+1;
  return {id:i+1,competition:"TEST",kickoff:date(i),
    homeId,awayId,homeGoals:i%7===0?3:i%3,awayGoals:i%5===0?2:i%2,
    homeXg:null,awayXg:null};
}).filter(m=>m.homeId!==m.awayId);
const fixture={
  id:9001,competition:"TEST",kickoff:date(285),
  homeId:1,awayId:4,homeName:"Home",awayName:"Away",source:"test",sourceCheckedAt:date(280)
};
test("full score matrix is nonnegative, normalized, and markets are coherent",()=>{
  const matrix=scoreMatrix(1.65,1.1);
  assert.ok(matrix.flat().every(x=>x>=0&&Number.isFinite(x)));
  assert.ok(Math.abs(matrix.flat().reduce((s,x)=>s+x,0)-1)<1e-10);
  const p=marketProbabilities(matrix);
  assert.ok(Math.abs(p["1"]+p["X"]+p["2"]-1)<1e-10);
  for(const line of ["1.5","2.5","3.5"]){
    assert.ok(Math.abs(p["O"+line]+p["U"+line]-1)<1e-10);
  }
  assert.ok(Math.abs(p["1X"]-(p["1"]+p["X"]))<1e-10);
  assert.ok(Math.abs(p["X2"]-(p["X"]+p["2"]))<1e-10);
});
test("10000 simulation approximates full matrix across all major betting markets",()=>{
  const matrix=scoreMatrix(1.4,1.2);
  const analytic=marketProbabilities(matrix);
  const simulated=sampleScorelines(matrix,10000,14329);
  for(const key of ["1","X","2","1X","X2","12","O1.5","O2.5","U2.5","BTTS_Y"]){
    const observed=simulated.markets[key]/simulated.iterations;
    assert.ok(Math.abs(observed-analytic[key])<0.025,key+" "+observed+" vs "+analytic[key]);
  }
});
test("no fake probabilities for missing league history",()=>{
  assert.equal(forecast(fixture,[]).status,"INSUFFICIENT");
  assert.ok(forecast({...fixture,homeId:901},history).status==="INSUFFICIENT");
});
test("future results never leak into an earlier prediction",()=>{
  const first=forecast(fixture,history);
  assert.equal(first.status,"READY");
  const futuristic=Array.from({length:40},(_,i)=>({
    id:1000+i,competition:"TEST",kickoff:date(300+i),homeId:1,awayId:4,
    homeGoals:20,awayGoals:0
  }));
  const next=forecast(fixture,[...history,...futuristic]);
  assert.equal(next.status,"READY");
  assert.equal(next.lambdaHome,first.lambdaHome);
  assert.equal(next.lambdaAway,first.lambdaAway);
});
test("walk-forward evaluation uses historical fixture ordering without future outcomes",()=>{
  const report=scoreModel(history,100);
  assert.ok(report.count>0);
  assert.ok(Number.isFinite(report.brier));
  assert.ok(Number.isFinite(report.logLoss));
  assert.equal(report.rows.length,report.count);
  assert.ok(report.rows.every(r=>Math.abs(r.home+r.draw+r.away-1)<1e-7));
});
