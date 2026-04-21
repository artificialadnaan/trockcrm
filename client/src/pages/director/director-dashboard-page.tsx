import { useDirectorDashboard } from "@/hooks/use-director-dashboard";
import { usePipelineBoardState } from "@/hooks/use-pipeline-board-state";
import { useDealBoard } from "@/hooks/use-deals";
import { useLeadBoard } from "@/hooks/use-leads";
import { DirectorDashboardShell } from "@/components/dashboard/director-dashboard-shell";

export function DirectorDashboardPage() {
  const boardState = usePipelineBoardState("deals");
  const { data, loading, error } = useDirectorDashboard();
  const { board: dealBoard, loading: dealBoardLoading } = useDealBoard("team", true);
  const { board: leadBoard, loading: leadBoardLoading } = useLeadBoard("team");

  return (
    <DirectorDashboardShell
      boardEntity={boardState.activeEntity}
      onBoardEntityChange={boardState.setActiveEntity}
      directorSummary={data}
      summaryLoading={loading}
      summaryError={error}
      dealBoard={dealBoard}
      dealBoardLoading={dealBoardLoading}
      leadBoard={leadBoard}
      leadBoardLoading={leadBoardLoading}
    />
  );
}
