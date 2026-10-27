/**
 * Conservative coupon ranking. No bookmaker odds or guaranteed predictions.
 * Estimates are deliberately shrunk toward 50% when evidence is thin.
 */
export type CouponCandidate = {
  id: number;
  fixture_id: number;
  market: number;
  selection: "ALT" | "UST";
  probability: number;
  data_quality: number;
  stats_coverage: number;
  sample_home: number;
  sample_away: number;
};

export type RankedCandidate = CouponCandidate & {
  conservative_probability: number;
  evidence_score: number;
};

export type CouponPlan = {
  label: string;
  group: RankedCandidate[];
  combinedProbability: number;
  risk: "DUSUK" | "ORTA" | "YUKSEK";
};

const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));

export function evidenceScore(
  quality: number, coverage: number, homeSample = 5, awaySample = 5,
): number {
  const sample = clamp(Math.min(homeSample, awaySample) / 5, 0, 1);
  return clamp(
    0.40 * clamp(quality, 0, 1) + 0.40 * clamp(coverage, 0, 1) + 0.20 * sample,
    0, 1,
  );
}

export function conservativeProbability(
  probability: number, quality: number, coverage: number,
  homeSample = 5, awaySample = 5,
): number {
  const evidence = evidenceScore(quality, coverage, homeSample, awaySample);
  // Lower confidence means weaker evidence for a strong claimed probability.
  const credibility = 0.30 + 0.65 * evidence;
  return clamp(0.5 + (clamp(probability, 0, 1) - 0.5) * credibility, 0.02, 0.98);
}

export function rankSelections(
  candidates: CouponCandidate[],
  minimumQuality = 0.65,
): RankedCandidate[] {
  const byMatch = new Map<number, RankedCandidate>();
  for (const p of candidates) {
    if (![p.id, p.fixture_id, p.market, p.probability, p.data_quality, p.stats_coverage].every(Number.isFinite)) continue;
    if (!["ALT", "UST"].includes(p.selection)) continue;
    if (p.probability < 0.62 || p.data_quality < minimumQuality) continue;
    if (p.stats_coverage < 0.15) continue; // Do not sell score-only games as reliable.
    const conservative = conservativeProbability(p.probability, p.data_quality, p.stats_coverage, p.sample_home, p.sample_away);
    const evidence = evidenceScore(p.data_quality, p.stats_coverage, p.sample_home, p.sample_away);
    const next: RankedCandidate = {...p, conservative_probability: conservative, evidence_score: evidence};
    const previous = byMatch.get(p.fixture_id);
    const score = (candidate: RankedCandidate) => candidate.conservative_probability + 0.025 * candidate.evidence_score;
    if (!previous || score(next) > score(previous)) byMatch.set(p.fixture_id, next);
  }
  return [...byMatch.values()].sort((a, b) =>
    b.conservative_probability - a.conservative_probability
    || b.evidence_score - a.evidence_score || a.fixture_id - b.fixture_id
  );
}

const RECIPES = [
  {size: 2, threshold: 0.69, label: "Temkinli 2"},
  {size: 3, threshold: 0.67, label: "Dengeli 3"},
  {size: 4, threshold: 0.65, label: "Seçici 4"},
  {size: 5, threshold: 0.64, label: "Geniş 5"},
  {size: 6, threshold: 0.63, label: "Geniş 6"},
] as const;

export function optimizeCouponPlans(candidates: CouponCandidate[]): CouponPlan[] {
  const ranked = rankSelections(candidates);
  // Missing evidence / insufficient matches is a valid outcome: no coupon.
  return RECIPES.flatMap((recipe) => {
    const group = ranked.filter((p) => p.conservative_probability >= recipe.threshold).slice(0, recipe.size);
    if (group.length !== recipe.size) return [];
    const combinedProbability = group.reduce((v, p) => v * p.conservative_probability, 1);
    return [{
      label: recipe.label,
      group,
      combinedProbability,
      risk: combinedProbability >= 0.55 ? "DUSUK" : combinedProbability >= 0.30 ? "ORTA" : "YUKSEK",
    }];
  });
}

export function expectedValue(probability: number, decimalOdds: number): number | null {
  if (!Number.isFinite(probability) || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  return probability * decimalOdds - 1;
}
