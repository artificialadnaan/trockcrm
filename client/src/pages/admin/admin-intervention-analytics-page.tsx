import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, ClipboardCheck, Clock3, Radar, RefreshCcw, Send, ShieldAlert, Users2 } from "lucide-react";
import {
  runManagerAlertScan,
  sendManagerAlertSummary,
  useInterventionAnalytics,
  useManagerAlertSnapshot,
  type ManagerAlertSnapshot,
} from "@/hooks/use-ai-ops";
import { InterventionAnalyticsBreachQueue } from "@/components/ai/intervention-analytics-breach-queue";
import { InterventionAnalyticsHotspots } from "@/components/ai/intervention-analytics-hotspots";
import { InterventionAnalyticsOutcomes } from "@/components/ai/intervention-analytics-outcomes";
import { InterventionAnalyticsSlaRules } from "@/components/ai/intervention-analytics-sla-rules";
import { InterventionAnalyticsSummaryStrip } from "@/components/ai/intervention-analytics-summary-strip";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function formatOfficeLocalTime(snapshot: ManagerAlertSnapshot["snapshotJson"]) {
  const date = new Date(snapshot.generatedAt);
  if (Number.isNaN(date.getTime())) return "Unknown local time";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: snapshot.timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function getSnapshotTimestampLabel(snapshot: ManagerAlertSnapshot) {
  if (snapshot.snapshotMode === "sent" && snapshot.sentAt) return "Sent snapshot";
  return "Latest scan snapshot";
}

export function getManagerAlertSnapshotFreshness(snapshot: ManagerAlertSnapshot | null) {
  if (!snapshot) return -Infinity;

  const candidates = [snapshot.sentAt, snapshot.scannedAt, snapshot.updatedAt, snapshot.createdAt];
  return candidates.reduce((latest, value) => {
    if (!value) return latest;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
  }, -Infinity);
}

export function selectNewestManagerAlertSnapshot(
  current: ManagerAlertSnapshot | null,
  incoming: ManagerAlertSnapshot | null
) {
  if (!incoming) return current;
  if (!current) return incoming;

  return getManagerAlertSnapshotFreshness(incoming) >= getManagerAlertSnapshotFreshness(current) ? incoming : current;
}

export function shouldShowManagerAlertHookError(
  error: string | null,
  snapshot: ManagerAlertSnapshot | null
) {
  return Boolean(error && !snapshot);
}

function ManagerAlertsPanel() {
  const { data, loading, error } = useManagerAlertSnapshot();
  const [snapshot, setSnapshot] = useState<ManagerAlertSnapshot | null>(null);
  const [working, setWorking] = useState<"preview" | "send" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setSnapshot((current) => selectNewestManagerAlertSnapshot(current, data));
  }, [data]);

  async function handlePreview() {
    setWorking("preview");
    setStatusMessage(null);
    setActionError(null);
    try {
      const nextSnapshot = await runManagerAlertScan();
      setSnapshot(nextSnapshot);
      setStatusMessage("Preview refreshed. No notifications were sent.");
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to run manager alert scan");
    } finally {
      setWorking(null);
    }
  }

  async function handleSend() {
    setWorking("send");
    setStatusMessage(null);
    setActionError(null);
    try {
      const result = await sendManagerAlertSummary();
      setSnapshot(result.snapshot);
      const claimed = result.deliveries.filter((delivery) => delivery.claimed).length;
      setStatusMessage(`Sent alerts to ${claimed} manager${claimed === 1 ? "" : "s"}.`);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to send manager alerts");
    } finally {
      setWorking(null);
    }
  }

  const displaySnapshot = snapshot ?? data;
  const previewDisabled = working !== null;
  const isEmptyState = !loading && !displaySnapshot;
  const showHookError = shouldShowManagerAlertHookError(error, displaySnapshot);

  return (
    <Card className="border-border/80 bg-white shadow-sm">
      <CardHeader className="space-y-4 xl:flex xl:flex-row xl:items-start xl:justify-between xl:space-y-0">
        <div className="space-y-2">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            Manager Alerts
          </CardTitle>
          <CardDescription>
            Latest scan snapshot only. Preview refreshes the panel without sending notifications.
          </CardDescription>
          {displaySnapshot && (
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
              <span className="rounded-full border border-border bg-white px-2 py-1 text-[10px] font-semibold text-gray-700">
                {getSnapshotTimestampLabel(displaySnapshot)}
              </span>
              <span>Office-local time: {formatOfficeLocalTime(displaySnapshot.snapshotJson)}</span>
              <span>Timezone: {displaySnapshot.snapshotJson.timezone}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void handlePreview()} disabled={previewDisabled}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Run Manager Alert Scan
          </Button>
          <Button onClick={() => void handleSend()} disabled={previewDisabled}>
            <Send className="mr-2 h-4 w-4" />
            Send Alerts
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {showHookError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        {actionError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {actionError}
          </div>
        )}
        {statusMessage && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {statusMessage}
          </div>
        )}

        {loading && !displaySnapshot ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            Loading latest manager alert snapshot...
          </div>
        ) : isEmptyState ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No manager alert snapshot has been generated yet. Run a preview to generate the first scan.
          </div>
        ) : (
          displaySnapshot && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Link
                  to={displaySnapshot.snapshotJson.families.overdueHighCritical.queueLink}
                  className="block rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm transition-transform hover:-translate-y-0.5 hover:border-brand-red/30"
                >
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Overdue high/critical</div>
                  <div className="mt-2 text-4xl font-black text-gray-900">
                    {displaySnapshot.snapshotJson.families.overdueHighCritical.count}
                  </div>
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">
                    Cases breaching SLA thresholds with highest urgency.
                  </div>
                </Link>
                <Link
                  to={displaySnapshot.snapshotJson.families.snoozeBreached.queueLink}
                  className="block rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm transition-transform hover:-translate-y-0.5 hover:border-brand-red/30"
                >
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Snooze breaches</div>
                  <div className="mt-2 text-4xl font-black text-gray-900">
                    {displaySnapshot.snapshotJson.families.snoozeBreached.count}
                  </div>
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">
                    Cases whose snooze window has expired.
                  </div>
                </Link>
                <Link
                  to={displaySnapshot.snapshotJson.families.escalatedOpen.queueLink}
                  className="block rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm transition-transform hover:-translate-y-0.5 hover:border-brand-red/30"
                >
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Escalated open</div>
                  <div className="mt-2 text-4xl font-black text-gray-900">
                    {displaySnapshot.snapshotJson.families.escalatedOpen.count}
                  </div>
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">
                    Cases still unresolved after escalation.
                  </div>
                </Link>
                <div className="rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm">
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Overloaded assignees</div>
                  <div className="mt-2 text-4xl font-black text-gray-900">
                    {displaySnapshot.snapshotJson.families.assigneeOverload.count}
                  </div>
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">
                    Weight threshold {displaySnapshot.snapshotJson.families.assigneeOverload.threshold}. Use the
                    assignee links below to jump into the queue.
                  </div>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-xl border border-border/80 bg-muted/10 px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Clock3 className="h-4 w-4 text-muted-foreground" />
                        <h3 className="font-semibold text-gray-900">Latest scan details</h3>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Office-local date {displaySnapshot.snapshotJson.officeLocalDate} · generated{" "}
                        {formatOfficeLocalTime(displaySnapshot.snapshotJson)}
                      </p>
                    </div>
                    <span className="rounded-full border border-border bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-gray-700">
                      {displaySnapshot.snapshotMode}
                    </span>
                  </div>
                  <div className="mt-4 text-sm leading-6 text-muted-foreground">
                    Scan results are deterministic and are the same snapshot that powers the alert family counts
                    above.
                  </div>
                </div>

                <div className="rounded-xl border border-border/80 bg-white px-4 py-4">
                  <div className="flex items-center gap-2">
                    <Users2 className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-gray-900">Top overloaded assignees</h3>
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">
                    Direct links jump into the intervention queue filtered to each assignee.
                  </div>
                  <div className="mt-4 space-y-3">
                    {displaySnapshot.snapshotJson.families.assigneeOverload.items.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                        No assignee is above the overload threshold in the latest scan.
                      </div>
                    ) : (
                      displaySnapshot.snapshotJson.families.assigneeOverload.items.map((item) => (
                        <Link
                          key={item.assigneeId}
                          to={item.queueLink}
                          className="block rounded-lg border border-border/80 px-4 py-3 transition-colors hover:border-brand-red/40 hover:bg-muted/40"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-medium text-gray-900">{item.assigneeLabel}</div>
                              <div className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">
                                {item.caseCount} cases · weight {item.totalWeight}
                              </div>
                            </div>
                            <span className="rounded-full border border-border bg-white px-2 py-1 text-[10px] font-semibold text-gray-700">
                              Open queue
                            </span>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

export function AdminInterventionAnalyticsPage() {
  const { data, loading, error, refetch } = useInterventionAnalytics();

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Intervention Analytics</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Manager-first SLA oversight for intervention load, outcomes, and breach visibility
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/sales-process-disconnects" className={buttonVariants({ variant: "outline" })}>
            <Radar className="mr-2 h-4 w-4" />
            Process Disconnects
          </Link>
          <Link to="/admin/interventions" className={buttonVariants({ variant: "outline" })}>
            <ClipboardCheck className="mr-2 h-4 w-4" />
            Intervention Workspace
          </Link>
          <Button variant="outline" onClick={() => void refetch()} disabled={loading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <ManagerAlertsPanel />

      {!data && loading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Loading intervention analytics...</CardContent>
        </Card>
      ) : !data ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Intervention analytics are unavailable right now.
          </CardContent>
        </Card>
      ) : (
        <>
          <InterventionAnalyticsSummaryStrip summary={data.summary} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Manager Readout</CardTitle>
              <CardDescription>
                Use this page to understand whether the office is clearing intervention load or just moving it around.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-4">
              <div className="rounded-lg border border-border/80 bg-white px-4 py-4 text-sm leading-6 text-muted-foreground">
                Overdue cases, snooze breaches, repeat-open cases, and unresolved escalations all roll into the same
                manager oversight surface. Use hotspot links to jump directly into filtered writable views in the
                intervention workspace.
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-950">
                Focus the office first on <span className="font-semibold">overdue critical/high cases</span>, then on
                <span className="font-semibold"> repeat-open clusters</span> and <span className="font-semibold">snoozes that slipped past due</span>.
              </div>
            </CardContent>
          </Card>

          <InterventionAnalyticsOutcomes outcomes={data.outcomes} />
          <InterventionAnalyticsHotspots hotspots={data.hotspots} />
          <InterventionAnalyticsBreachQueue breachQueue={data.breachQueue} />
          <InterventionAnalyticsSlaRules rules={data.slaRules} />
        </>
      )}
    </div>
  );
}
