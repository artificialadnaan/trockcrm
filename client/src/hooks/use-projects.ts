import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface ProjectAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface ProjectSummary {
  id: string;
  procoreProjectId: string;
  procoreProjectNumber: string | null;
  name: string;
  currentPhaseId: string | null;
  currentPhaseName: string | null;
  currentPhaseSortOrder: number | null;
  startDate: string | null;
  completionDate: string | null;
  projectedFinishDate: string | null;
  contractValue: string | null;
  estimatedValue: string | null;
  actualCost: string | null;
  sourceDealId: string | null;
  sourceDealNumber: string | null;
  address: ProjectAddress;
  projectOwnerName: string | null;
  lastSyncedAt: string | null;
  syncSource: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  warrantyEndDate: string | null;
  projectOwnerId: string | null;
  procoreCreatedAt: string | null;
  procoreUpdatedAt: string | null;
  rawSnapshot: Record<string, unknown>;
  sourceDeal: {
    id: string;
    dealNumber: string | null;
    name: string | null;
  } | null;
}

export interface ProjectTeamMember {
  id: string;
  procore_user_id: string | null;
  procore_user_name: string | null;
  procore_user_email: string | null;
  role_name: string | null;
  is_active: boolean | null;
  assigned_at: string | null;
  last_synced_at: string | null;
}

export interface ProjectDocument {
  id: string;
  procore_document_id: string | null;
  name: string;
  file_url: string | null;
  file_size: string | number | null;
  mime_type: string | null;
  folder_path: string | null;
  uploaded_by_procore_user_name: string | null;
  uploaded_at: string | null;
  last_synced_at: string | null;
}

export interface ProjectPhaseHistoryItem {
  id: string;
  from_phase_name: string | null;
  to_phase_name: string;
  changed_at: string;
  changed_by_procore_user_name: string | null;
  sync_source: string | null;
}

export interface ProjectDetailResponse {
  project: ProjectDetail;
  team: ProjectTeamMember[];
  documents: ProjectDocument[];
  phaseHistory: ProjectPhaseHistoryItem[];
}

export interface ProjectPhaseGroup {
  phaseId: string;
  phaseName: string;
  sortOrder: number;
  count: number;
  overflowCount: number;
  projects: ProjectSummary[];
}

export function useProjectDetail(projectId: string | undefined) {
  const [data, setData] = useState<ProjectDetailResponse | null>(null);
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
      const response = await api<ProjectDetailResponse>(`/projects/${projectId}`);
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  return {
    project: data?.project ?? null,
    team: data?.team ?? [],
    documents: data?.documents ?? [],
    phaseHistory: data?.phaseHistory ?? [],
    loading,
    error,
    refetch: fetchProject,
  };
}
