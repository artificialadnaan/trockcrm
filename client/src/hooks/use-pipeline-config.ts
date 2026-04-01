import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface PipelineStage {
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

export interface LostReason {
  id: string;
  label: string;
  isActive: boolean;
  displayOrder: number;
}

export interface ProjectType {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  displayOrder: number;
  isActive: boolean;
}

export interface Region {
  id: string;
  name: string;
  slug: string;
  states: string[];
  displayOrder: number;
  isActive: boolean;
}

export function usePipelineStages() {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ stages: PipelineStage[] }>("/pipeline/stages")
      .then((data) => {
        if (!cancelled) setStages(data.stages);
      })
      .catch((err) => console.error("Failed to load stages:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { stages, loading };
}

export function useLostReasons() {
  const [reasons, setReasons] = useState<LostReason[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ reasons: LostReason[] }>("/pipeline/lost-reasons")
      .then((data) => { if (!cancelled) setReasons(data.reasons); })
      .catch((err) => console.error("Failed to load lost reasons:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { reasons, loading };
}

export function useProjectTypes() {
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ projectTypes: ProjectType[] }>("/pipeline/project-types")
      .then((data) => { if (!cancelled) setProjectTypes(data.projectTypes); })
      .catch((err) => console.error("Failed to load project types:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Build hierarchy: parent types with children
  const hierarchy = projectTypes
    .filter((t) => t.parentId == null)
    .map((parent) => ({
      ...parent,
      children: projectTypes.filter((t) => t.parentId === parent.id),
    }));

  return { projectTypes, hierarchy, loading };
}

export function useRegions() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ regions: Region[] }>("/pipeline/regions")
      .then((data) => { if (!cancelled) setRegions(data.regions); })
      .catch((err) => console.error("Failed to load regions:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { regions, loading };
}
