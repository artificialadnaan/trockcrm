import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface PipelineStageAdmin {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isActivePipeline: boolean;
  isTerminal: boolean;
  requiredFields: string[];
  requiredDocuments: string[];
  requiredApprovals: string[];
  staleThresholdDays: number | null;
  procoreStageMapping: string | null;
  color: string | null;
}

export function useAdminPipeline() {
  const [stages, setStages] = useState<PipelineStageAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ stages: PipelineStageAdmin[] }>("/admin/pipeline");
      setStages(data.stages);
    } finally {
      setLoading(false);
    }
  };

  const updateStage = async (id: string, input: Partial<PipelineStageAdmin>) => {
    setSaving(true);
    try {
      await api(`/admin/pipeline/${id}`, {
        method: "PATCH",
        json: input,
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => { load(); }, []);
  return { stages, loading, saving, refetch: load, updateStage };
}
