import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Hourglass,
  RefreshCw,
  Clock,
  AlertTriangle,
  XCircle,
  Flame,
  Inbox,
} from "lucide-react";
import { usePendingRfp, type PendingRfpDeal } from "@/hooks/use-deals";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const PENDING_RFP_STALE_DAYS = 2;

function computeAgeDays(triggeredAt: string | null): number | null {
  if (!triggeredAt) return null;
  return Math.floor((Date.now() - new Date(triggeredAt).getTime()) / 86_400_000);
}

function formatWaiting(days: number | null): string {
  if (days === null) return "—";
  if (days <= 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/** Urgency tone for the "Waiting" pill: neutral until stale (2d+), amber, then red past 4d. */
function waitingTone(days: number | null, isStale: boolean): string {
  if (days === null) return "bg-slate-100 text-slate-500";
  if (days >= 4) return "bg-red-100 text-red-700";
  if (isStale) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-600";
}

type StatusMeta = { label: string; Icon: typeof Clock; chip: string };
function statusMeta(deal: PendingRfpDeal): StatusMeta {
  if (deal.subState === "awaiting") {
    return { label: "Awaiting approval", Icon: Clock, chip: "bg-sky-50 text-sky-700 ring-sky-600/20" };
  }
  switch (deal.rfpApprovalStatus) {
    case "declined":
      return { label: "Declined", Icon: XCircle, chip: "bg-rose-50 text-rose-700 ring-rose-600/20" };
    case "conflict":
      return { label: "Conflict", Icon: AlertTriangle, chip: "bg-amber-50 text-amber-800 ring-amber-600/20" };
    case "send_failed":
      return { label: "Send failed", Icon: AlertTriangle, chip: "bg-red-50 text-red-700 ring-red-600/20" };
    default:
      return { label: "Needs attention", Icon: AlertTriangle, chip: "bg-amber-50 text-amber-800 ring-amber-600/20" };
  }
}

const AVATAR_TONES = [
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];
function initials(name: string | null): string {
  if (!name) return "—";
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "—";
}
function avatarTone(name: string | null): string {
  if (!name) return "bg-slate-100 text-slate-500";
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Clock;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-white px-4 py-3 shadow-sm">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xl font-semibold leading-none text-slate-900">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

export function PendingRfpPage() {
  const { deals, loading, error, refetch } = usePendingRfp();
  const location = useLocation();
  const navigate = useNavigate();

  const rows = useMemo(() => {
    const list = (deals ?? []).map((deal) => {
      const ageDays = computeAgeDays(deal.triggeredAt);
      return { deal, ageDays, isStale: ageDays !== null && ageDays >= PENDING_RFP_STALE_DAYS };
    });
    // Surface the most urgent first: needs-attention before awaiting, then longest-waiting first.
    return list.sort((a, b) => {
      const attentionDelta =
        (a.deal.subState === "attention" ? 0 : 1) - (b.deal.subState === "attention" ? 0 : 1);
      if (attentionDelta !== 0) return attentionDelta;
      return (b.ageDays ?? -1) - (a.ageDays ?? -1);
    });
  }, [deals]);

  const stats = useMemo(() => {
    const total = rows.length;
    const attention = rows.filter((r) => r.deal.subState === "attention").length;
    const stale = rows.filter((r) => r.isStale).length;
    return { total, attention, awaiting: total - attention, stale };
  }, [rows]);

  const showQueue = !error && rows.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <Hourglass className="h-5 w-5" />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">Pending RFP</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Deals awaiting RFP approval — visible to everyone in your office.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch().catch(() => undefined);
          }}
          disabled={loading}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* At-a-glance stats (only with data) */}
      {showQueue && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile icon={Hourglass} label="Total pending" value={stats.total} tone="bg-slate-100 text-slate-600" />
          <StatTile icon={AlertTriangle} label="Needs attention" value={stats.attention} tone="bg-amber-100 text-amber-700" />
          <StatTile icon={Clock} label="Awaiting approval" value={stats.awaiting} tone="bg-sky-100 text-sky-700" />
          <StatTile icon={Flame} label={`Stale (${PENDING_RFP_STALE_DAYS}d+)`} value={stats.stale} tone="bg-red-100 text-red-700" />
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      {/* Queue */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
              ))}
              <p className="sr-only">Loading pending RFPs...</p>
            </div>
          ) : showQueue ? (
            <>
              <div className="flex items-center justify-between border-b px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Queue</p>
                <p className="text-xs text-muted-foreground">Needs attention shown first</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2.5">Deal</th>
                      <th className="px-4 py-2.5">Rep</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Waiting</th>
                      <th className="px-4 py-2.5">Triggered by</th>
                      <th className="px-4 py-2.5">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ deal, ageDays, isStale }) => {
                      const to = `/deals/${deal.id}${location.search}`;
                      const meta = statusMeta(deal);
                      const displayNumber = deal.projectNumber ?? deal.dealNumber;
                      return (
                        <tr
                          key={deal.id}
                          data-testid={`pending-rfp-row-${deal.id}`}
                          data-stale={isStale ? "true" : "false"}
                          onClick={() => navigate(to)}
                          className={`group cursor-pointer border-b transition-colors last:border-b-0 ${
                            isStale ? "hover:bg-red-50/70" : "hover:bg-slate-50"
                          }`}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${isStale ? "bg-red-500" : "bg-transparent"}`}
                                aria-hidden
                              />
                              <div className="min-w-0">
                                <Link
                                  to={to}
                                  onClick={(e) => e.stopPropagation()}
                                  className="font-semibold text-slate-900 group-hover:text-brand-red hover:underline"
                                >
                                  {deal.name}
                                </Link>
                                <p className="text-xs text-muted-foreground">
                                  {displayNumber ?? "No number"}
                                  {deal.workflowRoute === "service" && (
                                    <span className="ml-1.5 rounded bg-violet-50 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700">
                                      Service
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span
                                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${avatarTone(deal.assignedRepName)}`}
                              >
                                {initials(deal.assignedRepName)}
                              </span>
                              <span className="truncate text-slate-700">{deal.assignedRepName ?? "—"}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${meta.chip}`}
                            >
                              <meta.Icon className="h-3.5 w-3.5" />
                              {meta.label}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${waitingTone(ageDays, isStale)}`}
                            >
                              {isStale && <Flame className="h-3 w-3" />}
                              {formatWaiting(ageDays)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{deal.triggeredByName ?? "—"}</td>
                          <td className="max-w-[220px] px-4 py-3 text-slate-500">
                            {deal.reason ? (
                              <span className="block truncate" title={deal.reason}>
                                {deal.reason}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : !error ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <Inbox className="h-6 w-6" />
              </span>
              <p className="text-sm font-medium text-slate-700">No deals are currently awaiting RFP approval</p>
              <p className="text-xs text-muted-foreground">
                Triggered RFPs land here and stay until they&apos;re approved.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
