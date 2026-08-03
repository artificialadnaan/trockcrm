import { AlertTriangle, ExternalLink, Glasses, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useDealGlassesWalkthroughs,
  type GlassesWalkthrough,
  type GlassesWalkthroughScopeItem,
} from "@/hooks/use-glasses-walkthroughs";
import { buildTrockScopeReviewUrl } from "@/lib/trock-scope";

/**
 * The AI-walk panel: what TROCK Scope pulled out of a glasses walkthrough, shown beside the scope the
 * estimator is writing by hand.
 *
 * READ-ONLY, DELIBERATELY. There is no accept, no reject, and no edit here. A corrected line item has to
 * exist in TROCK Scope — that service owns the extraction and re-runs the pipeline off its own record — so
 * an "accept" in the CRM would create a second copy of the truth that nothing reconciles, and the next
 * export from TROCK Scope would silently overwrite or contradict it. The link out to the review screen is
 * therefore not a convenience; it is the whole correction path.
 *
 * IT IS AN INPUT TO THE SCOPING WORKSPACE, NOT A TAB. It renders inside DealScopingWorkspace, next to the
 * scope the estimator is assembling, because that is the job it feeds. A top-level tab would put the walk
 * one navigation away from the only screen it is useful on.
 *
 * ABSENT, NOT EMPTY, when a deal has no walks — which is nearly every deal today. Rendering an empty box on
 * every scoping tab would teach estimators to scroll past this region before it ever has anything in it.
 */

/**
 * Thresholds for the three confidence bands, named so they can be argued with.
 *
 * TROCK Scope's confidence is a model's own estimate, and the items it returns really do carry values like
 * 0.50 — a coin flip on whether the line exists as described. Rendering "50%" in the same grey type as
 * "92%" makes the two look like the same kind of fact, and the predictable outcome is a 0.50 priced as if
 * somebody measured it. So the bands exist to say what the estimator should DO, not to decorate the number:
 * high means the walk agrees with itself, medium means read the line before you price it, low means treat
 * it as a prompt to go and look.
 *
 * The exact cut points are a first cut and are meant to be recalibrated once TROCK Scope publishes bands of
 * its own — they are here, as constants with this comment, rather than inline in a ternary, so that
 * recalibration is one edit and shows up in a diff as a decision.
 */
export const CONFIDENCE_HIGH_MIN = 0.85;
export const CONFIDENCE_MEDIUM_MIN = 0.6;

export type ConfidenceBand = "high" | "medium" | "low" | "unscored";

export interface ConfidenceDescription {
  band: ConfidenceBand;
  /** The chip's own words. Carries the band IN TEXT, never colour alone — the distinction this whole
   *  function exists to draw has to survive a greyscale print and a colour-blind reader. */
  label: string;
  /** The sentence behind the chip, surfaced as its `title`. Says what to do, not just what the number is. */
  detail: string;
  className: string;
}

/**
 * One line item's confidence, as something a human can act on.
 *
 * NULL IS NOT ZERO, and the two must not collapse into each other. A null means TROCK Scope did not score
 * the item — nothing is known about how sure it is — while 0 is a score, and a damning one. A `!confidence`
 * check would merge them and would additionally swallow a genuine 0, which is why every test below on this
 * value is written against `null` explicitly.
 *
 * A value outside 0–1 is reported as unscored WITH the raw number in the detail rather than multiplied by
 * 100. If TROCK Scope ever switches to a 0–100 scale, the naive conversion would print "7800%" beside a
 * line item; and quietly clamping it to "100%" would invent a certainty nobody computed. Showing that we
 * do not recognise the value is the only reading that is not a fabrication.
 */
export function describeConfidence(confidence: number | null): ConfidenceDescription {
  if (confidence === null || !Number.isFinite(confidence)) {
    return {
      band: "unscored",
      label: "No confidence score",
      detail:
        "TROCK Scope returned no confidence for this line item. That is not the same as a low score — nothing is known about how sure it is.",
      className: "border-gray-200 bg-gray-100 text-gray-700",
    };
  }

  if (confidence < 0 || confidence > 1) {
    return {
      band: "unscored",
      label: "Unrecognised confidence",
      detail:
        `TROCK Scope returned ${confidence} for this line item, which is not a 0-1 confidence. It is shown as ` +
        `unknown rather than converted, because guessing the scale would put a number in front of you that nobody computed.`,
      className: "border-gray-200 bg-gray-100 text-gray-700",
    };
  }

  const percent = Math.round(confidence * 100);

  if (confidence >= CONFIDENCE_HIGH_MIN) {
    return {
      band: "high",
      label: `High · ${percent}%`,
      detail: `TROCK Scope is ${percent}% confident in this line item.`,
      className: "border-green-200 bg-green-100 text-green-800",
    };
  }

  if (confidence >= CONFIDENCE_MEDIUM_MIN) {
    return {
      band: "medium",
      label: `Medium · ${percent}%`,
      detail: `TROCK Scope is ${percent}% confident in this line item. Check it against the walk before you price it.`,
      className: "border-amber-200 bg-amber-100 text-amber-800",
    };
  }

  return {
    band: "low",
    label: `Low · ${percent}%`,
    detail: `TROCK Scope is only ${percent}% confident in this line item. Treat it as a prompt to look, not as a measurement.`,
    className: "border-red-200 bg-red-100 text-red-800",
  };
}

/**
 * The quantity as an estimator reads it, or null for "TROCK Scope did not extract one".
 *
 * Returning null rather than "0" or "—" is the point: a missing quantity is work still to do, and a zero is
 * a measurement. The caller renders the difference in words. Note the `=== null` guards — a genuine 0 SF
 * has to survive, and `if (!quantity)` would delete it.
 *
 * A unit with no quantity still renders ("SF"), because it tells the estimator what the line is measured in
 * even before anyone has measured it.
 */
export function formatWalkQuantity(quantity: number | null, unit: string | null): string | null {
  const amount =
    quantity === null || !Number.isFinite(quantity)
      ? null
      : quantity.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (amount === null && !unit) return null;
  return [amount, unit].filter(Boolean).join(" ");
}

/**
 * Date AND time. A crew can walk the same building twice in a morning, and two entries reading only "Aug 2"
 * are indistinguishable in a list whose whole ordering claim is "newest walk first". Matches the scorecard
 * tab's `formatRespondedAt` for the same reason.
 *
 * An unparseable timestamp is echoed verbatim rather than rendered as "Invalid Date": the raw string is at
 * least evidence of what the server sent, and is something a reader can quote in a bug report.
 */
export function formatCapturedAt(iso: string): string {
  const captured = new Date(iso);
  if (Number.isNaN(captured.getTime())) return iso;
  return captured.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** How many of a walk's items an estimator has to go and check. Drives the one-line summary above the list,
 *  so the answer to "is any of this shaky" does not require reading every chip. Unscored items count as
 *  needing verification: an item nobody scored is not an item anybody vouched for. */
export function summarizeScopeItems(items: GlassesWalkthroughScopeItem[]): {
  total: number;
  needsVerification: number;
} {
  const needsVerification = items.filter((item) => {
    const band = describeConfidence(item.confidence).band;
    return band === "low" || band === "unscored";
  }).length;
  return { total: items.length, needsVerification };
}

const STATE_BADGE: Record<GlassesWalkthrough["state"], { label: string; className: string }> = {
  processing: { label: "Still processing", className: "border-amber-200 bg-amber-100 text-amber-800" },
  ready: { label: "Scope ready", className: "border-green-200 bg-green-100 text-green-800" },
  unavailable: { label: "Scope unavailable", className: "border-red-200 bg-red-100 text-red-800" },
  missing: { label: "No longer in TROCK Scope", className: "border-gray-200 bg-gray-100 text-gray-700" },
};

/** One extracted line item. Every field except the description is optional on the wire, and each one that is
 *  absent is rendered as absent rather than as a placeholder value — see formatWalkQuantity. */
function ScopeItemRow({ item }: { item: GlassesWalkthroughScopeItem }) {
  const confidence = describeConfidence(item.confidence);
  const quantity = formatWalkQuantity(item.quantity, item.unit);
  const description = item.description.trim();

  return (
    <li
      // Low and unscored items are also marked on the ROW, not only in the chip, so a shaky line is visible
      // while scanning the list rather than only when reading it.
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-l-2 py-2 pl-3 ${
        confidence.band === "low" || confidence.band === "unscored" ? "border-red-300" : "border-transparent"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* Rendered only when TROCK Scope sends a code; today it never does (it returns the work-type
              uuid instead, which the server refuses to pass off as a code). Absent, not "—". */}
          {item.workTypeCode ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {item.workTypeCode}
            </span>
          ) : null}
          <span className={`text-sm ${description ? "text-foreground" : "italic text-muted-foreground"}`}>
            {description || "No description extracted"}
          </span>
        </div>
        {item.trade ? <p className="mt-0.5 text-xs text-muted-foreground">{item.trade}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className={`text-sm ${quantity ? "text-foreground" : "italic text-muted-foreground"}`}>
          {quantity ?? "No quantity extracted"}
        </span>
        <Badge variant="outline" className={confidence.className} title={confidence.detail}>
          {confidence.label}
        </Badge>
      </div>
    </li>
  );
}

/**
 * One walk. Exported so every state can be rendered in a test without standing up the fetch.
 *
 * `onRetry` re-reads the WHOLE deal's walks, because the endpoint is deal-scoped — there is no per-walk
 * retry route, and inventing one would mean a second server surface for a button. The control is offered on
 * `unavailable` (where it is the documented escape hatch: that state says only that we could not read, so
 * asking again is exactly the right response) and on `processing` (where the answer genuinely changes over
 * time and the panel does not poll — see DealAiWalkPanel). It is NOT offered on `missing`: TROCK Scope has
 * answered about that walkthrough, and re-asking a settled negative is a button that does nothing.
 *
 * `retrying` is deal-wide rather than per-walk for the same reason, so every card's control goes busy
 * together. That is the truth about what one click does, and it is less confusing than a spinner on one
 * card while the request behind it is refreshing all of them.
 */
export function AiWalkCard({
  walkthrough,
  onRetry,
  retrying = false,
  reviewUrl = buildTrockScopeReviewUrl(walkthrough.scopeWalkthroughId),
}: {
  walkthrough: GlassesWalkthrough;
  onRetry: () => void;
  retrying?: boolean;
  reviewUrl?: string | null;
}) {
  const badge = STATE_BADGE[walkthrough.state];
  const items = walkthrough.scope?.items ?? [];
  const summary = summarizeScopeItems(items);

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Glasses className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-semibold">Walk captured {formatCapturedAt(walkthrough.capturedAt)}</span>
            <Badge variant="outline" className={badge.className}>
              {badge.label}
            </Badge>
          </div>
        </div>
        {/* Absent when TROCK Scope's origin is not configured for this build, or when this walk has no remote
            walkthrough yet. Never a guessed host — see lib/trock-scope.ts. */}
        {reviewUrl ? (
          <a
            href={reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            Review in TROCK Scope
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>

      <div className="mt-3">
        {walkthrough.state === "processing" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Still processing. TROCK Scope has not returned a scope for this walk yet.
            </p>
            <RetryButton label="Check again" onRetry={onRetry} retrying={retrying} />
          </div>
        ) : null}

        {walkthrough.state === "unavailable" ? (
          <div className="space-y-2">
            <p className="flex items-start gap-2 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {/* The wording matters: this says we could not READ, not that there is nothing there. Telling
                  an estimator their walk had produced nothing, every time TROCK Scope restarted, would be
                  worse than telling them nothing at all. */}
              <span>
                Scope unavailable. We could not reach TROCK Scope for this walk, so we do not know whether it
                has a scope.
              </span>
            </p>
            <RetryButton label="Retry" onRetry={onRetry} retrying={retrying} />
          </div>
        ) : null}

        {walkthrough.state === "missing" ? (
          <p className="text-sm text-muted-foreground">
            No longer in TROCK Scope. That service has no record of this walkthrough, so there is nothing to
            show or to retry.
          </p>
        ) : null}

        {walkthrough.state === "ready" && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scope extracted. TROCK Scope processed this walk and returned no line items.
          </p>
        ) : null}

        {walkthrough.state === "ready" && items.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {summary.total} {summary.total === 1 ? "line item" : "line items"}
              {summary.needsVerification > 0 ? ` · ${summary.needsVerification} to verify` : ""}
            </p>
            <ul className="divide-y">
              {items.map((item) => (
                <ScopeItemRow key={item.id} item={item} />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RetryButton({
  label,
  onRetry,
  retrying,
}: {
  label: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
      {retrying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
      {retrying ? "Checking…" : label}
    </Button>
  );
}

/**
 * The panel as the scoping workspace mounts it.
 *
 * IT DOES NOT POLL. The server's read is built to be polled (it commits its pooled connection before
 * fanning out for exactly that reason), and a `processing` walk does become `ready` on its own — but an
 * interval firing under every open deal page for a panel that is empty on nearly every deal is a cost paid
 * by every deal to serve a few, and the panel would still need a manual control for the `unavailable` case
 * regardless. So one control does both jobs, and the decision to add polling stays available and cheap:
 * `refetch` already exists and is already wired to the buttons.
 */
export function DealAiWalkPanel({ dealId }: { dealId: string }) {
  const { walkthroughs, loading, hasLoaded, error, refetch } = useDealGlassesWalkthroughs(dealId);

  // Nothing at all until the answer is in. Most deals have no glasses walk, so rendering a skeleton here
  // would flash a panel onto every scoping tab and then take it away again.
  if (!hasLoaded) return null;

  if (error) {
    // Deliberately quiet — muted, not the red treatment the workspace uses for a failed scoping-intake load.
    // This panel is supplementary to the scope an estimator writes by hand; if it fails to load, the tab is
    // still doing its job, and an alarm here would read as "the scoping tab is broken".
    return (
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm text-muted-foreground">
          <span>Couldn’t load AI walks for this deal.</span>
          <RetryButton label="Try again" onRetry={() => void refetch()} retrying={loading} />
        </CardContent>
      </Card>
    );
  }

  // Absent, not an empty box. See the module header.
  if (walkthroughs.length === 0) return null;

  return (
    <Card className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Glasses className="h-4 w-4 text-muted-foreground" />
          AI Walk
        </CardTitle>
        <CardDescription>
          Scope that TROCK Scope extracted from a glasses walkthrough of this project. Read-only and
          AI-generated — verify a line before you price it, and make corrections in TROCK Scope.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {walkthroughs.map((walkthrough) => (
          <AiWalkCard
            key={walkthrough.id}
            walkthrough={walkthrough}
            onRetry={() => void refetch()}
            retrying={loading}
          />
        ))}
      </CardContent>
    </Card>
  );
}
