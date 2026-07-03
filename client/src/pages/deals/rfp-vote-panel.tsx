import { Link } from "react-router-dom";
import type { DealDetail } from "@/hooks/use-deals";
import type { useAuth } from "@/lib/auth";

function formatVoteTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Read-only vote panel shown inside the RFP approval status block for a Pending-RFP non-service deal. Displays
 * each cast vote (choice + reason + time), the running tally, and the "needs 2 of 3" caption. An eligible voter
 * (user.isRfpVoter) who has not yet voted gets an inline "Cast your vote" deep link to the focused vote page.
 * The tally/outcome come straight from deal.rfpVoteState (the server's computeRfpVoteState) — never recomputed.
 */
export function RfpVotePanel({
  deal,
  user,
  officeId,
}: {
  deal: DealDetail;
  user: ReturnType<typeof useAuth>["user"];
  officeId: string | null;
}) {
  const state = deal.rfpVoteState;
  if (!state) return null;

  const votes = deal.rfpVotes ?? [];
  // Only show "awaiting" slots while the round is open — after a decision the panel is a historical record.
  const awaiting = state.outcome === "pending" ? Math.max(0, 3 - votes.length) : 0;
  const hasVoted = votes.some(
    (v) => (user?.id != null && v.voterUserId === user.id) || (!!user?.email && v.voterEmail.toLowerCase() === user.email.toLowerCase())
  );
  // finding Y9: also require the round to still be OPEN. After an invitation failure is surfaced (H6), the
  // outcome is still 'pending' but rfpApprovalStatus is send_failed — the "Cast your vote" link would then reach
  // the paused vote page / a server 409 until Retry runs. Gate on rfpApprovalStatus like the focused page (W6).
  const canCast =
    state.outcome === "pending" && deal.rfpApprovalStatus === "pending" && Boolean(user?.isRfpVoter) && !hasVoted;
  const voteHref = `/rfp-vote/${deal.id}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;

  const tally =
    state.outcome === "approved"
      ? "Approved by vote (2 of 3) — creating Bid Board…"
      : state.outcome === "rejected"
        ? "Rejected by vote (2 of 3)"
        : `${state.approvals} approve · ${state.rejections} reject — no decision yet`;

  const headerLabel =
    state.outcome === "approved"
      ? "Approved (2 of 3)"
      : state.outcome === "rejected"
        ? "Rejected (2 of 3)"
        : "Pending · needs 2 of 3";

  return (
    <div className="mt-3 rounded-md border border-border bg-background/60 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">RFP Approval Vote</p>
        <span className="text-xs text-muted-foreground">{headerLabel}</span>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {votes.map((vote) => (
          <li key={`${vote.voterEmail}-${vote.votedAt}`} className="flex items-start justify-between gap-3 py-1.5">
            <div>
              <span className="text-sm font-medium">{vote.voterName ?? vote.voterEmail}</span>
              <span className={`ml-2 text-sm ${vote.decision === "reject" ? "text-destructive" : "text-emerald-600"}`}>
                {vote.decision === "reject" ? "Rejected" : "Approved"}
              </span>
              {vote.reason ? <p className="mt-0.5 text-sm text-muted-foreground">{vote.reason}</p> : null}
            </div>
            <span className="whitespace-nowrap text-xs text-muted-foreground">{formatVoteTime(vote.votedAt)}</span>
          </li>
        ))}
        {awaiting > 0 &&
          Array.from({ length: awaiting }).map((_, i) => (
            <li key={`awaiting-${i}`} className="py-1.5 text-sm text-muted-foreground">
              ⏳ Awaiting vote
            </li>
          ))}
      </ul>
      <p className="mt-2 text-sm">
        Tally: {tally}
      </p>
      {canCast && (
        <Link
          to={voteHref}
          className="mt-2 inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          Cast your vote
        </Link>
      )}
    </div>
  );
}
