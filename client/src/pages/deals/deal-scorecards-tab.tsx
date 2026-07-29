import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, Download, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_V2_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES,
  type FieldScorecardSummary,
  type FieldScorecardDetail,
  type CorrectiveActionItemView,
  type ScorecardRating,
  isRenderableSignatureDataUrl,
  typedSignatureFallback,
} from "@trock-crm/shared/types";
import { isApiError } from "@/lib/api";
import { approveCorrectiveActions, rejectCorrectiveAction } from "@/hooks/use-corrective-actions";
import { useDealScorecards, fetchDealScorecardDetail, downloadDealScorecardPdf } from "@/hooks/use-deal-scorecards";

const RATING_BADGE: Record<ScorecardRating, string> = {
  elite: "bg-green-100 text-green-800 border-green-200",
  on_standard: "bg-blue-100 text-blue-800 border-blue-200",
  needs_improvement: "bg-amber-100 text-amber-800 border-amber-200",
  corrective_action: "bg-red-100 text-red-800 border-red-200",
};
// Corrective-action lifecycle badge (spec §9). Three states now: a response is required, the response is
// with the approver, or the approver accepted it. A plain `submitted` scorecard has no badge (returns null).
export function correctiveActionStatusBadge(
  status: string | undefined,
): { label: string; className: string } | null {
  if (status === "corrective_action_open") {
    return { label: "Corrective Action Open", className: "bg-red-100 text-red-800 border-red-200" };
  }
  if (status === "corrective_action_submitted") {
    // Amber, deliberately not green: work has been documented but nobody has accepted it yet.
    return { label: "Awaiting Approval", className: "bg-amber-100 text-amber-800 border-amber-200" };
  }
  if (status === "corrective_action_closed") {
    // Retains its stored name; it now means APPROVED, which is what the label says.
    return { label: "Corrective Action Approved", className: "bg-green-100 text-green-800 border-green-200" };
  }
  return null;
}

// Date AND time: these are timestamps, and several actions answered on the same day are otherwise
// indistinguishable in what is meant to be the record of who did what when. Matches the PDF and the emails.
function formatRespondedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Per-item state presentation, matching the PDF record's vocabulary and colours. */
const ITEM_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-red-100 text-red-800 border-red-200" },
  submitted: { label: "Awaiting approval", className: "bg-amber-100 text-amber-800 border-amber-200" },
  approved: { label: "Approved", className: "bg-green-100 text-green-800 border-green-200" },
  // Red like `open`, because it IS outstanding — the approver sent it back and the responder owes a fix.
  rejected: { label: "Rejected — needs rework", className: "bg-red-100 text-red-800 border-red-200" },
};

const EVENT_PRESENTATION: Record<string, { verb: string; className: string }> = {
  submitted: { verb: "Submitted", className: "text-gray-700" },
  approved: { verb: "Approved", className: "text-green-700" },
  rejected: { verb: "Rejected", className: "text-red-700" },
};

// Match each ORIGINAL flagged item (a critical-deficiency key or an action-item text) to its seeded
// corrective-action row, so the inline response threads directly beneath the item (spec §9). Mirrors how
// the server correlates them (corrective-actions-service.ts): a deficiency matches by its key (stable
// item_ref); an action item matches by LABEL AND CARDINALITY — the seed index (item_ref) is fragile, so a
// duplicate label maps to distinct occurrences, each consumed once. Returns lookups the list renderers use.
export function buildCorrectiveActionLookup(items: CorrectiveActionItemView[] | undefined): {
  deficiencyByKey: Map<string, CorrectiveActionItemView>;
  actionByLabel: Map<string, CorrectiveActionItemView[]>;
} {
  const deficiencyByKey = new Map<string, CorrectiveActionItemView>();
  const actionByLabel = new Map<string, CorrectiveActionItemView[]>();
  for (const item of items ?? []) {
    if (item.itemType === "critical_deficiency") {
      // First seed for a key wins (a stable key never duplicates in a well-formed card).
      if (!deficiencyByKey.has(item.itemRef)) deficiencyByKey.set(item.itemRef, item);
    } else if (item.itemType === "action_item") {
      const bucket = actionByLabel.get(item.itemLabel) ?? [];
      bucket.push(item);
      actionByLabel.set(item.itemLabel, bucket);
    }
  }
  return { deficiencyByKey, actionByLabel };
}

const SECTION_TITLE = new Map<string, string>(FIELD_SCORECARD_SECTIONS.map((s) => [s.key, s.title]));
const SECTION_MAX = new Map<string, number>(FIELD_SCORECARD_SECTIONS.map((s) => [s.key, s.maxPoints]));
const DEFICIENCY_LABEL = new Map<string, string>(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => [d.key, d.label]));
const V2_SECTION_TITLE = new Map<string, string>(FIELD_SCORECARD_V2_SECTIONS.map((s) => [s.key, s.title]));
const V2_DEFICIENCY_LABEL = new Map<string, string>(FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES.map((d) => [d.key, d.label]));
const LEADERSHIP_SECTION_TITLE = new Map<string, string>(FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((s) => [s.key, s.title]));

// Copy shown when the Download action fires before the async best-effort PDF has landed (the /download
// endpoint 404s while pdf_r2_key is still null). The server sends the friendly text in the error message.
const PDF_NOT_READY_TOAST = "The scorecard PDF is still generating — please try again shortly.";

function formatWeek(weekOf: string): string {
  const d = new Date(`${weekOf}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return weekOf;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
function formatSubmitted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function DealScorecardsTab({ dealId }: { dealId: string }) {
  const { scorecards, loading, error, refetch } = useDealScorecards(dealId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading scorecards…
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (scorecards.length === 0) {
    return (
      <div className="py-16 text-center">
        <ClipboardCheck className="mx-auto h-10 w-10 text-gray-300" />
        <p className="mt-3 text-sm font-medium text-gray-900">No field scorecards yet</p>
        <p className="mt-1 text-sm text-gray-500">
          Weekly scorecards submitted from T-Rock Cam for this project will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Field Scorecards <span className="text-gray-400">({scorecards.length})</span>
        </h3>
      </div>
      {scorecards.map((sc) => (
        <ScorecardRow key={sc.id} dealId={dealId} summary={sc} onCardChanged={refetch} />
      ))}
    </div>
  );
}

function ScorecardRow({
  dealId,
  summary,
  onCardChanged,
}: {
  dealId: string;
  summary: FieldScorecardSummary;
  onCardChanged?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<FieldScorecardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Leadership cards share these tables but are scored on a different model (4 categories / 10, no
  // deficiencies/signatures, a Project Summary + photos). The server detail read is now KIND-AWARE, so
  // BOTH kinds expand into the fetched full detail view — leadership renders category scores + comment
  // notes, the Project Summary text, and its evidence photos, so the card is fully viewable in the CRM
  // even when the best-effort PDF hasn't landed yet (the completed-email fallback points PM/Super here).
  const isLeadership = summary.kind === "leadership";

  const toggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    // Both kinds fetch the full detail on first expand (the server read branches on kind).
    if (next && !detail && !detailLoading) {
      setDetailLoading(true);
      try {
        setDetail(await fetchDealScorecardDetail(dealId, summary.id));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn’t load scorecard detail");
        setExpanded(false);
      } finally {
        setDetailLoading(false);
      }
    }
  }, [expanded, detail, detailLoading, dealId, summary.id]);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadDealScorecardPdf(dealId, summary.id);
    } catch (e) {
      // A best-effort PDF that finished generating moments after the deal loaded is downloadable without a
      // reload — the action always attempts, and a not-yet-ready 404 becomes a friendly "try again" toast
      // (the server's own message) instead of a hard error, mirroring the mobile PDF-404 handling.
      const notReady = isApiError(e) && e.status === 404;
      toast.error(notReady ? e.message || PDF_NOT_READY_TOAST : e instanceof Error ? e.message : "Couldn’t open the scorecard PDF.");
    } finally {
      setDownloading(false);
    }
  }, [dealId, summary.id]);

  // Leadership + V2 score out of 10 (average bands); legacy V1 project cards out of 100.
  const useAverage = isLeadership || summary.formVersion === 2;
  const scoreLabel = useAverage ? (summary.averageScore ?? summary.totalScore / 10).toFixed(1) : String(summary.totalScore);
  const scoreMax = useAverage ? "/10" : "/100";

  const header = (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          {isLeadership && (
            <Badge variant="outline" className="border-purple-200 bg-purple-100 text-purple-800">
              Leadership
            </Badge>
          )}
          <span className="text-sm font-semibold text-gray-900">Week of {formatWeek(summary.weekOf)}</span>
          {summary.criticalDeficiencyCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {summary.criticalDeficiencyCount}
            </span>
          )}
        </div>
        <span className="truncate text-xs text-gray-500">
          {[summary.superintendentName, summary.submittedByName ? `by ${summary.submittedByName}` : null, formatSubmitted(summary.submittedAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-lg font-bold text-gray-900">
          {scoreLabel}
          <span className="text-xs font-normal text-gray-400">{scoreMax}</span>
        </span>
        {(() => {
          const caBadge = correctiveActionStatusBadge(summary.status);
          return caBadge ? (
            <Badge variant="outline" className={caBadge.className}>
              {caBadge.label}
            </Badge>
          ) : null;
        })()}
        <Badge variant="outline" className={RATING_BADGE[summary.rating]}>
          {summary.ratingLabel}
        </Badge>
      </div>
    </>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-3 p-4">
        {/* Both kinds expand into the fetched full detail view (the server read is kind-aware). */}
        <button
          type="button"
          onClick={() => void toggle()}
          aria-expanded={expanded}
          className="flex flex-1 items-center gap-3 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
          )}
          {header}
        </button>
        {/* The stored PDF renders async (best-effort) and can finish moments after the deal opened, so the
            action ALWAYS attempts the download rather than staying permanently gated on the initial
            list-DTO hasPdf snapshot — a not-yet-ready 404 becomes a friendly "try again" toast (see
            download()), so it works once the key lands without a page reload. */}
        <Button variant="ghost" size="sm" onClick={() => void download()} disabled={downloading} title="Download PDF">
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 p-4">
          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-6 text-sm text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading detail…
            </div>
          ) : isLeadership ? (
            <LeadershipDetailView detail={detail} />
          ) : (
            <ScorecardDetailView
              detail={detail}
              dealId={dealId}
              // Re-read after an approval so the badges, the thread and the card status all move together.
              // The server is the source of truth for every one of them; optimistically patching the local
              // copy would risk showing a state the server did not actually reach.
              onApprovalChange={() => {
                // BOTH: the expanded thread AND the row header's lifecycle badge, which renders from the
                // list's summary. Refreshing only the detail left the row still reading "Awaiting Approval"
                // beside a thread showing the item approved — the same card contradicting itself on screen.
                void fetchDealScorecardDetail(dealId, summary.id).then(setDetail).catch(() => {});
                onCardChanged?.();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Full leadership detail — mirrors the mobile LeadershipBody / scorecardLeadershipRows shape: the 4 category
// scores (each /10) + comment notes, the Project Summary free text, and category/summary evidence photos.
// Plus a meta row (average/10, rating, week, evaluator=submittedByName). Leadership cards carry no critical
// deficiencies, action items, or signatures, so those sections are omitted. Renders from the kind-aware
// detail so the full card is viewable in the CRM even before the best-effort PDF lands.
export function LeadershipDetailView({ detail }: { detail: FieldScorecardDetail }) {
  const average = (detail.averageScore ?? detail.totalScore / 10).toFixed(1);
  // The 4 canonical leadership categories, in form order; an item absent from the detail shows 0/10.
  const itemByKey = new Map(detail.items.map((i) => [i.sectionKey, i]));
  const rows = FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((s) => {
    const item = itemByKey.get(s.key);
    return { key: s.key, title: s.title, points: item?.points ?? 0, note: item?.note ?? null };
  });
  const evidenceGroups = [
    ...FIELD_SCORECARD_LEADERSHIP_SECTIONS
      .map((section) => ({
        key: section.key,
        title: section.title,
        photos: detail.photos.filter((photo) => photo.sectionKey === section.key),
      }))
      .filter((group) => group.photos.length > 0),
    {
      key: FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
      title: "Project Summary",
      photos: detail.photos.filter((photo) => photo.sectionKey === FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY),
    },
  ].filter((group) => group.photos.length > 0);
  const meta: Array<{ label: string; value: string }> = [
    { label: "Average", value: `${average} / 10` },
    { label: "Rating", value: detail.ratingLabel },
    { label: "Week of", value: formatWeek(detail.weekOf) },
    { label: "Evaluator", value: detail.submittedByName ?? "—" },
    // Captured on the form + rendered in the mobile/PDF header; show them here too so the completed-email
    // fallback ("open the deal in the CRM") lands on a card header with the full PM / Superintendent context.
    { label: "Project manager", value: detail.pmName ?? "—" },
    { label: "Superintendent", value: detail.superintendentName ?? "—" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Category Scores</h4>
        <div className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
          {rows.map((row) => (
            <div key={row.key} className="px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-900">{LEADERSHIP_SECTION_TITLE.get(row.key) ?? row.title}</span>
                <span className="text-sm font-semibold text-gray-900">{row.points} / 10</span>
              </div>
              {row.note && <p className="mt-0.5 text-xs italic text-gray-500">{row.note}</p>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Project Summary</h4>
        <p className="whitespace-pre-wrap rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900">
          {detail.summary?.trim() || "No summary provided."}
        </p>
      </div>

      {evidenceGroups.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Evidence Photos ({detail.photos.length})
          </h4>
          <div className="space-y-3">
            {evidenceGroups.map((group) => (
              <div key={group.key}>
                <h5 className="mb-1 text-xs font-medium text-gray-700">{group.title}</h5>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {group.photos.map((p) =>
                    p.url ? (
                      <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="group block">
                        <img
                          src={p.url}
                          alt={p.caption ?? "Scorecard evidence"}
                          className="aspect-square w-full rounded-md object-cover ring-1 ring-gray-200 group-hover:ring-gray-400"
                        />
                        {p.caption && <p className="mt-0.5 truncate text-[11px] text-gray-500">{p.caption}</p>}
                      </a>
                    ) : (
                      <div key={p.id} className="flex aspect-square items-center justify-center rounded-md bg-gray-100 text-[11px] text-gray-400">
                        Unavailable
                      </div>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
        {meta.map((row) => (
          <div key={row.label} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm text-gray-500">{row.label}</span>
            <span className="text-sm font-semibold text-gray-900">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Bulk approve, with the same busy + error treatment as the per-item controls.
 *
 * Discarding the rejected promise left a transient network failure or an authorization change completely
 * invisible: nothing was approved, the UI did not move, and the only signal was the absence of a change —
 * which reads as a slow request, not a failure.
 */
function ApproveAllButton({
  onApproveAll,
  label = "Approve all",
}: {
  onApproveAll: () => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-xs text-red-700">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onApproveAll();
          } catch (err) {
            setError(isApiError(err) ? err.message : "Could not approve. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-md bg-green-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {busy ? "Approving…" : label}
      </button>
    </div>
  );
}

/** The submission each awaiting item is showing, so an approval refers to the work actually reviewed. */
function reviewedAttemptsOf(items: CorrectiveActionItemView[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    if (item.status !== "submitted") continue;
    const latest = [...(item.events ?? [])].reverse().find((e) => e.eventType === "submitted");
    if (latest) out[item.id] = latest.id;
  }
  return out;
}

export function ScorecardDetailView({
  detail,
  dealId,
  onApprovalChange,
}: {
  detail: FieldScorecardDetail;
  dealId?: string;
  onApprovalChange?: () => void;
}) {
  // The server decides; this only chooses whether to RENDER the controls.
  const canApprove = detail.canApproveCorrectiveActions === true;
  // The card generation the reviewer is acting on. Starts as the one this render came from; each verdict
  // returns the generation it produced, because every verdict advances it — without carrying that forward,
  // approving a second item before the refetch settles would 409 against the reviewer's OWN first click.
  const reviewedGeneration = useRef<string | null | undefined>(detail.updatedAt);
  useEffect(() => {
    reviewedGeneration.current = detail.updatedAt;
  }, [detail.updatedAt]);
  // A supersession 409 has to REFRESH, not just complain.
  //
  // The guards tell the reviewer to refresh, and there was nothing that did: collapsing and reopening the
  // row re-fetches only when `detail` is null, so the reviewer stayed on the same stale generation and every
  // retry returned the same 409 until they reloaded the page. A guard whose only escape hatch does not work
  // is worse than no guard — it reads as the feature being broken. Refetching here puts them on the current
  // version (and the effect above rebinds the generation), so the retry is the natural next click. The error
  // still surfaces, because the reviewer must know their verdict did NOT land and must be re-formed against
  // what they can now see.
  const refreshOnSupersession = async <T,>(verdict: () => Promise<T>): Promise<T> => {
    try {
      return await verdict();
    } catch (err) {
      if (
        isApiError(err) &&
        err.status === 409 &&
        (err.code === "CORRECTIVE_ACTION_CARD_SUPERSEDED" ||
          err.code === "CORRECTIVE_ACTION_ATTEMPT_SUPERSEDED")
      ) {
        onApprovalChange?.();
      }
      throw err;
    }
  };
  const approve = dealId
    ? async (itemId: string) => {
        const outcome = await refreshOnSupersession(() =>
          approveCorrectiveActions(
          dealId,
          detail.id,
            [itemId],
            reviewedAttemptsOf(correctiveActions),
            reviewedGeneration.current,
          ),
        );
        reviewedGeneration.current = outcome.generation ?? reviewedGeneration.current;
        onApprovalChange?.();
      }
    : undefined;
  const reject = dealId
    ? async (itemId: string, comment: string) => {
        // Same binding as approve: the reason has to land on the attempt that earned it. Without this a
        // rejecter looking at a stale page sends back work they never read, and restarts the responder's
        // cycle for a fault the responder may already have corrected.
        const outcome = await refreshOnSupersession(() =>
          rejectCorrectiveAction(
            dealId,
            detail.id,
            itemId,
            comment,
            reviewedAttemptsOf(correctiveActions)[itemId],
            reviewedGeneration.current,
          ),
        );
        reviewedGeneration.current = outcome.generation ?? reviewedGeneration.current;
        onApprovalChange?.();
      }
    : undefined;
  const approveAll = dealId
    ? async () => {
        // The IDs THE APPROVER IS LOOKING AT, not "everything awaiting approval at execution time".
        //
        // My first version omitted itemIds with a comment claiming it avoided skipping a sibling. It does the
        // opposite: a responder can submit another item between this page rendering and the click, and the
        // server would approve that unseen response too — potentially closing the card and sending the
        // approved notice for work nobody reviewed. Approving something the approver never saw is a far worse
        // failure than leaving a late arrival for the next pass, which is all this now does.
        const reviewed = (correctiveActions ?? [])
          .filter((i) => i.status === "submitted")
          .map((i) => i.id);
        // An empty list means the approver is accepting a card that reached "everything approved" by an
        // edit deleting the unapproved item, not that there is nothing to do — returning early, as this did,
        // left such a card with no way out. Send it as OMITTED rather than `[]`, which the route rejects:
        // absent means "everything awaiting approval", which here is correctly nothing. The server approves
        // no item, recomputes, and closes the card on the strength of the approver's acceptance.
        const outcome = await refreshOnSupersession(() =>
          approveCorrectiveActions(
            dealId,
            detail.id,
            reviewed.length > 0 ? reviewed : undefined,
            reviewedAttemptsOf(correctiveActions),
            reviewedGeneration.current,
          ),
        );
        reviewedGeneration.current = outcome.generation ?? reviewedGeneration.current;
        onApprovalChange?.();
      }
    : undefined;
  const isV2 = detail.formVersion === 2;
  const sectionTitle = isV2 ? V2_SECTION_TITLE : SECTION_TITLE;
  const deficiencyLabel = isV2 ? V2_DEFICIENCY_LABEL : DEFICIENCY_LABEL;
  // The card tripped the corrective-action band iff the API returned a (possibly empty) list; build the
  // key/label lookups once so each original deficiency / action item can thread its response inline.
  const correctiveActions = detail.correctiveActions;
  const hasCorrectiveActions = Array.isArray(correctiveActions);
  const { deficiencyByKey, actionByLabel } = buildCorrectiveActionLookup(correctiveActions);
  // Per-label occurrence counter so duplicate action labels each consume a distinct seeded row (multiset).
  const actionLabelSeen = new Map<string, number>();
  // APPROVED, not merely answered — and "resolved" is a value migration 0202 renamed away, so this counter
  // read zero on every card until now.
  const resolvedCount = (correctiveActions ?? []).filter((i) => i.status === "approved").length;
  const totalCount = correctiveActions?.length ?? 0;
  const allResolved =
    detail.status === "corrective_action_closed" || (totalCount > 0 && resolvedCount === totalCount);
  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Section Scores</h4>
        <div className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
          {detail.items.map((item) => (
            <div key={item.sectionKey} className="px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-900">{sectionTitle.get(item.sectionKey) ?? item.sectionKey}</span>
                <span className="text-sm font-semibold text-gray-900">
                  {item.points} / {isV2 ? 10 : SECTION_MAX.get(item.sectionKey) ?? "—"}
                </span>
              </div>
              {item.note && <p className="mt-0.5 text-xs italic text-gray-500">{item.note}</p>}
            </div>
          ))}
        </div>
      </div>

      {approveAll && shouldShowApproveAll(correctiveActions ?? [], canApprove, detail.status) && (
        <ApproveAllButton onApproveAll={approveAll} label={approveAllLabel(correctiveActions ?? [])} />
      )}

      {hasCorrectiveActions && totalCount > 0 && (
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Corrective Actions</h4>
          <span className={`text-xs font-medium ${allResolved ? "text-green-700" : "text-red-600"}`}>
            {resolvedCount} / {totalCount} approved
          </span>
        </div>
      )}

      {(detail.removedItemEvents?.length ?? 0) > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Removed by a later edit
          </h4>
          <p className="mb-2 text-xs italic text-gray-500">
            These flagged items were removed when the scorecard was edited. Their history is kept here.
          </p>
          <ol className="space-y-3 rounded-md border border-gray-200 bg-white p-2.5">
            {detail.removedItemEvents!.map((event) => {
              const presentation = EVENT_PRESENTATION[event.eventType] ?? EVENT_PRESENTATION.submitted;
              return (
                <li key={event.id} className="border-l-2 border-gray-200 pl-3">
                  {/* The item's own label — these have no item block above them to sit under. */}
                  {event.itemLabel && (
                    <p className="text-sm font-semibold text-gray-900">{event.itemLabel}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
                    <span className={`font-semibold ${presentation.className}`}>{presentation.verb}</span>
                    <span className="font-medium text-gray-700">
                      {event.actorName ?? event.actorEmail ?? "Unknown"}
                    </span>
                    {formatRespondedAt(event.createdAt) && (
                      <span>· {formatRespondedAt(event.createdAt)}</span>
                    )}
                  </div>
                  {event.comment && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{event.comment}</p>
                  )}
                  {/* Their evidence survives the item too — showing the words and hiding the photos would
                      claim the history is preserved while withholding half of it. */}
                  <CorrectiveActionPhotoGrid photos={event.photos} />
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {detail.criticalDeficiencies.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">Critical Deficiencies</h4>
          <ul className="list-inside list-disc space-y-1 text-sm text-gray-900">
            {detail.criticalDeficiencies.map((key) => {
              const ca = deficiencyByKey.get(key);
              return (
                <li key={key}>
                  {deficiencyLabel.get(key) ?? key}
                  {detail.criticalDeficiencyNotes?.[key] ? <span className="ml-1 text-gray-500">— {detail.criticalDeficiencyNotes[key]}</span> : null}
                  {ca && (
                    <CorrectiveActionResponse
                      item={ca}
                      canApprove={canApprove}
                      onApprove={approve}
                      onReject={reject}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {detail.actionItems.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Action Items</h4>
          <ol className="list-inside list-decimal space-y-1 text-sm text-gray-900">
            {detail.actionItems.map((a, i) => {
              // Consume seeded occurrences in order so duplicate labels thread under distinct occurrences.
              const bucket = actionByLabel.get(a);
              let ca: CorrectiveActionItemView | undefined;
              if (bucket) {
                const seen = actionLabelSeen.get(a) ?? 0;
                ca = bucket[seen];
                actionLabelSeen.set(a, seen + 1);
              }
              return (
                <li key={i}>
                  {a}
                  {ca && (
                    <CorrectiveActionResponse
                      item={ca}
                      canApprove={canApprove}
                      onApprove={approve}
                      onReject={reject}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {isV2 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Signatures</h4>
          <div className="space-y-1 text-sm text-gray-900">
            <SignatureBlock label="Superintendent" value={detail.superintendentSignature} />
            <SignatureBlock label="Project manager" value={detail.pmSignature} />
          </div>
        </div>
      )}

      {detail.photos.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Evidence Photos ({detail.photos.length})
          </h4>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {detail.photos.map((p) =>
              p.url ? (
                <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="group block">
                  <img
                    src={p.url}
                    alt={p.caption ?? "Scorecard evidence"}
                    className="aspect-square w-full rounded-md object-cover ring-1 ring-gray-200 group-hover:ring-gray-400"
                  />
                  {p.caption && <p className="mt-0.5 truncate text-[11px] text-gray-500">{p.caption}</p>}
                </a>
              ) : (
                <div key={p.id} className="flex aspect-square items-center justify-center rounded-md bg-gray-100 text-[11px] text-gray-400">
                  Unavailable
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One signature line. Mirrors the PDF's drawSignature exactly — both route through the shared
 * classification predicate, so a signature this renders as an image is one the PDF also draws.
 *
 * Three cases: a handwritten data-URL capture draws as an image; a legacy typed name renders as text; and
 * anything else — including a data URL of a type we will not render — falls back to an em dash. That last
 * case is the bug this replaced: the raw `data:image/png;base64,…` payload was printed as a text node.
 */
function SignatureBlock({ label, value }: { label: string; value: string | null | undefined }) {
  // The shared predicate validates the media type and the base64 ALPHABET, but it cannot prove the payload
  // decodes to a real image — `data:image/png;base64,====` passes it. The PDF catches that at draw time and
  // prints "Signature unavailable"; without this the web would render a broken <img> instead, so the two
  // surfaces would disagree on exactly the input the shared module exists to keep them agreeing on.
  const [imageFailed, setImageFailed] = useState(false);
  const typed = typedSignatureFallback(value);
  const showImage = isRenderableSignatureDataUrl(value) && !imageFailed;

  // A new value deserves a fresh attempt — otherwise switching scorecards inside the same mounted row would
  // keep showing the fallback from a previous card's bad signature.
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    lastValueRef.current = value;
    if (imageFailed) setImageFailed(false);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-gray-500">{label}:</span>
      {showImage ? (
        <img
          src={value as string}
          alt={`${label} signature`}
          className="h-12 max-w-[220px] object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className={typed ? "text-gray-900" : "text-gray-400"}>
          {typed ?? (imageFailed ? "Signature unavailable" : "—")}
        </span>
      )}
    </div>
  );
}

// The inline corrective-action RESPONSE threaded directly beneath its ORIGINAL flagged item (action item /
// critical deficiency) — an open/resolved pill, then responder + date + comment + response photos (spec §9).
// A resolved item reads as the before/after; a still-open item shows an "Awaiting response" hint. Rendered
// under each original list item by ScorecardDetailView, so the flagged label is never duplicated.
/**
 * Whether to render Approve / Reject for one item.
 *
 * Only for an authorized approver, and only while the item is actually waiting on them. A control that
 * always 403s trains people to ignore errors; one on an already-settled item invites a no-op that reads as
 * a bug. This is UX only — the route's allowlist check is the guarantee.
 */
export function shouldShowApprovalControls(item: { status: string }, canApprove: boolean): boolean {
  return canApprove && item.status === "submitted";
}

/** Approve-all earns its place only with more than one item waiting; otherwise it duplicates the per-item button. */
export function shouldShowApproveAll(
  items: Array<{ status: string }>,
  canApprove: boolean,
  cardStatus?: string,
): boolean {
  if (!canApprove) return false;
  const awaiting = items.filter((i) => i.status === "submitted").length;
  if (awaiting > 1) return true;
  // A card can also sit in the approver's queue with NOTHING awaiting: an edit deleted its last unapproved
  // item, so every survivor is approved but reaching that state was a deletion, not a verdict. The server
  // refuses to call that closed, and per-item controls render on `submitted` items — of which there are none
  // — so without this the card would sit in the queue with no control that acts on it, forever. This button
  // is the approver accepting the card as it now stands, which is the only thing that can close it.
  return awaiting === 0 && items.length > 0 && cardStatus === "corrective_action_submitted";
}

/** What the approve-all control is actually doing, which is not the same act in both cases. */
export function approveAllLabel(items: Array<{ status: string }>): string {
  return items.some((i) => i.status === "submitted") ? "Approve all" : "Accept edited card";
}

/** Telling the responder what to fix IS the rejection, so an empty comment is refused before the round trip. */
export function isRejectionCommentValid(comment: string): boolean {
  return comment.trim().length > 0;
}

/** Response photos as a thumbnail grid. Shared by the thread entries and the pre-thread fallback. */
function CorrectiveActionPhotoGrid({ photos }: { photos: CorrectiveActionItemView["photos"] }) {
  if (photos.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
      {photos.map((p) =>
        p.url ? (
          <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="group block">
            <img
              src={p.url}
              alt={p.caption ?? "Corrective action photo"}
              className="aspect-square w-full rounded-md object-cover ring-1 ring-gray-200 group-hover:ring-gray-400"
            />
            {/* Persisted caption shown visually beneath the thumbnail, mirroring evidence-photo captions
                above (not just the img alt). */}
            {p.caption && <p className="mt-0.5 truncate text-[11px] text-gray-500">{p.caption}</p>}
          </a>
        ) : (
          <div key={p.id} className="flex aspect-square items-center justify-center rounded-md bg-gray-100 text-[11px] text-gray-400">
            Unavailable
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Approve / Reject for one item. Rendered only when shouldShowApprovalControls says so; the route's
 * allowlist check remains the actual gate.
 */
function ApprovalControls({
  item,
  onApprove,
  onReject,
}: {
  item: CorrectiveActionItemView;
  onApprove: (itemId: string) => Promise<void>;
  onReject: (itemId: string, comment: string) => Promise<void>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(isApiError(err) ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (rejecting) {
    return (
      <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2">
        <label className="block text-xs font-medium text-gray-700" htmlFor={`reject-${item.id}`}>
          What still has to be fixed?
        </label>
        <textarea
          id={`reject-${item.id}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
          placeholder="The responder sees this, so say what is missing."
        />
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy || !isRejectionCommentValid(comment)}
            onClick={() => run(async () => { await onReject(item.id, comment.trim()); })}
            className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? "Sending back…" : "Send back"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setRejecting(false); setComment(""); setError(null); }}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => run(async () => { await onApprove(item.id); })}
        className="rounded-md bg-green-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {busy ? "Approving…" : "Approve"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setRejecting(true)}
        className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700"
      >
        Reject
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

export function CorrectiveActionResponse({
  item,
  canApprove = false,
  onApprove,
  onReject,
}: {
  item: CorrectiveActionItemView;
  canApprove?: boolean;
  onApprove?: (itemId: string) => Promise<void>;
  onReject?: (itemId: string, comment: string) => Promise<void>;
}) {
  const badge = ITEM_STATUS_BADGE[item.status] ?? ITEM_STATUS_BADGE.open;
  const events = item.events ?? [];
  // No thread but an answered item: a response filed before the event table existed, on a card the
  // migration seed did not reach. Render the single stored response rather than an empty box.
  const showsFallbackResponse = events.length === 0 && item.status !== "open";
  const respondedAt = formatRespondedAt(item.respondedAt);

  return (
    <div className="mt-1.5 rounded-md border border-gray-200 bg-white p-2.5">
      <Badge variant="outline" className={badge.className}>
        {badge.label}
      </Badge>

      {events.length > 0 && (
        <ol className="mt-2 space-y-3">
          {events.map((event) => {
            const presentation = EVENT_PRESENTATION[event.eventType] ?? EVENT_PRESENTATION.submitted;
            const who = event.actorName ?? event.actorEmail ?? "Unknown";
            const when = formatRespondedAt(event.createdAt);
            return (
              <li key={event.id} className="border-l-2 border-gray-200 pl-3">
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
                  <span className={`font-semibold ${presentation.className}`}>{presentation.verb}</span>
                  <span className="font-medium text-gray-700">{who}</span>
                  {when && <span>· {when}</span>}
                </div>
                {event.comment && (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{event.comment}</p>
                )}
                <CorrectiveActionPhotoGrid photos={event.photos} />
              </li>
            );
          })}
        </ol>
      )}

      {showsFallbackResponse && (
        <div className="mt-2 border-l-2 border-gray-200 pl-3">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="font-medium text-gray-700">
              {item.responderName ?? item.responderEmail ?? "Responder"}
            </span>
            {respondedAt && <span>· {respondedAt}</span>}
          </div>
          {item.responseComment && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{item.responseComment}</p>
          )}
          <CorrectiveActionPhotoGrid photos={item.photos} />
        </div>
      )}

      {events.length === 0 && !showsFallbackResponse && (
        <p className="mt-1 text-xs italic text-gray-400">Awaiting corrective-action response.</p>
      )}

      {onApprove && onReject && shouldShowApprovalControls(item, canApprove) && (
        <ApprovalControls item={item} onApprove={onApprove} onReject={onReject} />
      )}
    </div>
  );
}
