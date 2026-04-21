import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface PipelineStage {
  id: string;
  name: string;
  slug: string;
  workflowFamily: "lead" | "standard_deal" | "service_deal";
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

type ApiFetcher = typeof api;

function createCachedLoader<T>(load: (fetcher: ApiFetcher) => Promise<T>) {
  let cachedValue: T | null = null;
  let pending: Promise<T> | null = null;

  const read = async (fetcher: ApiFetcher = api) => {
    if (cachedValue != null) return cachedValue;
    if (!pending) {
      pending = load(fetcher)
        .then((value) => {
          cachedValue = value;
          return value;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };

  const clear = () => {
    cachedValue = null;
    pending = null;
  };

  return { read, clear };
}

const stagesLoader = createCachedLoader(async (fetcher) => {
  const data = await fetcher<{ stages: PipelineStage[] }>("/pipeline/stages");
  return data.stages;
});

const lostReasonsLoader = createCachedLoader(async (fetcher) => {
  const data = await fetcher<{ reasons: LostReason[] }>("/pipeline/lost-reasons");
  return data.reasons;
});

const projectTypesLoader = createCachedLoader(async (fetcher) => {
  const data = await fetcher<{ projectTypes: ProjectType[] }>("/pipeline/project-types");
  return data.projectTypes;
});

const regionsLoader = createCachedLoader(async (fetcher) => {
  const data = await fetcher<{ regions: Region[] }>("/pipeline/regions");
  return data.regions;
});

export function clearPipelineConfigCache() {
  stagesLoader.clear();
  lostReasonsLoader.clear();
  projectTypesLoader.clear();
  regionsLoader.clear();
}

export function loadPipelineStages(fetcher?: ApiFetcher) {
  return stagesLoader.read(fetcher);
}

export function loadLostReasons(fetcher?: ApiFetcher) {
  return lostReasonsLoader.read(fetcher);
}

export function loadProjectTypes(fetcher?: ApiFetcher) {
  return projectTypesLoader.read(fetcher);
}

export function loadRegions(fetcher?: ApiFetcher) {
  return regionsLoader.read(fetcher);
}

export function usePipelineStages() {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadPipelineStages()
      .then((data) => {
        if (!cancelled) setStages(data);
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
    loadLostReasons()
      .then((data) => { if (!cancelled) setReasons(data); })
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
    loadProjectTypes()
      .then((data) => { if (!cancelled) setProjectTypes(data); })
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
    loadRegions()
      .then((data) => { if (!cancelled) setRegions(data); })
      .catch((err) => console.error("Failed to load regions:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { regions, loading };
}
