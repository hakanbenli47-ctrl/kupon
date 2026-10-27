import test from "node:test";
import assert from "node:assert/strict";
import { conservativeProbability, rankSelections, optimizeCouponPlans, expectedValue, kickoffSlot } from "../lib/coupon-optimizer.ts";

const pick=(id, fixture, p, coverage=0.8)=>({
  id,fixture_id:fixture,kickoff_utc:"2026-10-28T18:00:00.000Z",market:1.5,selection:"UST",
  probability:p,data_quality:0.9,stats_coverage:coverage,sample_home:5,sample_away:5,
});

test("thin evidence is downgraded rather than overstated",()=>{
  assert.ok(conservativeProbability(0.90,0.8,0.2) < conservativeProbability(0.90,0.8,0.9));
  assert.ok(conservativeProbability(0.90,0.8,0.9) < 0.90);
});

test("no analysis = no coupon; high score without performance stats is rejected",()=>{
  assert.equal(optimizeCouponPlans([]).length,0);
  assert.equal(rankSelections([pick(1,10,0.99,0)]).length,0);
  assert.equal(optimizeCouponPlans([pick(1,1,0.9)]).length,0);
});

test("same match cannot appear twice",()=>{
  const c=[pick(1,1,0.96),pick(2,1,0.95),pick(3,2,0.95)];
  const ranked=rankSelections(c);
  assert.equal(ranked.length,2);
  assert.equal(new Set(ranked.map(x=>x.fixture_id)).size,ranked.length);
});

test("long coupons are suppressed if qualified matches run out",()=>{
  const plans=optimizeCouponPlans([1,2,3,4].map(id=>pick(id,id,0.99)));
  assert.deepEqual(plans.map(p=>p.group.length),[2,3,4]);
  for(const plan of plans){
    assert.ok(plan.combinedProbability<1);
    assert.ok(plan.group.every(p=>p.conservative_probability>=0.5));
  }
});

test("expected value requires user-supplied odds",()=>{
  assert.equal(expectedValue(0.6,1),null);
  assert.ok((expectedValue(0.8,1.5)??0)>0);
  assert.ok((expectedValue(0.4,1.5)??0)<0);
});

test("different kickoff minutes never share a coupon",()=>{
  const candidate=[1,2,3,4,5].map(id=>pick(id,id,0.99));
  candidate[4].kickoff_utc="2026-10-28T18:30:00.000Z";
  const plans=optimizeCouponPlans(candidate);
  assert.deepEqual(plans.map(p=>p.group.length),[2,3,4]);
  for(const plan of plans){
    assert.equal(new Set(plan.group.map(x=>kickoffSlot(x.kickoff_utc))).size,1);
  }
});
test("Turkish-local times must match, regardless of UTC source",()=>{
  assert.equal(kickoffSlot("2026-10-28T18:00:00Z"), "2026-10-28 21:00");
  assert.equal(kickoffSlot("2026-10-28T21:00:00+03:00"), "2026-10-28 21:00");
});
