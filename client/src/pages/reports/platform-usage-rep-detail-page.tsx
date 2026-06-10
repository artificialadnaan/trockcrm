import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/layout/page-header";
import { usePlatformUsageDetail, type ActionDetailType } from "@/hooks/use-platform-usage-detail";

const ACTION_LABELS: Record<ActionDetailType, string> = {
  create: "Created",
  edit: "Edited",
  stage_move: "Stage move",
  upload: "Upload",
  note: "Note",
};
const ACTION_ORDER: ActionDetailType[] = ["create", "edit", "stage_move", "upload", "note"];

const BACK_TO = "/reports/performance/platform-usage";

export function PlatformUsageRepDetailPage() {
  const { repId = "" } = useParams();
  const [params] = useSearchParams();
  const grain = params.get("grain") === "day" ? "day" : "week";
  const date = params.get("date") || undefined;
  const { data, loading, error } = usePlatformUsageDetail({ repId, grain, date });

  const periodLabel = useMemo(() => {
    if (!data) return "";
    if (data.grain === "day") return data.dates[0] ?? "";
    return `${data.dates[0]} – ${data.dates[data.dates.length - 1]}`;
  }, [data]);

  // Carry the period back to the leaderboard so the round-trip stays on the same view.
  const backHref = `${BACK_TO}?grain=${grain}${date ? `&date=${date}` : ""}`;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link to={backHref} className="text-xs font-semibold text-slate-500 transition-colors hover:text-brand-red">
          ← Platform Usage
        </Link>
        <PageHeader
          eyebrow="Performance · Rep detail"
          title={data?.rep.displayName ?? "Rep detail"}
          description={data ? `${data.grain === "day" ? "Day" : "Week"} · ${periodLabel}` : undefined}
        />
        <div className="h-1 w-14 rounded-full bg-gradient-to-r from-[#CC0000] to-[#790000]" />
      </div>

      {loading ? <div className="text-sm text-slate-500">Loading…</div> : null}
      {error ? (
        <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-sm text-brand-red">{error}</div>
      ) : null}

      {data ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">Actions</h2>
            <div className="flex flex-wrap gap-2">
              {ACTION_ORDER.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs"
                >
                  <span className="font-bold tabular-nums text-slate-900">{data.actions.breakdown[t]}</span>
                  <span className="text-slate-500">{ACTION_LABELS[t]}</span>
                </span>
              ))}
            </div>
            <DetailList
              emptyLabel="No actions in this period."
              rows={data.actions.items.map((it, i) => ({
                key: `a${i}`,
                badge: ACTION_LABELS[it.type],
                label: it.label,
                at: it.at,
              }))}
              footnote={data.actions.truncated ? "Showing the 500 most recent actions." : undefined}
            />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">Views</h2>
            {data.views.expired ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {data.views.message ?? "View detail expired for this period — counts only."}
              </div>
            ) : (
              <DetailList
                emptyLabel="No record views in this period."
                rows={data.views.items.map((v, i) => ({
                  key: `v${i}`,
                  badge: v.entity_type,
                  label: v.label_snapshot ?? v.route,
                  at: v.at,
                }))}
              />
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function DetailList({
  rows,
  emptyLabel,
  footnote,
}: {
  rows: Array<{ key: string; badge: string; label: string; at: string }>;
  emptyLabel: string;
  footnote?: string;
}) {
  if (rows.length === 0) {
    return <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{emptyLabel}</div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-50">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 px-4 py-2.5">
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {r.badge}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{r.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatTimestamp(r.at)}</span>
          </li>
        ))}
      </ul>
      {footnote ? <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">{footnote}</div> : null}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  }).format(d);
}
