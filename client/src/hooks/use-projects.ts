import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface ProjectSummary {
  id: string;
  deal_number: string;
  name: string;
  procore_project_id: number;
  procore_last_synced_at: string | null;
  change_order_total: string | null;
  stage_name: string;
  stage_color: string;
}

export function useProjectDetail(projectId: string | undefined) {
  const [project, setProject] = useState<ProjectSummary | null>(null);
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
      const data = await api<{ project: ProjectSummary }>(`/procore/my-projects/${projectId}`);
      setProject(data.project);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  return { project, loading, error, refetch: fetchProject };
}
