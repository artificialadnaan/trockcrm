import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { castRfpVote, useRfpVote } from "@/hooks/use-rfp-vote";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">{children}</div>;
}

export function RfpVotePage() {
  const { dealId } = useParams<{ dealId: string }>();
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");
  const { user } = useAuth();
  const { deal, loading, error, refetch } = useRfpVote(user?.isRfpVoter ? dealId : undefined, officeId);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [voted, setVoted] = useState(false);

  if (!user?.isRfpVoter) {
    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>Vote access restricted</CardTitle>
            <CardDescription>Only the designated RFP voters can open this page. Contact an administrator if this is a mistake.</CardDescription>
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

  const alreadyVoted = deal.rfpVotes.some(
    (v) => (user.id != null && v.voterUserId === user.id) || (!!user.email && v.voterEmail.toLowerCase() === user.email.toLowerCase())
  );
  const decided = deal.rfpVoteState.outcome !== "pending";
  const rejectNeedsReason = decision === "reject" && reason.trim().length === 0;
  const canSubmit = decision !== null && !rejectNeedsReason && !submitting && !alreadyVoted && !decided && !voted;

  async function onSubmit() {
    if (!dealId || decision === null) return;
    setSubmitting(true);
    try {
      const result = await castRfpVote(dealId, { decision, reason: decision === "reject" ? reason.trim() : null, officeId });
      // The vote is recorded — lock re-submit immediately, independent of whether the follow-up refetch succeeds.
      setVoted(true);
      toast.success(
        result.outcome === "approved"
          ? "Vote recorded — 2/3 approved, creating the Bid Board project."
          : result.outcome === "rejected"
            ? "Vote recorded — 2/3 rejected, escalating for review."
            : "Vote recorded."
      );
      // A refetch failure must NOT surface as a vote failure — the vote already succeeded; the next load reconciles.
      try {
        await refetch();
      } catch {
        /* ignore — the vote is recorded; the panel / next load will reflect it */
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record your vote");
    } finally {
      setSubmitting(false);
    }
  }

  const dealHref = `/deals/${deal.id}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;

  return (
    <PageFrame>
      <Card>
        <CardHeader>
          <CardTitle>Vote on this RFP</CardTitle>
          <CardDescription>
            {deal.name} · {deal.projectNumber ?? "Pending"} — two of three approvals create the Bid Board project;
            two rejections escalate for a final decision. Rejections require a reason.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Tally so far: {deal.rfpVoteState.approvals} approve · {deal.rfpVoteState.rejections} reject — needs 2 of 3.
          </p>

          {alreadyVoted || decided ? (
            <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
              <p className="font-medium text-foreground">
                {decided ? "This round has been decided." : "You've already cast your vote."}
              </p>
              <p className="mt-1 text-muted-foreground">Votes are final. Open the deal to see the live tally.</p>
            </div>
          ) : (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Your decision</legend>
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
            </>
          )}
        </CardContent>
        <CardFooter>
          <Link to={dealHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>Open the full deal</Link>
        </CardFooter>
      </Card>
    </PageFrame>
  );
}
