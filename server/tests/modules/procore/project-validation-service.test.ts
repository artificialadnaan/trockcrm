import { describe, expect, it, vi } from "vitest";
import { listProjectValidation } from "../../../src/modules/procore/project-validation-service.js";

describe("project validation service", () => {
  it("returns a linked exact match when deal.procoreProjectId matches project.id", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        {
          id: 42,
          name: "Alpha Tower",
          projectNumber: "TR-001",
          city: "Dallas",
          state: "TX",
          address: "100 Main St",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        {
          id: "deal-1",
          dealNumber: "TR-001",
          name: "Alpha Tower",
          city: "Dallas",
          state: "TX",
          address: "100 Main St",
          procoreProjectId: 42,
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].deal?.id).toBe("deal-1");
  });

  it("marks a project ambiguous when multiple deals tie on the best eligible match tier", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        {
          id: 99,
          name: "Legacy Plaza",
          projectNumber: null,
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        },
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        {
          id: "deal-a",
          dealNumber: null,
          name: "Legacy Plaza",
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          procoreProjectId: null,
          updatedAt: null,
        },
        {
          id: "deal-b",
          dealNumber: null,
          name: "Legacy Plaza",
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          procoreProjectId: null,
          updatedAt: null,
        },
      ]),
    });

    expect(result.projects[0].status).toBe("ambiguous");
    expect(result.projects[0].deal).toBeNull();
  });

  it("marks a project unmatched when no CRM deal clears the match thresholds", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        {
          id: 77,
          name: "Procore Only Job",
          projectNumber: "PC-777",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
          updatedAt: null,
        },
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(result.projects[0].status).toBe("unmatched");
    expect(result.projects[0].deal).toBeNull();
  });

  it("sets meta.truncated when the project cap is hit", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 2,
      maxProjects: 1,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        { id: 1, name: "One", projectNumber: null, city: null, state: null, address: null, updatedAt: null },
        { id: 2, name: "Two", projectNumber: null, city: null, state: null, address: null, updatedAt: null },
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(result.meta.truncated).toBe(true);
  });
});
