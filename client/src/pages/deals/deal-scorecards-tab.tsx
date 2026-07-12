import { useCallback, useState } from "react";
import { ClipboardCheck, Download, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_V2_SECTIONS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES,
  type FieldScorecardSummary,
  type FieldScorecardDetail,
  type ScorecardRating,
} from "@trock-crm/shared/types";
import { useDealScorecards, fetchDealScorecardDetail, downloadDealScorecardPdf } from "@/hooks/use-deal-scorecards";

const RATING_BADGE: Record<ScorecardRating, string> = {
  elite: "bg-green-100 text-green-800 border-green-200",
  on_standard: "bg-blue-100 text-blue-800 border-blue-200",
  needs_improvement: "bg-amber-100 text-amber-800 border-amber-200",
  corrective_action: "bg-red-100 text-red-800 border-red-200",
};
const SECTION_TITLE = new Map<string, string>(FIELD_SCORECARD_SECTIONS.map((s) => [s.key, s.title]));
const SECTION_MAX = new Map<string, number>(FIELD_SCORECARD_SECTIONS.map((s) => [s.key, s.maxPoints]));
const DEFICIENCY_LABEL = new Map<string, string>(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => [d.key, d.label]));
const V2_SECTION_TITLE = new Map<string, string>(FIELD_SCORECARD_V2_SECTIONS.map((s) => [s.key, s.title]));
const V2_DEFICIENCY_LABEL = new Map<string, string>(FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES.map((d) => [d.key, d.label]));

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
  // deficiencies/signatures) and have no project-shaped detail view — the server's detail read is
  // project-only, so the PDF is the view. Render the row NON-expandable, badge it "Leadership", show the
  // /10 average, and rely on the Download-PDF action (the completed-email fallback sends recipients here).
  const isLeadership = summary.kind === "leadership";

  const toggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
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
      toast.error(e instanceof Error ? e.message : "The PDF isn’t ready yet");
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
        <Badge variant="outline" className={RATING_BADGE[summary.rating]}>
          {summary.ratingLabel}
        </Badge>
      </div>
    </>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-3 p-4">
        {isLeadership ? (
          // No project detail view for leadership — the row itself just carries the summary + PDF action.
          <div className="flex flex-1 items-center gap-3">{header}</div>
        ) : (
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
        )}
        <Button variant="ghost" size="sm" onClick={() => void download()} disabled={downloading} title="Download PDF">
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </Button>
      </div>

      {!isLeadership && expanded && (
        <div className="border-t border-gray-100 bg-gray-50 p-4">
          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-6 text-sm text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading detail…
            </div>
          ) : (
            <ScorecardDetailView detail={detail} />
          )}
        </div>
      )}
    </div>
  );
}

export function ScorecardDetailView({ detail }: { detail: FieldScorecardDetail }) {
  const isV2 = detail.formVersion === 2;
  const sectionTitle = isV2 ? V2_SECTION_TITLE : SECTION_TITLE;
  const deficiencyLabel = isV2 ? V2_DEFICIENCY_LABEL : DEFICIENCY_LABEL;
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

      {detail.criticalDeficiencies.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">Critical Deficiencies</h4>
          <ul className="list-inside list-disc space-y-1 text-sm text-gray-900">
            {detail.criticalDeficiencies.map((key) => (
              <li key={key}>
                {deficiencyLabel.get(key) ?? key}
                {detail.criticalDeficiencyNotes?.[key] ? <span className="ml-1 text-gray-500">— {detail.criticalDeficiencyNotes[key]}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.actionItems.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Action Items</h4>
          <ol className="list-inside list-decimal space-y-1 text-sm text-gray-900">
            {detail.actionItems.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
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
