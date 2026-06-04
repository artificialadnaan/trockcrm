import { useState } from "react";
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

export function RfpReviewPage() {
  const { dealId } = useParams<{ dealId: string }>();
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");
  const { user } = useAuth();
  const { review, loading, error, refetch } = useRfpReview(
    user?.isRfpReviewer ? dealId : undefined,
    officeId
  );
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<null | "approve" | "reconfirm">(null);

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
      await approveRfpOverride(dealId, { note, officeId });
      toast.success("Override approved — the RFP was re-submitted for a fresh approval.");
      setNote("");
      await refetch();
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
      await reconfirmRfpDecline(dealId, { note, officeId });
      toast.success("Denial re-confirmed — this RFP stays declined.");
      setNote("");
      await refetch();
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
                This RFP was declined in the first go/no-go round. Approve the override to re-submit it, or
                re-confirm the denial.
              </CardDescription>
            </div>
            <StatusBadge review={review} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DealFacts review={review} />

          {review.actionable ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rfp-override-note">Note (optional)</Label>
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
                  {submitting === "approve" ? "Approving…" : "Approve override (re-submit RFP)"}
                </Button>
                <Button variant="destructive" onClick={onReconfirm} disabled={busy}>
                  {submitting === "reconfirm" ? "Confirming…" : "Re-confirm denial"}
                </Button>
              </div>
            </>
          ) : (
            <ReviewOutcome review={review} />
          )}
        </CardContent>
        <CardFooter>
          <Link to={dealHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Open the full deal
          </Link>
        </CardFooter>
      </Card>
    </PageFrame>
  );
}

function StatusBadge({ review }: { review: RfpReviewDetail }) {
  if (review.reviewDecision === "denial_reconfirmed") {
    return <Badge variant="destructive">Denial re-confirmed</Badge>;
  }
  if (review.rfpApprovalStatus === "declined") {
    return <Badge variant="destructive">Declined</Badge>;
  }
  if (review.rfpApprovalStatus === "approved") {
    return <Badge variant="default">Approved</Badge>;
  }
  return <Badge variant="secondary">{review.rfpApprovalStatus ?? "Unknown"}</Badge>;
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
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <p className="font-medium text-foreground">
        This RFP is no longer awaiting a second-look review.
      </p>
      <p className="mt-1 text-muted-foreground">
        Its current status is “{review.rfpApprovalStatus ?? "unknown"}”. If it was approved/re-submitted, it
        will proceed through the normal RFP approval pipeline.
      </p>
    </div>
  );
}
