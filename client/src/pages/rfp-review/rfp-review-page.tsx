import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  approveRfpOverride,
  reconfirmRfpDecline,
  useRfpReview,
  type RfpReviewDetail,
} from "@/hooks/use-rfp-review";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">{children}</div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{children}</span>
    </div>
  );
}

function DealFacts({ review }: { review: RfpReviewDetail }) {
  return (
    <div className="rounded-lg border border-border">
      <div className="px-4">
        <DetailRow label="Deal">{review.dealName}</DetailRow>
        <DetailRow label="Project number">{review.projectNumber ?? review.dealNumber ?? "Pending"}</DetailRow>
        <DetailRow label="Requested by">
          {review.requestedByName ?? review.requestedByEmail ?? "Unknown"}
        </DetailRow>
        <DetailRow label="Requested at">{formatDateTime(review.requestedAt)}</DetailRow>
        <DetailRow label="Declined at">{formatDateTime(review.declinedAt)}</DetailRow>
        <DetailRow label="Decline reason">{review.declinedReason ?? "No reason provided"}</DetailRow>
      </div>
    </div>
  );
}

function VotesPanel({ review }: { review: RfpReviewDetail }) {
  if (!review.votes || review.votes.length === 0) return null;
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium text-foreground">Vote record (2/3 no-go)</span>
      </div>
      <ul className="divide-y divide-border px-4">
        {review.votes.map((vote) => (
          <li key={`${vote.voterEmail}-${vote.votedAt}`} className="flex items-start justify-between gap-3 py-2.5">
            <div>
              <span className="text-sm font-medium text-foreground">{vote.voterName ?? vote.voterEmail}</span>
              <span className={`ml-2 text-sm ${vote.decision === "reject" ? "text-destructive" : "text-emerald-600"}`}>
                {vote.decision === "reject" ? "Rejected" : "Approved"}
              </span>
              {vote.reason ? <p className="mt-0.5 text-sm text-muted-foreground">{vote.reason}</p> : null}
            </div>
            <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(vote.votedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RfpReviewPage() {
  const { dealId } = useParams<{ dealId: string }>();
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");
  const { user } = useAuth();
  const { review, loading, error, refetch, applyOptimistic } = useRfpReview(
    user?.isRfpReviewer ? dealId : undefined,
    officeId
  );
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<null | "approve" | "reconfirm">(null);
  // Gate for re-attempting after an UNCONFIRMED failure: SyncHub may have already created a Procore project, so a
  // blind retry risks a duplicate. The reviewer must confirm they checked Procore before re-attempting.
  const [confirmedNoProject, setConfirmedNoProject] = useState(false);

  // Reset the per-deal Procore-check confirmation SYNCHRONOUSLY (during render, via React's "adjust state on prop
  // change" pattern) the moment the review target changes — NOT in a passive effect. An effect would leave a
  // one-frame window where, right after navigating to another failed deal, the re-attempt button is still enabled
  // from the previous deal's confirmation and a fast click could approve the NEW deal ungated (duplicate risk).
  const targetKey = `${dealId ?? ""}|${officeId ?? ""}`;
  const [confirmedForKey, setConfirmedForKey] = useState(targetKey);
  if (confirmedForKey !== targetKey) {
    setConfirmedForKey(targetKey);
    setConfirmedNoProject(false);
    setNote("");
  }

  // While SyncHub is creating the Bid Board project, poll so the page flips to approved/failed when the
  // bid-board-created callback lands (no manual refresh needed).
  useEffect(() => {
    if (review?.overrideState !== "approving") return;
    const interval = setInterval(() => {
      refetch();
    }, 5000);
    return () => clearInterval(interval);
  }, [review?.overrideState, refetch]);

  // Hard-gate the page to the designated reviewers. The server enforces the same allowlist on every endpoint;
  // this just avoids loading a page the user can't act on.
  if (!user?.isRfpReviewer) {
    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>Review access restricted</CardTitle>
            <CardDescription>
              Only the designated RFP reviewers can open this override-review page. If you believe this is a
              mistake, contact an administrator.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              Back to dashboard
            </Link>
          </CardFooter>
        </Card>
      </PageFrame>
    );
  }

  if (loading) {
    return (
      <PageFrame>
        <p className="text-sm text-muted-foreground">Loading the declined RFP…</p>
      </PageFrame>
    );
  }

  if (error || !review) {
    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>Couldn’t load this RFP</CardTitle>
            <CardDescription>{error ?? "The deal could not be found."}</CardDescription>
          </CardHeader>
          <CardFooter className="gap-2">
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
            <Link to="/" className={buttonVariants({ variant: "ghost" })}>
              Back to dashboard
            </Link>
          </CardFooter>
        </Card>
      </PageFrame>
    );
  }

  async function onApprove() {
    if (!dealId) return;
    setSubmitting("approve");
    try {
      const result = await approveRfpOverride(dealId, { note, officeId });
      toast.success(
        result.unconfirmed
          ? "Override submitted — awaiting confirmation from SyncHub. Watch this page for the result."
          : "Override approved — SyncHub is creating the Bid Board project."
      );
      setNote("");
      setConfirmedNoProject(false); // require re-verification if this attempt also fails
      // Optimistically enter 'approving' so the progress panel + 5s poll start immediately. On an unconfirmed
      // timeout the deal IS kept 'approving' server-side (re-approve stays blocked to avoid a duplicate; a stuck
      // deal is escapable via Re-confirm denial).
      applyOptimistic({ overrideState: "approving", overrideError: null, actionable: false });
      // The action already succeeded above. Isolate the best-effort authoritative refresh so a transient refresh
      // blip can never surface as an approval failure (the optimistic state + 5s poll already reconcile).
      try {
        await refetch();
      } catch {
        /* ignore — the poll reconciles the authoritative state */
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve the override");
    } finally {
      setSubmitting(null);
    }
  }

  async function onReconfirm() {
    if (!dealId) return;
    setSubmitting("reconfirm");
    try {
      const result = await reconfirmRfpDecline(dealId, { note, officeId });
      toast.success("Denial re-confirmed — this RFP stays declined.");
      setNote("");
      // Optimistically mark the terminal outcome so it sticks even if the follow-up refresh blips. `archived`
      // drives the footer CTA: a normal reconfirm archives the deal (hide "Open the full deal" — it would 404),
      // while the escape hatch leaves it active (keep the link).
      applyOptimistic({
        reviewDecision: "denial_reconfirmed",
        overrideState: null,
        overrideError: null,
        actionable: false,
        isActive: !result.archived,
      });
      // Best-effort refresh, isolated so a refresh blip can't read as a re-confirm failure (the optimistic
      // terminal outcome already holds; the next load reconciles).
      try {
        await refetch();
      } catch {
        /* ignore — the next load reconciles the authoritative state */
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-confirm the denial");
    } finally {
      setSubmitting(null);
    }
  }

  const dealHref = `/deals/${review.dealId}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;
  const busy = submitting !== null;

  return (
    <PageFrame>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>RFP override review</CardTitle>
              <CardDescription>
                This RFP was declined in the first go/no-go round. Approve the override to create the Bid Board
                project (overriding the no-go), or re-confirm the denial.
              </CardDescription>
            </div>
            <StatusBadge review={review} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DealFacts review={review} />
          <VotesPanel review={review} />

          {review.overrideState === "approving" ? (
            <ApprovingPanel
              review={review}
              onRefresh={() => refetch()}
              onReconfirm={onReconfirm}
              busy={busy}
              reconfirming={submitting === "reconfirm"}
              note={note}
              setNote={setNote}
            />
          ) : review.overrideState === "failed" ? (
            <>
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
                <p className="font-medium text-destructive">Bid Board project creation couldn’t be confirmed.</p>
                <p className="mt-1 text-muted-foreground">
                  {review.overrideError ?? "SyncHub could not confirm the project was created."}
                </p>
                <p className="mt-2 font-medium text-foreground">
                  ⚠️ A Procore project may already have been created. Open Procore and check whether a Bid Board
                  project exists for this deal <span className="font-semibold">before</span> re-attempting — a
                  blind retry would create a duplicate project.
                </p>
                <p className="mt-1 text-muted-foreground">
                  If a project already exists, do <span className="font-semibold">not</span> re-attempt — re-confirm
                  the denial here and have the existing project reconciled. Only re-attempt once you’ve confirmed
                  no project was created.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rfp-override-note">Note (required to deny)</Label>
                <Textarea
                  id="rfp-override-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why are you re-attempting or upholding this decision?"
                  rows={3}
                  disabled={busy}
                />
              </div>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  checked={confirmedNoProject}
                  onCheckedChange={setConfirmedNoProject}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span>I checked Procore and confirmed that no Bid Board project was created for this deal.</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button onClick={onApprove} disabled={busy || !confirmedNoProject}>
                  {submitting === "approve" ? "Submitting…" : "Confirmed no project — re-attempt"}
                </Button>
                <Button variant="destructive" onClick={onReconfirm} disabled={busy || note.trim().length === 0}>
                  {submitting === "reconfirm" ? "Confirming…" : "Re-confirm denial"}
                </Button>
              </div>
            </>
          ) : review.actionable ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rfp-override-note">Note (required to deny)</Label>
                <Textarea
                  id="rfp-override-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why are you overriding or upholding this decision?"
                  rows={3}
                  disabled={busy}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={onApprove} disabled={busy}>
                  {submitting === "approve" ? "Submitting…" : "Approve override (create Bid Board project)"}
                </Button>
                <Button variant="destructive" onClick={onReconfirm} disabled={busy || note.trim().length === 0}>
                  {submitting === "reconfirm" ? "Confirming…" : "Re-confirm denial"}
                </Button>
              </div>
            </>
          ) : (
            <ReviewOutcome review={review} />
          )}
        </CardContent>
        <CardFooter>
          {review.isActive ? (
            <Link to={dealHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Open the full deal
            </Link>
          ) : (
            // Archived (re-confirmed denial): the deal detail 404s, so show a note instead of a dead link.
            <p className="text-sm text-muted-foreground">This deal has been archived.</p>
          )}
        </CardFooter>
      </Card>
    </PageFrame>
  );
}

function StatusBadge({ review }: { review: RfpReviewDetail }) {
  if (review.overrideState === "approving") {
    return <Badge variant="secondary">Creating project…</Badge>;
  }
  if (review.overrideState === "failed") {
    return <Badge variant="destructive">Override failed</Badge>;
  }
  if (review.reviewDecision === "denial_reconfirmed") {
    return <Badge variant="destructive">Denial re-confirmed</Badge>;
  }
  if (review.rfpApprovalStatus === "approved") {
    return <Badge variant="default">Approved</Badge>;
  }
  if (review.rfpApprovalStatus === "declined") {
    return <Badge variant="destructive">Declined</Badge>;
  }
  return <Badge variant="secondary">{review.rfpApprovalStatus ?? "Unknown"}</Badge>;
}

function ApprovingPanel({
  review,
  onRefresh,
  onReconfirm,
  busy,
  reconfirming,
  note,
  setNote,
}: {
  review: RfpReviewDetail;
  onRefresh: () => void;
  onReconfirm: () => void;
  busy: boolean;
  reconfirming: boolean;
  note: string;
  setNote: (v: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <p className="font-medium text-foreground">Creating the Bid Board project…</p>
      <p className="mt-1 text-muted-foreground">
        {review.reviewedByName ?? "A reviewer"} approved the override. SyncHub is creating the Procore Bid Board
        project — this can take a minute. The deal will move to Estimating automatically when it’s done. If it
        fails you’ll see a Retry option here.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
          Refresh
        </Button>
      </div>
      {/*
        Escape hatch: a re-approve is intentionally NOT offered here (it would risk a duplicate Procore project
        against a first attempt that may still be in flight). But if SyncHub never picked the request up, this would
        otherwise be stuck forever — so allow upholding the denial, which creates no project and is always safe.
      */}
      <div className="mt-3 border-t border-border/60 pt-3">
        <p className="text-muted-foreground">
          Taking much longer than a minute? SyncHub may not have received the request. You can uphold the denial
          instead — only do this if no Bid Board project was created (if one was, it’ll be reconciled separately).
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          <Label htmlFor="rfp-override-note-approving">Note (required to deny)</Label>
          <Textarea
            id="rfp-override-note-approving"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why are you upholding the denial?"
            rows={3}
            disabled={busy}
          />
        </div>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onReconfirm} disabled={busy || note.trim().length === 0}>
          {reconfirming ? "Confirming…" : "Uphold the denial instead"}
        </Button>
      </div>
    </div>
  );
}

function ReviewOutcome({ review }: { review: RfpReviewDetail }) {
  if (review.reviewDecision === "denial_reconfirmed") {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
        <p className="font-medium text-foreground">This denial was re-confirmed and will not be re-flagged.</p>
        <p className="mt-1 text-muted-foreground">
          Reviewed by {review.reviewedByName ?? "a reviewer"} on {formatDateTime(review.reviewedAt)}.
          {review.reviewNote ? ` Note: ${review.reviewNote}` : ""}
        </p>
      </div>
    );
  }
  if (review.rfpApprovalStatus === "approved") {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
        <p className="font-medium text-foreground">Approved — the Bid Board project was created.</p>
        <p className="mt-1 text-muted-foreground">
          The deal is linked to Procore and has advanced to Estimating.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <p className="font-medium text-foreground">This RFP is no longer awaiting a second-look review.</p>
      <p className="mt-1 text-muted-foreground">Its current status is “{review.rfpApprovalStatus ?? "unknown"}”.</p>
    </div>
  );
}
