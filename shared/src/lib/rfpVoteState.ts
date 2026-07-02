/**
 * The ONE place RFP vote tally/threshold/outcome logic lives (design §5.8 reconciliation invariant).
 * Pure and deterministic: consumed identically by the deal-card display, the fire-on-2 decision inside
 * the vote transaction, and the escalation-page summary — so card == decision == escalation can never
 * drift for the same vote set.
 */

export type RfpVoteRecord = {
  voterUserId: string | null;
  voterEmail: string;
  decision: "approve" | "reject";
  reason: string | null;
  createdAt: Date | string;
};

export type RfpVoteOutcome = "pending" | "approved" | "rejected";

export interface RfpVoteState {
  approvals: number;
  rejections: number;
  outcome: RfpVoteOutcome;
  decidedAt: Date | null;
}

const DEFAULT_VOTE_THRESHOLD = 2;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function computeRfpVoteState(
  votes: RfpVoteRecord[],
  opts?: { threshold?: number },
): RfpVoteState {
  const threshold = opts?.threshold ?? DEFAULT_VOTE_THRESHOLD;
  const approveVotes = votes.filter((v) => v.decision === "approve");
  const rejectVotes = votes.filter((v) => v.decision === "reject");
  const approvals = approveVotes.length;
  const rejections = rejectVotes.length;

  // createdAt of the threshold-th matching vote (sorted ascending) — the vote that CROSSED the line.
  // Later votes on the same side never move this, so decidedAt is stable once decided.
  const decidedAtFor = (matching: RfpVoteRecord[]): Date => {
    const sorted = [...matching].sort(
      (a, b) => toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime(),
    );
    return toDate(sorted[threshold - 1]!.createdAt);
  };

  if (approvals >= threshold) {
    return { approvals, rejections, outcome: "approved", decidedAt: decidedAtFor(approveVotes) };
  }
  if (rejections >= threshold) {
    return { approvals, rejections, outcome: "rejected", decidedAt: decidedAtFor(rejectVotes) };
  }
  return { approvals, rejections, outcome: "pending", decidedAt: null };
}
