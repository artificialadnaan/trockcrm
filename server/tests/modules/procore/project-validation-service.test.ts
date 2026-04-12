import { describe, expect, it, vi } from "vitest";
import { listProjectValidation } from "../../../src/modules/procore/project-validation-service.js";

function makeProject(overrides: Partial<{
  id: number;
  name: string;
  projectNumber: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  updatedAt: string | null;
}> = {}) {
  return {
    id: 1,
    name: "Alpha Tower",
    projectNumber: "TR-001",
    city: "Dallas",
    state: "TX",
    address: "100 Main St",
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeal(overrides: Partial<{
  id: string;
  dealNumber: string | null;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  procoreProjectId: number | null;
  updatedAt: string | null;
}> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-001",
    name: "Alpha Tower",
    city: "Dallas",
    state: "TX",
    address: "100 Main St",
    procoreProjectId: null,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("project validation service", () => {
  it("returns a linked exact match when deal.procoreProjectId matches project.id", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42 })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([makeDeal({ procoreProjectId: 42 })]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("procore_project_id");
    expect(result.projects[0].deal?.id).toBe("deal-1");
  });

  it("reports the validation result as read-only metadata", async () => {
    const now = new Date("2026-04-12T12:34:56.000Z");
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject()]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
      now: () => now,
    });

    expect(result.meta.readOnly).toBe(true);
    expect(result.meta.fetchedAt).toBe(now.toISOString());
  });

  it("matches by normalized project number when no project-id link exists", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42, projectNumber: "TR-001" })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-number",
          procoreProjectId: null,
          dealNumber: "TR001",
          name: "Other Name",
          city: "Houston",
          state: "TX",
          address: "500 Elsewhere",
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("project_number");
    expect(result.projects[0].deal?.id).toBe("deal-number");
  });

  it("ignores deals linked to a different project for fuzzy name-location matching", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        makeProject({
          id: 42,
          projectNumber: null,
          name: "Linked Elsewhere",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-foreign-link",
          procoreProjectId: 999,
          dealNumber: null,
          name: "Linked Elsewhere",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("unmatched");
    expect(result.projects[0].matchReason).toBe("none");
    expect(result.projects[0].deal).toBeNull();
  });

  it("prefers procoreProjectId over project number and name-location tiers", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42, projectNumber: "TR-001" })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-id",
          procoreProjectId: 42,
          dealNumber: "OTHER-999",
          name: "Mismatch",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
        makeDeal({
          id: "deal-number",
          procoreProjectId: null,
          dealNumber: "TR-001",
        }),
        makeDeal({
          id: "deal-location",
          procoreProjectId: null,
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("procore_project_id");
    expect(result.projects[0].deal?.id).toBe("deal-id");
  });

  it("prefers project number over name-location matches", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42, projectNumber: "TR-001" })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-number",
          procoreProjectId: null,
          dealNumber: "TR-001",
          name: "Other Name",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
        makeDeal({
          id: "deal-location",
          procoreProjectId: null,
          dealNumber: null,
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("project_number");
    expect(result.projects[0].deal?.id).toBe("deal-number");
  });

  it("marks a project ambiguous when multiple deals tie on the best eligible match tier", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        makeProject({
          id: 99,
          name: "Legacy Plaza",
          projectNumber: null,
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        }),
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-a",
          dealNumber: null,
          name: "Legacy Plaza",
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        }),
        makeDeal({
          id: "deal-b",
          dealNumber: null,
          name: "Legacy Plaza",
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        }),
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
        makeProject({
          id: 77,
          name: "Procore Only Job",
          projectNumber: "PC-777",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
          updatedAt: null,
        }),
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
    expect(result.projects).toHaveLength(1);
  });

  it("pages across multiple requests until maxProjects is reached", async () => {
    const listProjectsPage = vi
      .fn()
      .mockResolvedValueOnce([makeProject({ id: 1 }), makeProject({ id: 2 })])
      .mockResolvedValueOnce([makeProject({ id: 3 }), makeProject({ id: 4 })]);

    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 2,
      maxProjects: 3,
      listProjectsPage,
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(listProjectsPage).toHaveBeenCalledTimes(2);
    expect(result.projects.map((row) => row.project.id)).toEqual([1, 2, 3]);
    expect(result.meta.fetchedCount).toBe(3);
    expect(result.meta.truncated).toBe(true);
  });

  it("marks truncation when maxProjects lands exactly on a full page and another page exists", async () => {
    const listProjectsPage = vi
      .fn()
      .mockResolvedValueOnce([makeProject({ id: 1 }), makeProject({ id: 2 })])
      .mockResolvedValueOnce([makeProject({ id: 3 })]);

    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 2,
      maxProjects: 2,
      listProjectsPage,
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(listProjectsPage).toHaveBeenCalledTimes(2);
    expect(result.projects.map((row) => row.project.id)).toEqual([1, 2]);
    expect(result.meta.truncated).toBe(true);
  });
});
