import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPipelineConfigCache,
  loadPipelineStages,
  loadRegions,
  loadProjectTypes,
  loadLostReasons,
} from "./use-pipeline-config";

describe("pipeline config loaders", () => {
  beforeEach(() => {
    clearPipelineConfigCache();
  });

  it("reuses the same in-flight stage request across callers", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      stages: [
        {
          id: "stage-1",
          name: "Estimating",
          slug: "estimating",
          displayOrder: 1,
          isActivePipeline: true,
          isTerminal: false,
          requiredFields: [],
          requiredDocuments: [],
          requiredApprovals: [],
          staleThresholdDays: null,
          procoreStageMapping: null,
          color: null,
        },
      ],
    });

    const [first, second] = await Promise.all([
      loadPipelineStages({ fetcher }),
      loadPipelineStages({ fetcher }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("serves cached pipeline config after the first load", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ stages: [] })
      .mockResolvedValueOnce({ stages: [{ id: "unused" }] });

    await loadPipelineStages({ fetcher });
    await loadPipelineStages({ fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches the other pipeline config collections as well", async () => {
    const lostReasonsFetcher = vi.fn().mockResolvedValue({ reasons: [] });
    const projectTypesFetcher = vi.fn().mockResolvedValue({ projectTypes: [] });
    const regionsFetcher = vi.fn().mockResolvedValue({ regions: [] });

    await Promise.all([
      loadLostReasons(lostReasonsFetcher),
      loadLostReasons(lostReasonsFetcher),
      loadProjectTypes(projectTypesFetcher),
      loadProjectTypes(projectTypesFetcher),
      loadRegions(regionsFetcher),
      loadRegions(regionsFetcher),
    ]);

    expect(lostReasonsFetcher).toHaveBeenCalledTimes(1);
    expect(projectTypesFetcher).toHaveBeenCalledTimes(1);
    expect(regionsFetcher).toHaveBeenCalledTimes(1);
  });
});
