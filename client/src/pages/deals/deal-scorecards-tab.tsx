import { useCallback, useState } from "react";
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
} from "@trock-crm/shared/types";
import { isApiError } from "@/lib/api";
import { useDealScorecards, fetchDealScorecardDetail, downloadDealScorecardPdf } from "@/hooks/use-deal-scorecards";

const RATING_BADGE: Record<ScorecardRating, string> = {
  elite: "bg-green-100 text-green-800 border-green-200",
  on_standard: "bg-blue-100 text-blue-800 border-blue-200",
  needs_improvement: "bg-amber-100 text-amber-800 border-amber-200",
  corrective_action: "bg-red-100 text-red-800 border-red-200",
};
// Corrective-action lifecycle badge (spec §9): open = a response is required, closed = every flagged item
// resolved. A plain `submitted` card has no badge (returns null).
export function correctiveActionStatusBadge(
  status: string | undefined,
): { label: string; className: string } | null {
  if (status === "corrective_action_open") {
    return { label: "Corrective Action Open", className: "bg-red-100 text-red-800 border-red-200" };
  }
  if (status === "corrective_action_closed") {
    return { label: "Corrective Action Closed", className: "bg-green-100 text-green-800 border-green-200" };
  }
  return null;
}

function formatRespondedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

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
        <ScorecardRow key={sc.id} dealId={dealId} summary={sc} />
      ))}
    </div>
  );
}

function ScorecardRow({ dealId, summary }: { dealId: string; summary: FieldScorecardSummary }) {
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
            <ScorecardDetailView detail={detail} />
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

export function ScorecardDetailView({ detail }: { detail: FieldScorecardDetail }) {
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
  const resolvedCount = (correctiveActions ?? []).filter((i) => i.status === "resolved").length;
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

      {hasCorrectiveActions && totalCount > 0 && (
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Corrective Actions</h4>
          <span className={`text-xs font-medium ${allResolved ? "text-green-700" : "text-red-600"}`}>
            {resolvedCount} / {totalCount} resolved
          </span>
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
                  {ca && <CorrectiveActionResponse item={ca} />}
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
                  {ca && <CorrectiveActionResponse item={ca} />}
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
            <p>Superintendent: {detail.superintendentSignature || "—"}</p>
            <p>Project manager: {detail.pmSignature || "—"}</p>
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

// The inline corrective-action RESPONSE threaded directly beneath its ORIGINAL flagged item (action item /
// critical deficiency) — an open/resolved pill, then responder + date + comment + response photos (spec §9).
// A resolved item reads as the before/after; a still-open item shows an "Awaiting response" hint. Rendered
// under each original list item by ScorecardDetailView, so the flagged label is never duplicated.
export function CorrectiveActionResponse({ item }: { item: CorrectiveActionItemView }) {
  const respondedAt = formatRespondedAt(item.respondedAt);
  const isResolved = item.status === "resolved";
  return (
    <div className="mt-1.5 rounded-md border border-gray-200 bg-white p-2.5">
      <Badge
        variant="outline"
        className={
          isResolved
            ? "bg-green-100 text-green-800 border-green-200"
            : "bg-amber-100 text-amber-800 border-amber-200"
        }
      >
        {isResolved ? "Resolved" : "Open"}
      </Badge>
      {isResolved ? (
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
          {item.photos.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {item.photos.map((p) =>
                p.url ? (
                  <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="group block">
                    <img
                      src={p.url}
                      alt={p.caption ?? "Corrective action photo"}
                      className="aspect-square w-full rounded-md object-cover ring-1 ring-gray-200 group-hover:ring-gray-400"
                    />
                    {/* Persisted caption shown visually beneath the thumbnail, mirroring evidence-photo
                        captions above (not just the img alt). */}
                    {p.caption && <p className="mt-0.5 truncate text-[11px] text-gray-500">{p.caption}</p>}
                  </a>
                ) : (
                  <div key={p.id} className="flex aspect-square items-center justify-center rounded-md bg-gray-100 text-[11px] text-gray-400">
                    Unavailable
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs italic text-gray-400">Awaiting corrective-action response.</p>
      )}
    </div>
  );
}
