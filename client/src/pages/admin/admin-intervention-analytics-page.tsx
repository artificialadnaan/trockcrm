import { Link } from "react-router-dom";
import { BarChart3, ClipboardCheck, Radar, RefreshCcw } from "lucide-react";
import { useInterventionAnalytics } from "@/hooks/use-ai-ops";
import { InterventionAnalyticsBreachQueue } from "@/components/ai/intervention-analytics-breach-queue";
import { InterventionAnalyticsHotspots } from "@/components/ai/intervention-analytics-hotspots";
import { InterventionAnalyticsOutcomes } from "@/components/ai/intervention-analytics-outcomes";
import { InterventionAnalyticsSlaRules } from "@/components/ai/intervention-analytics-sla-rules";
import { InterventionAnalyticsSummaryStrip } from "@/components/ai/intervention-analytics-summary-strip";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
