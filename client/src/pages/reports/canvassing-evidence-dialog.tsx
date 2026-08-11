// The records behind ONE number on the Canvassing Activity report.
//
// Opened by clicking any count. The point is that the figures on that page can be checked: the dialog
// states the number it was opened from and lists what makes it up, and the server counts that total with
// the report's own predicate rather than a second hand-written one — so a mismatch is a bug, not a rounding
// difference someone has to reason about.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useOfficeScopeId, useOfficeScopedHref } from "@/hooks/use-office-scope";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  fetchCanvassingEvidence,
  type CanvassingBucket,
  type CanvassingEvidenceKind,
  type CanvassingEvidenceResult,
} from "@/hooks/use-reports";

export interface CanvassingEvidenceTarget {
  kind: CanvassingEvidenceKind;
  /** Null for an office-wide figure; `personName` then names the office view rather than a person. */
  userId: string | null;
  personName: string;
  /** Null for a whole-range total; otherwise the period column that was clicked. */
  bucketStart: string | null;
  periodLabel: string | null;
  /** What the cell showed, so the dialog can say plainly when the drill disagrees with it. */
  expected: number;
}

const KIND_NOUNS: Record<CanvassingEvidenceKind, string> = {
  company: "companies",
  property: "properties",
  contact: "contacts",
  lead: "leads",
  all: "records",
  unattributed: "records with no recorded author",
  notes: "notes",
};

/** Singular, for the badge the combined list puts on each row so a mixed list stays readable. */
const KIND_BADGES: Record<string, string> = {
  company: "Company",
  property: "Property",
  contact: "Contact",
  lead: "Lead",
};

function formatWhen(iso: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date(iso));
}

export function CanvassingEvidenceDialog({
  target,
  bucket,
  dateFrom,
  dateTo,
  onClose,
}: {
  target: CanvassingEvidenceTarget | null;
  bucket: CanvassingBucket;
  dateFrom?: string;
  dateTo?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CanvassingEvidenceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The evidence REQUEST is already office-scoped (api() derives x-office-id from ?officeId), so a bare
  // href on the way out pointed the detail page at the viewer's default tenant instead — the record either
  // does not exist there or is a different one. Same rule, and the same helper, as every report deal link.
  const scopedHref = useOfficeScopedHref();
  const officeScopeId = useOfficeScopeId();
  /** The office the open drill was requested under, so a scope change can be detected rather than ignored. */
  const requestedForOffice = useRef<string | null>(null);
  /** Likewise for the report's own scope: the bucket and date range the drill was opened under. */
  const openedForScope = useRef<string | null>(null);
  const currentScope = `${bucket}|${dateFrom ?? ""}|${dateTo ?? ""}`;

  // Close the drill if the REPORT SCOPE moves out from under it.
  //
  // `bucket`, `dateFrom` and `dateTo` are in the fetch effect's deps, so a Back/Forward or any other URL
  // change refetches against the NEW scope while `target` still describes the old cell: its `expected`,
  // its `bucketStart`, and the period named in its heading. Switching week -> month is the sharp case —
  // a week-start date sent as a monthly bucket boundary matches nothing, so the dialog renders zero
  // records and a mismatch banner under a heading naming a week. A drill belongs to the report that
  // opened it.
  //
  // SELF-CONTAINED, unlike the office guard below, and deliberately so: these three ARE fetch-effect
  // deps, so a scope change re-runs that effect too. Stamping the ref there would re-record the new
  // scope before this could compare, and the guard would never fire. Stamping on the null -> set
  // transition instead makes it independent of effect order.
  useEffect(() => {
    if (!target) {
      openedForScope.current = null;
      return;
    }
    if (openedForScope.current === null) {
      openedForScope.current = currentScope;
      return;
    }
    if (openedForScope.current !== currentScope) onClose();
  }, [target, currentScope, onClose]);

  useEffect(() => {
    if (!target) {
      setData(null);
      setError(null);
      return;
    }
    requestedForOffice.current = officeScopeId;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetchCanvassingEvidence({
      kind: target.kind,
      userId: target.userId,
      bucketStart: target.bucketStart,
      bucket,
      dateFrom,
      dateTo,
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load these records.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Cancelled rather than ignored: clicking through several cells quickly would otherwise let an earlier,
    // slower response paint over a later one, showing one cell's records under another cell's heading.
    return () => {
      cancelled = true;
    };
  }, [target, bucket, dateFrom, dateTo]);


  // Close the drill if the tenant scope moves out from under it.
  //
  // Neither the target nor the date range changes when ?officeId does — via the office switcher, or plain
  // browser history on this route — but the tenant every one of these ids belongs to does. The dialog would
  // keep showing the previous office's records while scopedHref had already rewritten every row link for the
  // NEW office: one tenant's list, another tenant's links, landing on whatever unrelated record happens to
  // share that id. Refetching instead would be wrong in its own way, because `expected` was read off the
  // previous office's report, so every row would then be accused of a mismatch. A drill belongs to the
  // report that opened it; when that report's scope changes, the drill is over.
  //
  // Declared AFTER the fetch effect deliberately. Effects run in declaration order, so the fetch effect has
  // already stamped requestedForOffice for a newly-opened target by the time this compares them — reversed,
  // this would fire against the initial null and close every dialog the instant it opened.
  useEffect(() => {
    if (!target || requestedForOffice.current === officeScopeId) return;
    onClose();
  }, [target, officeScopeId, onClose]);

  const noun = target ? KIND_NOUNS[target.kind] : "";
  const scope = target?.periodLabel ? `in ${target.periodLabel}` : "in the selected range";

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {target ? `${target.personName} — ${target.expected} ${noun}` : ""}
          </DialogTitle>
          <DialogDescription>
            {target?.kind === "notes"
              ? `Notes logged ${scope}.`
              : target?.kind === "unattributed"
                ? `Entered ${scope} with no creator recorded — these predate attribution or were machine-created.`
                : `New ${noun} entered ${scope}.`}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading records…
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : null}

        {!loading && !error && data ? (
          <div className="space-y-3">
            {/*
              The whole reason for a drill: say out loud when the list does not match the cell. Silently
              showing a different number of rows is how a reader learns to distrust every figure on the page.
            */}
            {data.total !== target?.expected ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                This drill counts <strong>{data.total}</strong> where the report showed{" "}
                <strong>{target?.expected}</strong>. The report may have been open long enough for the
                underlying records to change — reload it to compare like for like.
              </div>
            ) : null}

            {data.restrictedToSelf && data.rows.length === 0 && data.total > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm font-semibold text-slate-600">
                {data.total} {noun} logged, but you can only read your own.
              </div>
            ) : null}

            {data.rows.length === 0 && !(data.restrictedToSelf && data.total > 0) ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
                Nothing to show for this figure.
              </div>
            ) : null}

            <ul className="divide-y divide-slate-100">
              {data.rows.map((row) => (
                <li key={`${row.kind ?? target?.kind}-${row.id}`} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        {row.href ? (
                          <Link to={scopedHref(row.href)} className="text-sm font-semibold text-slate-900 hover:text-brand-red">
                            {row.label}
                          </Link>
                        ) : (
                          <p className="text-sm font-semibold text-slate-900">{row.label}</p>
                        )}
                        {/* Only on the combined list: "Acme Roofing" alone does not say company or lead. */}
                        {target?.kind === "all" && row.kind ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                            {KIND_BADGES[row.kind] ?? row.kind}
                          </span>
                        ) : null}
                      </div>
                      {/* What the note documents. Without it a note with a generic or empty subject
                          identifies nothing, and notes carry no link to recover the context from. */}
                      {row.attachedTo ? (
                        <p className="mt-1 text-xs font-semibold text-slate-500">On {row.attachedTo}</p>
                      ) : null}
                      {row.sublabel ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{row.sublabel}</p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-slate-500">{formatWhen(row.occurredAt)}</span>
                  </div>
                </li>
              ))}
            </ul>

            {data.truncated ? (
              <p className="text-xs font-semibold text-slate-500">
                Showing the most recent {data.rows.length} of {data.total} — narrow the range to see the rest.
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
