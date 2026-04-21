import { RepDashboardBoardShell } from "@/components/dashboard/rep-dashboard-board-shell";
import { useDealBoard } from "@/hooks/use-deals";
import { useRepDashboard } from "@/hooks/use-dashboard";
import { useLeadBoard } from "@/hooks/use-leads";
import { usePipelineBoardState } from "@/hooks/use-pipeline-board-state";

export function RepDashboardPage() {
  const boardState = usePipelineBoardState("deals");
  const { data, loading, error } = useRepDashboard();
  const { board: dealBoard } = useDealBoard("mine", true);
  const { board: leadBoard } = useLeadBoard("mine");

  if (loading) return <div className="text-sm text-slate-500">Loading dashboard...</div>;
  if (error || !data) return <div className="text-sm text-red-600">{error ?? "Failed to load dashboard"}</div>;

  return (
    <RepDashboardBoardShell
      activeEntity={boardState.activeEntity}
      onEntityChange={boardState.setActiveEntity}
      repSummary={data}
      dealBoard={dealBoard}
      leadBoard={leadBoard}
    />
  );
}
