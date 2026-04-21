import { useRepDashboard } from "@/hooks/use-dashboard";
import { usePipelineBoardState } from "@/hooks/use-pipeline-board-state";
import { useDealBoard } from "@/hooks/use-deals";
import { useLeadBoard } from "@/hooks/use-leads";
import { RepDashboardBoardShell } from "@/components/dashboard/rep-dashboard-board-shell";

export function RepDashboardPage() {
  const boardState = usePipelineBoardState("deals");
  const { data, loading, error } = useRepDashboard();
  const { board: dealBoard, loading: dealBoardLoading } = useDealBoard("mine", true);
  const { board: leadBoard, loading: leadBoardLoading } = useLeadBoard("mine");

  return (
    <RepDashboardBoardShell
      activeEntity={boardState.activeEntity}
      onEntityChange={boardState.setActiveEntity}
      repSummary={data}
      summaryLoading={loading}
      summaryError={error}
      dealBoard={dealBoard}
      dealBoardLoading={dealBoardLoading}
      leadBoard={leadBoard}
      leadBoardLoading={leadBoardLoading}
    />
  );
}
