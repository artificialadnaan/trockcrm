import { useDirectorDashboard } from "@/hooks/use-director-dashboard";
import { usePipelineBoardState } from "@/hooks/use-pipeline-board-state";
import { useDealBoard } from "@/hooks/use-deals";
import { useLeadBoard } from "@/hooks/use-leads";
import { DirectorDashboardShell } from "@/components/dashboard/director-dashboard-shell";

export function DirectorDashboardPage() {
  const boardState = usePipelineBoardState("deals");
  const { data, loading, error } = useDirectorDashboard();
  const { board: dealBoard } = useDealBoard("team", true);
  const { board: leadBoard } = useLeadBoard("team");

  if (loading) return <div className="text-sm text-slate-500">Loading director dashboard...</div>;
  if (error || !data) return <div className="text-sm text-red-600">{error ?? "Failed to load director dashboard"}</div>;

  return (
    <DirectorDashboardShell
      boardEntity={boardState.activeEntity}
      onBoardEntityChange={boardState.setActiveEntity}
      directorSummary={data}
      dealBoard={dealBoard}
      leadBoard={leadBoard}
    />
  );
}
