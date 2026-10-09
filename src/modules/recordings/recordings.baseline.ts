/**
 * The Stage 2 ordering baseline: how likely a proposal is kept, from its proposed length and its
 * detector score alone. Fitted by vision-lab/stage2_baseline.py on 403 trained-detector decisions
 * (2026-10-09); on channel-held-out folds it orders kept above skipped proposals of one recording
 * 78% of the time (timeline order: 43%). Any Stage 2 ranker has to beat it on the same folds, so
 * every Save logs each proposal's baseline rank. Free of I/O so it can be tested.
 */

export const BASELINE = { version: "baseline-v1", intercept: -6.654, perLogSecond: 0.8134, perScore: 1.7894 } as const;

interface Ranked {
  id: string;
  start_seconds: number;
  end_seconds: number;
  score: number;
}

/** The baseline's logit: higher is likelier kept. Uses the proposed edges, never a trim. */
export function baselineScore(proposal: Omit<Ranked, "id">): number {
  const seconds = Math.max(1, proposal.end_seconds - proposal.start_seconds);
  return Math.round((BASELINE.intercept + BASELINE.perLogSecond * Math.log(seconds) + BASELINE.perScore * proposal.score) * 1000) / 1000;
}

/** Proposal ids best first; ties go to the earlier one. Clips added by hand are never ranked. */
export function baselineOrder(proposals: readonly Ranked[]): string[] {
  return proposals
    .filter((proposal) => !proposal.id.startsWith("added-"))
    .map((proposal) => ({ proposal, value: baselineScore(proposal) }))
    .sort((a, b) => b.value - a.value || a.proposal.start_seconds - b.proposal.start_seconds)
    .map(({ proposal }) => proposal.id);
}
