import { Link } from "react-router-dom";
import { RefreshCcw } from "lucide-react";

import { InterventionAnalyticsBreachQueue } from "@/components/ai/intervention-analytics-breach-queue";
import { InterventionAnalyticsHotspots } from "@/components/ai/intervention-analytics-hotspots";
import { InterventionAnalyticsOutcomes } from "@/components/ai/intervention-analytics-outcomes";
import { InterventionAnalyticsSlaRules } from "@/components/ai/intervention-analytics-sla-rules";
import { InterventionAnalyticsSummaryStrip } from "@/components/ai/intervention-analytics-summary-strip";
import { Button, buttonVariants } from "@/components/ui/button";
import { buildInterventionWorkspacePath } from "@/hooks/use-admin-interventions";
import { useInterventionAnalytics } from "@/hooks/use-ai-ops";

export function AdminInterventionAnalyticsPage() {
  const { data, loading, error, refetch } = useInterventionAnalytics();

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Intervention Analytics</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Manager-first SLA oversight, breach analysis, and intervention outcomes
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={buildInterventionWorkspacePath({ view: "open" })} className={buttonVariants({ variant: "outline" })}>
            Open Intervention Workspace
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

      {loading && !data ? (
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-6 text-sm text-slate-500">
          Loading intervention analytics...
        </div>
      ) : data ? (
        <>
          <InterventionAnalyticsSummaryStrip summary={data.summary} />
          <InterventionAnalyticsOutcomes outcomes={data.outcomes} />
          <InterventionAnalyticsHotspots hotspots={data.hotspots} />
          <InterventionAnalyticsBreachQueue breachQueue={data.breachQueue} />
          <InterventionAnalyticsSlaRules slaRules={data.slaRules} />
        </>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-6 text-sm text-slate-500">
          No intervention analytics are available yet.
        </div>
      )}
    </div>
  );
}
