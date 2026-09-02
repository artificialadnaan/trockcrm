import { AlertTriangle, ExternalLink, Glasses, Loader2, MapPin, PlayCircle } from "lucide-react";
import { GLASSES_WALK_NARRATION_SHORTFALL_WARN_MS } from "@trock-crm/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useDealGlassesWalkthroughs,
  type GlassesWalkthrough,
  type GlassesWalkthroughPipelineHealth,
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
/**
 * A timeline offset as `m:ss`, for naming the moment a still was taken.
 *
 * Minutes-and-seconds rather than a raw millisecond count because it is read next to a "watch this
 * moment" link, and `254800` tells an estimator nothing about where in a four-minute walk to look.
 * Hours are deliberately not handled: these are walk-length clips, and a clip long enough to need them
 * would be a different problem than formatting.
 */
export function formatWalkOffset(timelineMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timelineMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

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

/** The fallback when the server names a state this build predates. */
const UNKNOWN_STATE_BADGE = { label: "Unknown", className: "text-muted-foreground" };

const STATE_BADGE: Record<GlassesWalkthrough["state"], { label: string; className: string }> = {
  processing: { label: "Still processing", className: "border-amber-200 bg-amber-100 text-amber-800" },
  ready: { label: "Scope ready", className: "border-green-200 bg-green-100 text-green-800" },
  unavailable: { label: "Scope unavailable", className: "border-red-200 bg-red-100 text-red-800" },
  missing: { label: "No longer in TROCK Scope", className: "border-gray-200 bg-gray-100 text-gray-700" },
  // Red like `unavailable`, because both mean "do not treat the absence of scope as an answer" — but
  // worded as a statement about the EXTRACTION rather than about our reading of it, since this one is
  // TROCK Scope's own verdict and re-reading will not change it.
  failed: { label: "Extraction failed", className: "border-red-200 bg-red-100 text-red-800" },
};

/**
 * The shortfall as a sentence, or null when there is nothing worth saying.
 *
 * THE THRESHOLD IS THE SERVER'S, not a second opinion. `GLASSES_WALK_NARRATION_SHORTFALL_WARN_MS` is the
 * line the ingest already logs a warning at, so reusing it means the panel and ops agree about which
 * walks are bad — a client-side copy would eventually disagree, and the argument would be about which
 * number was right rather than about the walk.
 *
 * It is not zero, and the gap is where the real defects hide: the census counts seconds the phone
 * actually wrote while the walk clock runs to the moment somebody taps stop, so a second or two of
 * shortfall is an encoder tail. Warning on that would put an amber line on every healthy walk, which is
 * the fastest way to teach an estimator to ignore amber lines. The two walks that motivated the counter
 * were short by 30 s and 3.8 min.
 */
export function describeNarrationShortfall(shortfallMs: number | null): string | null {
  // `null` is "no census, so we do not know", which is NOT "nothing was lost" — the two must never
  // collapse, and a `!shortfallMs` check would merge them and also swallow a genuine 0.
  if (shortfallMs === null || !Number.isFinite(shortfallMs)) return null;
  if (shortfallMs <= GLASSES_WALK_NARRATION_SHORTFALL_WARN_MS) return null;
  return `Narration ${Math.round(shortfallMs / 1000)} s short — audio stopped during the walk.`;
}

/**
 * The chip for TROCK Scope's OWN account of a walk, as distinct from the CRM's.
 *
 * THREE TIERS, and the middle one is the point. `failed` and `held` are the states an estimator has to
 * act on and they carry the warning style; `processing` says work is genuinely under way over there, in a
 * neutral style that reads as motion rather than as a problem; `settled` and `empty` are quiet, because
 * the state badge beside them has already said the same thing in words the estimator cares about more.
 *
 * QUIET IS NOT ABSENT, deliberately. A rendered chip is how anyone can tell the field ARRIVED — during a
 * rollout where most responses carry nothing, "no chip" would be indistinguishable from "TROCK Scope says
 * everything is fine", and the first person to ask "is the health field live yet?" would have no way to
 * find out from the screen.
 */
const PIPELINE_CHIP: Record<string, { className: string; tone: "warning" | "neutral" | "quiet" }> = {
  processing: { className: "border-blue-200 bg-blue-50 text-blue-800", tone: "neutral" },
  settled: { className: "border-gray-200 bg-gray-100 text-gray-600", tone: "quiet" },
  empty: { className: "border-gray-200 bg-gray-100 text-gray-600", tone: "quiet" },
  failed: { className: "border-red-200 bg-red-100 text-red-800", tone: "warning" },
  held: { className: "border-red-200 bg-red-100 text-red-800", tone: "warning" },
  // Terminal, and the scope on screen is real — but it was extracted from media that has since changed.
  // Warning rather than quiet: an estimator pricing from a stale list has no way to know it is stale.
  stale: { className: "border-amber-200 bg-amber-100 text-amber-800", tone: "warning" },
};

/** The fallback for a pipeline state this build predates. Neutral and NAMED: TROCK Scope owns this
 *  vocabulary and adds to it without asking, and showing the unrecognised word is strictly more useful
 *  than hiding it — the reader can at least quote it. Mirrors UNKNOWN_STATE_BADGE's reasoning. */
const UNKNOWN_PIPELINE_CHIP = { className: "border-gray-200 bg-gray-100 text-gray-700", tone: "quiet" as const };

/**
 * TROCK Scope's health chip, plus — for the states worth acting on — the stage and reason behind it.
 *
 * The stage rides in the chip because it is short and identifies WHERE it stopped; the reason is a
 * sentence TROCK Scope wrote and gets its own line rather than being truncated into a label. Both are
 * optional on the wire and each is omitted on its own.
 */
function PipelineHealthChip({ pipeline }: { pipeline: GlassesWalkthroughPipelineHealth }) {
  const chip = PIPELINE_CHIP[pipeline.state] ?? UNKNOWN_PIPELINE_CHIP;
  const label = pipeline.stage ? `${pipeline.state} · ${pipeline.stage}` : pipeline.state;
  return (
    <Badge
      variant="outline"
      className={chip.className}
      // The reason is on the badge too, so it is reachable on a state whose tone does not earn its own
      // line — and so the full text survives when a long reason is wrapped or clipped below.
      title={pipeline.reason ?? `TROCK Scope reports this walk as ${pipeline.state}.`}
    >
      {label}
    </Badge>
  );
}

/** One extracted line item. Every field except the description is optional on the wire, and each one that is
 *  absent is rendered as absent rather than as a placeholder value — see formatWalkQuantity. */
function ScopeItemRow({ item, reviewUrl }: { item: GlassesWalkthroughScopeItem; reviewUrl: string | null }) {
  const confidence = describeConfidence(item.confidence);
  const quantity = formatWalkQuantity(item.quantity, item.unit);
  const description = item.description.trim();
  // Anything that is not explicitly "spoken" is treated as inferred, INCLUDING an absent value. An older
  // TROCK Scope build that does not send the field must not have its silence read as "somebody said it".
  const inferredQuantity = item.quantity !== null && item.quantitySource !== "spoken";

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
        {/* WHERE, WHAT TRADE, AND HOW THE NUMBER WAS ARRIVED AT — one line, because on a list of a dozen
            rows these are scanned rather than read. `quantitySource` is the one an estimator acts on: a
            number somebody said out loud and a number the model inferred are different claims. */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {item.locationLabel ? (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {item.locationLabel}
            </span>
          ) : null}
          {item.trade ? <span>{item.trade}</span> : null}
          {inferredQuantity ? (
            <span className="text-amber-700" title="TROCK Scope inferred this quantity; nobody stated it.">
              inferred quantity
            </span>
          ) : null}
          {item.lowVisualConfidence ? (
            <span className="text-amber-700" title="The footage behind this line was hard to read.">
              low visual confidence
            </span>
          ) : null}
          {item.hasOpenConflict ? (
            <span className="text-red-700" title="TROCK Scope recorded a disagreement nobody has resolved.">
              unresolved conflict
            </span>
          ) : null}
        </div>

        {/* THE CITATION. Rendered under the row rather than behind a click because it is the reason to
            trust or distrust the line, and a panel that hides its evidence one interaction away is a
            panel whose evidence nobody reads. */}
        {item.evidence.map((mention, index) => {
          // Resolved per mention rather than per row: a merged row's mentions can sit in different
          // clips, and only some of them may have landed a proxy transcode yet.
          const watchHref =
            reviewUrl && mention.timelineMs !== null
              ? `${reviewUrl}?t=${Math.round(mention.timelineMs)}`
              : mention.clipUrl;
          return (
          <div key={`${item.id}-${index}`} className="mt-2 border-l-2 border-muted pl-2">
            <p className="text-xs italic text-muted-foreground">“{mention.quote}”</p>
            {mention.mentionedQuantity !== null ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                said: {formatWalkQuantity(mention.mentionedQuantity, mention.mentionedUnit) ?? "—"}
              </p>
            ) : null}
            {mention.frames.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {mention.frames.map((frame) => (
                  <img
                    key={frame.url}
                    src={frame.url}
                    // Described by what it IS rather than what it shows: nothing here knows the latter,
                    // and inventing a description of a jobsite photo would be worse than naming it.
                    alt={`Still from the walk${
                      frame.timelineMs !== null ? ` at ${formatWalkOffset(frame.timelineMs)}` : ""
                    }`}
                    loading="lazy"
                    className="h-16 w-24 rounded border object-cover"
                  />
                ))}
              </div>
            ) : null}
            {/* Straight to the moment, not merely to the walkthrough.
                PREFERS THE REVIEW SCREEN, FALLS BACK TO THE CLIP ITSELF. The review screen is the better
                destination — it has the transcript, the neighbouring rows and the controls to correct
                what is wrong. But its origin is a build-time variable that is legitimately unset (see
                lib/trock-scope.ts), and the evidence response already carries a presigned URL for the
                clip. Requiring the origin meant an estimator could see the stills and not watch the
                footage they were cut from, with a working link sitting unused in the payload. */}
            {watchHref ? (
              <a
                href={watchHref}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <PlayCircle className="h-3 w-3" aria-hidden="true" />
                {reviewUrl && mention.timelineMs !== null ? "Watch this moment" : "Watch the clip"}
              </a>
            ) : null}
          </div>
          );
        })}
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
  // A state this build does not know about must still render a card. The server owns the contract and
  // can add a state before the client is redeployed; an undefined lookup here would take the whole
  // scoping tab down over a string, which is a far worse answer than an honest "unrecognised".
  const badge = STATE_BADGE[walkthrough.state] ?? UNKNOWN_STATE_BADGE;
  const items = walkthrough.scope?.items ?? [];
  const summary = summarizeScopeItems(items);
  // OFFERED WHENEVER THERE ARE CITATIONS AT ALL, not only once signed media has arrived.
  //
  // Two things need it and only one is obvious. The obvious one: frame and clip URLs are short-lived,
  // so a tab left open past the TTL shows broken stills. The one the first version missed: frames are
  // extracted AFTER transcription, so a freshly processed walk legitimately has quotes and no pictures
  // yet — and gating the control on media already being present hid the refresh exactly when it was
  // the only way to discover that the pictures had since landed. This panel does not poll.
  const hasCitations = items.some((item) => item.evidence.length > 0);

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Glasses className="h-4 w-4 shrink-0 text-muted-foreground" />
            {/* The capturer is appended to the SAME sentence rather than given its own line: on a deal with
                several walks, "who" is how an estimator tells them apart, and a second line would push the
                badge out of the heading row. Omitted entirely when unresolved — see the hook's type. */}
            <span className="text-sm font-semibold">
              Walk captured {formatCapturedAt(walkthrough.capturedAt)}
              {walkthrough.capturedByName ? ` by ${walkthrough.capturedByName}` : ""}
            </span>
            <Badge variant="outline" className={badge.className}>
              {badge.label}
            </Badge>
            {/* BESIDE the state badge, never instead of it. The badge is what the CRM can vouch for;
                this is TROCK Scope's own account, and it can say things the CRM cannot infer at all —
                that the walk was HELD on purpose, or that the scope on screen is STALE against media
                that changed under it. Absent whenever that service did not say, which is every response
                until it ships the field. */}
            {walkthrough.pipeline ? <PipelineHealthChip pipeline={walkthrough.pipeline} /> : null}
          </div>
        </div>
        {/* Absent when TROCK Scope's origin is not configured for this build, or when this walk has no remote
            walkthrough yet. Never a guessed host — see lib/trock-scope.ts. */}
        {/* NOT for `missing`: TROCK Scope has answered 404 for this id, so the card already says the
            walkthrough is gone. Offering "Review in TROCK Scope" beside that sends the estimator to a
            page guaranteed to be missing — a link whose destination this component already knows does
            not exist. Visibility is about the STATE, not merely about whether a URL can be built. */}
        {reviewUrl && walkthrough.state !== "missing" ? (
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
        {/* WHY TROCK SCOPE STOPPED, in its own words — but only for the states an estimator can act on.
            A reason on a `settled` walk is bookkeeping; a reason on a `failed` or `held` one is the whole
            message, and truncating it into the chip's label would lose the half that says what to do. */}
        {walkthrough.pipeline?.reason &&
        (PIPELINE_CHIP[walkthrough.pipeline.state]?.tone ?? UNKNOWN_PIPELINE_CHIP.tone) === "warning" ? (
          <p className="mb-2 text-sm text-red-700">{walkthrough.pipeline.reason}</p>
        ) : null}

        {/* HOW MUCH OF THE WALK NOBODY NARRATED. Rendered for EVERY state, above the state-specific
            content, because it is a fact about the recording rather than about the extraction: a walk
            whose scope read failed still lost the same minutes of audio, and a walk that came back
            `ready` with a short list needs this to explain why the list is short. Nothing here is
            recoverable by retrying — the audio was never captured — so it is a statement, not an error
            with a control. */}
        {describeNarrationShortfall(walkthrough.narrationShortfallMs) ? (
          <p className="mb-2 flex items-start gap-2 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{describeNarrationShortfall(walkthrough.narrationShortfallMs)}</span>
          </p>
        ) : null}

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

        {/* NO RETRY CONTROL, deliberately, and that is the difference from `unavailable`. This is TROCK
            Scope's own verdict on the extraction, not our failure to read it, so re-reading returns the
            same answer. What it needs is someone to look at the walkthrough, which is what the review
            link beside it is for. Said plainly because the alternative — an empty scope with no
            explanation — is indistinguishable from a walk that genuinely had nothing in it. */}
        {walkthrough.state === "failed" ? (
          <p className="text-sm text-muted-foreground">
            TROCK Scope could not extract a scope from this walk. Nothing was produced, which is not the
            same as the walk having no scope in it — the narration is still there to be looked at.
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
            {/* PRESIGNED URLS EXPIRE, and a deal page is left open for hours. TROCK Scope signs the
                frame and clip URLs with a short TTL, and the images are lazy — so an estimator who
                scrolls to a later citation after the TTL lapses gets broken stills even though the
                evidence is perfectly healthy. There is no per-walk refresh route, so this re-reads the
                deal's walks exactly as the other retry controls do, which re-signs everything. */}
            {hasCitations ? (
              <div className="flex justify-end">
                <RetryButton label="Refresh evidence" onRetry={onRetry} retrying={retrying} />
              </div>
            ) : null}
            <ul className="divide-y">
              {items.map((item) => (
                <ScopeItemRow key={item.id} item={item} reviewUrl={reviewUrl} />
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

  // ONLY WHEN THERE IS NOTHING TO SHOW. The hook deliberately keeps the walks it already loaded when a
  // refetch fails, and replacing them with this card threw that away — so an estimator who pressed
  // "Refresh evidence" and hit a transient failure lost the scope they were reading, in exchange for
  // re-signing pictures. A failure with cards in hand is reported ALONGSIDE them, below.
  if (error && walkthroughs.length === 0) {
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
        {/* A refetch that failed while we still hold walks. Said here rather than in place of them:
            the cards below are the last good answer, and they are still worth reading. Muted, because
            what it reports is "this may be out of date", not "this is wrong". */}
        {error ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            Couldn’t refresh — showing the last loaded scope.
            <RetryButton label="Try again" onRetry={() => void refetch()} retrying={loading} />
          </p>
        ) : null}
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
