import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { castRfpVote, useRfpVote } from "@/hooks/use-rfp-vote";
import { formatMoney, initFormFromDeal, labelForTypeCode } from "./rfp-vote-form";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">{children}</div>;
}

function ReadOnlyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{value || "—"}</span>
    </div>
  );
}

export function RfpVotePage() {
  const { dealId } = useParams<{ dealId: string }>();
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");
  const { user } = useAuth();
  // finding: do NOT gate the load on the mutable user.isRfpVoter flag. When RFP_VOTER_EMAILS changes after a round
  // opens, the server still authorizes voters from that round's invitation SNAPSHOT (BC2) — an originally invited
  // voter whose /auth/me now says isRfpVoter=false must still be able to open the emailed link and cast. Load for
  // any authenticated user and let the server be the authority (the cast route 403s a genuinely non-invited user).
  const { deal, loading, error, refetch } = useRfpVote(user ? dealId : undefined, officeId);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [voted, setVoted] = useState(false);

  // finding BC6: React Router reuses this same component instance across /rfp-vote/:dealId targets, so local vote
  // state would leak from the previous deal. Reset whenever the deal (or office) identity changes.
  useEffect(() => {
    setVoted(false);
    setDecision(null);
    setReason("");
    setSubmitting(false);
  }, [dealId, officeId]);

  if (!user) {
    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>Sign in to vote</CardTitle>
            <CardDescription>You need to be signed in to open this RFP vote. Sign in and follow the link again.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link to="/" className={buttonVariants({ variant: "outline" })}>Back to dashboard</Link>
          </CardFooter>
        </Card>
      </PageFrame>
    );
  }

  if (loading) {
    return <PageFrame><p className="text-sm text-muted-foreground">Loading the RFP…</p></PageFrame>;
  }

  if (error || !deal) {
    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>Couldn't load this RFP</CardTitle>
            <CardDescription>{error ?? "The deal could not be found."}</CardDescription>
          </CardHeader>
          <CardFooter className="gap-2">
            <Button variant="outline" onClick={() => refetch()}>Try again</Button>
            <Link to="/" className={buttonVariants({ variant: "ghost" })}>Back to dashboard</Link>
          </CardFooter>
        </Card>
      </PageFrame>
    );
  }

  // A non-vote deal reached directly (service / type-4, legacy SyncHub-path, or ENABLE_RFP_VOTING off) carries a
  // null rfpVoteState from the server. Guard BEFORE reading .outcome so the page never crashes on null.
  const voteState = deal.rfpVoteState;
  if (!voteState) {
    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>This deal is not open for voting</CardTitle>
            <CardDescription>This RFP isn't in an open voting round. It may be a service RFP, already decided, or handled through the standard approval path.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link to={`/deals/${deal.id}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`} className={buttonVariants({ variant: "outline" })}>Open the full deal</Link>
          </CardFooter>
        </Card>
      </PageFrame>
    );
  }

  // The RFP is immutable once triggered — project details are shown READ-ONLY (the static triggered snapshot). A
  // vote never edits the deal; the created Bid Board project is built from these same DB-authoritative values.
  const f = initFormFromDeal(deal);

  const alreadyVoted = deal.rfpVotes.some(
    (v) => (user.id != null && v.voterUserId === user.id) || (!!user.email && v.voterEmail.toLowerCase() === user.email.toLowerCase())
  );
  const decided = voteState.outcome !== "pending";
  // finding W6: the detail payload stays non-null for an H6-recovered round (send_failed with a vote already cast),
  // so gate submission on the round still being OPEN ('pending').
  const roundOpen = deal.rfpApprovalStatus === "pending";

  const rejectNeedsReason = decision === "reject" && reason.trim().length === 0;
  const canSubmit =
    decision !== null && !rejectNeedsReason && !submitting && !alreadyVoted && !decided && !voted && roundOpen;

  async function onSubmit() {
    if (!dealId || decision === null || !deal) return;
    setSubmitting(true);
    try {
      const result = await castRfpVote(dealId, {
        decision,
        reason: decision === "reject" ? reason.trim() : null,
        officeId,
      });
      setVoted(true);
      toast.success(
        result.outcome === "approved"
          ? "Vote recorded — 2/3 approved, creating the Bid Board project."
          : result.outcome === "rejected"
            ? "Vote recorded — 2/3 rejected, escalating for review."
            : "Vote recorded."
      );
      try {
        await refetch();
      } catch {
        /* ignore — the vote is recorded; the next load reflects it */
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record your vote");
    } finally {
      setSubmitting(false);
    }
  }

  const dealHref = `/deals/${deal.id}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;
  const decisionPanelShown = alreadyVoted || decided || !roundOpen || voted;

  return (
    <PageFrame>
      <Card>
        <CardHeader>
          <CardTitle>Vote on this RFP</CardTitle>
          <CardDescription>
            {f.dealname || deal.name} · {f.project_number || "Pending"} — two of three approvals create the Bid Board
            project; two rejections escalate for a final decision. Rejections require a reason.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Tally so far: {voteState.approvals} approve · {voteState.rejections} reject — needs 2 of 3.
          </p>

          {/* Project details — read-only snapshot of the RFP as triggered (immutable). */}
          <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold text-foreground">Project details</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ReadOnlyRow label="Deal name" value={f.dealname} />
              <ReadOnlyRow label="Project number" value={f.project_number || "Pending"} />
              <ReadOnlyRow label="Amount" value={formatMoney(f.amount)} />
              <ReadOnlyRow label="Project type" value={f.project_types ? `${f.project_types} - ${labelForTypeCode(f.project_types)}` : "—"} />
              <ReadOnlyRow label="Estimator" value={f.estimator} />
              <ReadOnlyRow label="Bid due date" value={f.bid_due_date} />
              <ReadOnlyRow label="Location" value={[f.address, f.city, f.state, f.zip].filter(Boolean).join(", ")} />
              <ReadOnlyRow label="Country" value={f.country} />
              <div className="sm:col-span-2">
                <ReadOnlyRow label="Description" value={f.description} />
              </div>
            </div>
          </section>

          {/* Company & contact — read-only context (linked records). */}
          <section className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
            <div className="sm:col-span-2 text-sm font-semibold text-foreground">Company &amp; contact</div>
            <ReadOnlyRow label="Company" value={deal.companyName} />
            <ReadOnlyRow label="Contact" value={deal.primaryContactName} />
            <ReadOnlyRow label="Contact email" value={deal.primaryContactEmail} />
            <ReadOnlyRow label="Contact phone" value={deal.primaryContactPhone} />
          </section>

          {/* Decision */}
          {decisionPanelShown ? (
            <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
              <p className="font-medium text-foreground">
                {decided
                  ? "This round has been decided."
                  : !roundOpen
                    ? "This vote round needs attention and is paused."
                    : "You've already cast your vote."}
              </p>
              <p className="mt-1 text-muted-foreground">
                {!roundOpen && !decided
                  ? "The invitation couldn't be delivered to all voters. Open the deal to recover it before voting continues."
                  : "Votes are final. Open the deal to see the live tally."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-semibold text-foreground">Your decision</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="decision" value="approve" checked={decision === "approve"} onChange={() => setDecision("approve")} />
                  Approve
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="decision" value="reject" checked={decision === "reject"} onChange={() => setDecision("reject")} />
                  Reject
                </label>
              </fieldset>

              {decision === "reject" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rfp-vote-reason">Reason (required)</Label>
                  <Textarea
                    id="rfp-vote-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Why are you rejecting this RFP?"
                    rows={3}
                    disabled={submitting}
                  />
                </div>
              )}

              <div>
                <Button onClick={onSubmit} disabled={!canSubmit}>
                  {submitting ? "Submitting…" : "Submit vote"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter>
          <Link to={dealHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>Open the full deal</Link>
        </CardFooter>
      </Card>
    </PageFrame>
  );
}
