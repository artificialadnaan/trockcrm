import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface PortfolioProjectSummary {
  id: string;
  procoreProjectId: string;
  procoreCompanyId: string;
  projectNumber: string | null;
  name: string;
  currentStage: string;
  currentStageNormalized: string;
  currentStageEnteredAt: string | null;
  totalValue: number | null;
  valueSyncedAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface PortfolioProjectBoardColumn {
  stage: string;
  label: string;
  projects: PortfolioProjectSummary[];
}

export interface PortfolioProjectBoardResponse {
  stages: PortfolioProjectBoardColumn[];
  projects: PortfolioProjectSummary[];
}

export interface PortfolioProjectStageEntry {
  id: string;
  eventKey: string;
  previousStage: string | null;
  previousStageNormalized: string | null;
  stage: string;
  stageNormalized: string;
  isBoardRelevant: boolean;
  enteredAt: string;
  relayDetectedAt: string | null;
  webhookTimestamp: string | null;
  createdAt: string;
}

export interface PortfolioProjectDetail extends PortfolioProjectSummary {
  lastStageEventKey: string | null;
  rawSnapshot: Record<string, unknown>;
  stageHistory: PortfolioProjectStageEntry[];
}

export interface PortfolioProjectDetailResponse {
  project: PortfolioProjectDetail;
}

export function usePortfolioProjectBoard() {
  const [data, setData] = useState<PortfolioProjectBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api<PortfolioProjectBoardResponse>("/projects/board");
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  return {
    stages: data?.stages ?? [],
    projects: data?.projects ?? [],
    loading,
    error,
    refetch: fetchBoard,
  };
}

export function useProjectDetail(projectId: string | undefined) {
  const [data, setData] = useState<PortfolioProjectDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProject = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await api<PortfolioProjectDetailResponse>(`/projects/${projectId}`);
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load project");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  return {
    project: data?.project ?? null,
    loading,
    error,
    refetch: fetchProject,
  };
}
