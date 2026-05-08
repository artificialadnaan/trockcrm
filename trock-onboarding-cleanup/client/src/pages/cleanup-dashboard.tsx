import { ArrowRight, BarChart3, CheckCircle2, ClipboardList, FileText, Loader2, Shuffle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button, Panel } from "../components/ui";
import { useCleanupMutations, useMe, useProgress, useQueue } from "../hooks/use-cleanup";
import type { QueueRecord, RecordType, RecordTypeSingular } from "../types/cleanup";
import { RECORD_TYPES, TYPE_TO_SINGULAR } from "../types/cleanup";

const labels: Record<RecordType, string> = {
  deals: "Deals",
  leads: "Leads",
  contacts: "Contacts",
  companies: "Companies",
};

const pluralBySingular: Record<RecordTypeSingular, RecordType> = {
  deal: "deals",
  lead: "leads",
  contact: "contacts",
  company: "companies",
};

function flatten(queue?: Record<RecordTypeSingular, QueueRecord[]>) {
  return queue ? Object.values(queue).flat() : [];
}

function statusCounts(records: QueueRecord[]) {
  return {
    remaining: records.filter((record) => record.cleanupStatus === "pending").length,
    completed: records.filter((record) => record.cleanupStatus === "completed").length,
    skipped: records.filter((record) => record.cleanupStatus === "skipped").length,
  };
}

function nextCleanupRoute(record: QueueRecord) {
  return `/cleanup/${pluralBySingular[record.type]}/${record.id}`;
}

export function CleanupDashboard() {
  const { data: user } = useMe();
  const { data: queue, isLoading: queueLoading } = useQueue();
  const { data: progress, isLoading: progressLoading } = useProgress();
  const { historicalPass, completeOnboarding } = useCleanupMutations();
  const navigate = useNavigate();
  const allRecords = flatten(queue);
  const closedEligible = queue?.deal.filter((record) => record.cleanupStatus === "pending" && (record.stage?.slug === "won" || record.stage?.slug === "lost")).length ?? 0;
  const completeDisabled = !progress?.canClearGate || completeOnboarding.isPending;
  const isAdmin = user?.role === "admin" || user?.role === "director";
  const nextPending = allRecords.find((record) => record.cleanupStatus === "pending");

  if (queueLoading || progressLoading) {
    return (
      <main className="grid min-h-[80vh] place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-red-700" />
      </main>
    );
  }

  const percent = progress && progress.totalAssigned > 0 ? Math.round(((progress.completed + progress.skipped) / progress.totalAssigned) * 100) : 0;
  const skippedCount = progress?.skipped ?? 0;

  if (isAdmin) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <section className="border-b border-stone-300 pb-6">
          <p className="text-sm font-bold uppercase tracking-wide text-red-800">Admin tools</p>
          <h1 className="mt-2 max-w-3xl text-3xl font-black tracking-tight text-stone-950 sm:text-4xl">
            Welcome {user?.firstName ?? user?.displayName ?? "there"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
            Admin and director accounts are not gated by personal cleanup assignments. Use these tools to route records and monitor cleanup.
          </p>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Panel className="p-5">
            <Shuffle className="h-5 w-5 text-red-800" />
            <h2 className="mt-3 text-xl font-black">Reassign records</h2>
            <p className="mt-1 text-sm text-stone-600">Move admin-queue records or stale assignments to the correct rep.</p>
            <Button className="mt-5 w-full" onClick={() => navigate("/admin/reassign")}>
              Open reassignment
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Panel>
          <Panel className="p-5">
            <BarChart3 className="h-5 w-5 text-red-800" />
            <h2 className="mt-3 text-xl font-black">Cleanup progress</h2>
            <p className="mt-1 text-sm text-stone-600">Track rep completion, skips, remaining work, and last activity.</p>
            <Button className="mt-5 w-full" onClick={() => navigate("/admin/progress")}>
              Open progress
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Panel>
          <Panel className="p-5">
            <FileText className="h-5 w-5 text-red-800" />
            <h2 className="mt-3 text-xl font-black">Cleanup report</h2>
            <p className="mt-1 text-sm text-stone-600">Generate a printable leadership summary of cleanup outcomes.</p>
            <Button className="mt-5 w-full" onClick={() => navigate("/admin/reports/cleanup-summary")}>
              Open report
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Panel>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-40 pt-6 sm:px-6 sm:pb-8 lg:py-8">
      <section className="flex flex-col gap-4 border-b border-stone-300 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-red-800">Migration cleanup</p>
          <h1 className="mt-2 max-w-3xl text-2xl font-black tracking-tight text-stone-950 sm:text-4xl">
            Welcome {user?.firstName ?? user?.displayName ?? "there"}. Finish your cleanup list to enter the CRM.
          </h1>
        </div>
        <div className="rounded-md border border-stone-300 bg-stone-50 px-4 py-3 text-sm text-stone-700 sm:min-w-44">
          <span className="font-bold text-stone-950">{progress?.remaining ?? 0}</span> items remaining
        </div>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel className="p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold">Cleanup progress</h2>
              <p className="text-sm text-stone-600">
                {progress?.completed ?? 0} completed, {progress?.skipped ?? 0} skipped, {progress?.remaining ?? 0} pending
              </p>
            </div>
            <span className="text-2xl font-black text-stone-950">{percent}%</span>
          </div>
          <div className="mt-4 h-3 overflow-hidden rounded bg-stone-200">
            <div className="h-full bg-red-700 transition-all" style={{ width: `${percent}%` }} />
          </div>
        </Panel>

        <Panel className="p-5">
          <h2 className="text-lg font-bold">Closed deal shortcut</h2>
          <p className="mt-1 text-sm text-stone-600">
            Mark closed won or lost deals historical when no more cleanup is needed.
          </p>
          <Button className="mt-4 w-full" disabled={closedEligible === 0 || historicalPass.isPending} onClick={() => historicalPass.mutate()}>
            {historicalPass.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Mark {closedEligible} closed deal{closedEligible === 1 ? "" : "s"} historical
          </Button>
        </Panel>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Panel className="p-5">
          <ClipboardList className="h-5 w-5 text-red-800" />
          <h2 className="mt-3 text-xl font-black">Start here</h2>
          {nextPending ? (
            <>
              <p className="mt-1 text-sm text-stone-600">Next record in your cleanup queue:</p>
              <p className="mt-4 font-bold text-stone-950">{nextPending.name}</p>
              <p className="mt-1 text-sm text-stone-600 capitalize">{nextPending.type} · {nextPending.missingFields.length || "No"} field{nextPending.missingFields.length === 1 ? "" : "s"} to check</p>
              <Button className="mt-5 w-full" onClick={() => navigate(nextCleanupRoute(nextPending))}>
                Clean next record
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-stone-600">No pending records remain. Review skipped items if needed, then enter the CRM.</p>
              <Button variant="secondary" className="mt-5 w-full" onClick={() => navigate("/cleanup/deals")}>
                Review records
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          )}
        </Panel>

        <Panel className="overflow-hidden">
          <div className="border-b border-stone-300 bg-stone-200 px-4 py-3">
            <h2 className="font-black text-stone-950">Cleanup punch list</h2>
          </div>
          <div className="hidden grid-cols-[1fr_100px_110px_90px_130px] gap-3 border-b border-stone-300 px-4 py-3 text-xs font-bold uppercase tracking-wide text-stone-600 md:grid">
            <span>Type</span>
            <span>Remaining</span>
            <span>Completed</span>
            <span>Skipped</span>
            <span>Action</span>
          </div>
          {RECORD_TYPES.map((type) => {
            const records = queue?.[TYPE_TO_SINGULAR[type]] ?? [];
            const counts = statusCounts(records);
            return (
              <div key={type} className="grid gap-3 border-b border-stone-200 px-4 py-4 last:border-0 md:grid-cols-[1fr_100px_110px_90px_130px] md:items-center">
                <div>
                  <p className="font-bold text-stone-950">{labels[type]}</p>
                  <p className="text-sm text-stone-600">{records.length} total</p>
                </div>
                <p className="text-sm tabular-nums text-stone-700"><span className="font-bold text-stone-950">{counts.remaining}</span> left</p>
                <p className="text-sm tabular-nums text-stone-700">{counts.completed} done</p>
                <p className="text-sm tabular-nums text-stone-700">{counts.skipped} review</p>
                <Button variant={counts.remaining > 0 ? "primary" : "secondary"} className="w-full" onClick={() => navigate(`/cleanup/${type}`)}>
                  {counts.remaining > 0 ? "Open" : "Review"}
                </Button>
              </div>
            );
          })}
        </Panel>
      </section>

      <section className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-300 bg-stone-100/95 px-4 py-4 backdrop-blur sm:static sm:mt-6 sm:border sm:bg-stone-50 sm:p-4 sm:backdrop-blur-0">
        <div className="mx-auto flex max-w-7xl flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-stone-600">
            {completeDisabled
              ? "Finish or skip every item to clear the CRM gate."
              : skippedCount > 0
                ? `${skippedCount} skipped item${skippedCount === 1 ? "" : "s"} will stay visible for leadership review.`
                : "All required items are resolved. You can enter the CRM."}
          </p>
          <Button
            disabled={completeDisabled}
            title={completeDisabled ? `${progress?.remaining ?? 0} items still need cleanup` : "Complete onboarding"}
            onClick={() =>
              completeOnboarding.mutate(undefined, {
                onSuccess: (result) => {
                  if (result.success) window.location.assign(import.meta.env.VITE_MAIN_CRM_BASE_URL ?? "https://trockcrm.com");
                },
              })
            }
          >
            Enter CRM
          </Button>
        </div>
      </section>
    </main>
  );
}
