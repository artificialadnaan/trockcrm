// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstimatorPipelineEvidenceResponse } from "@trock-crm/shared/types";
import type { EstimatorPipelineEvidenceRequest } from "@/hooks/use-estimator-pipeline-report";
import type { EstimatorDrillSelection } from "./types";

const hook = vi.hoisted(() => ({
  request: null as EstimatorPipelineEvidenceRequest | null,
  data: null as EstimatorPipelineEvidenceResponse | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/use-estimator-pipeline-report", () => ({
  useEstimatorPipelineEvidence: (request: EstimatorPipelineEvidenceRequest | null) => {
    hook.request = request;
    return { data: hook.data, loading: hook.loading, error: hook.error, refetch: hook.refetch };
  },
}));

import { EstimatorEvidenceSheet } from "./estimator-evidence-sheet";

const selection: EstimatorDrillSelection = {
  bucket: "missing",
  stageSlug: "estimating",
  title: "Missing estimator: Estimating",
  description: "Current active projects in Estimating.",
};

const evidence: EstimatorPipelineEvidenceResponse = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  filter: {
    bucket: "missing",
    estimatorKey: null,
    estimatorName: null,
    stageSlug: "estimating",
    stageLabel: "Estimating",
  },
  total: { count: 2, value: 175_000 },
  pagination: { page: 1, pageSize: 25, total: 2, totalPages: 2 },
  records: [
    {
      dealId: "deal-unassigned",
      dealNumber: "HS-should-not-be-used",
      projectNumber: "DFW-1001",
      dealName: "North Campus Reroof",
      ownerId: "owner-1",
      ownerName: "Taylor Rep",
      companyName: "Acme Properties",
      propertyName: "North Campus",
      stageSlug: "estimating",
      stageLabel: "Estimating",
      displayOrder: 20,
      workflowRoute: "normal",
      daysInStage: 12,
      pipelineValue: 100_000,
      expectedCloseDate: "2026-08-15",
      estimatorUserId: null,
      estimatorName: null,
      estimatorActive: null,
      legacyEstimatorName: null,
      assignmentIssue: "unassigned",
      isBidBoardOwned: false,
    },
    {
      dealId: "deal-legacy",
      dealNumber: "D-1002",
      projectNumber: null,
      dealName: "Legacy Estimate Project",
      ownerId: null,
      ownerName: "Unassigned",
      companyName: null,
      propertyName: null,
      stageSlug: "estimating",
      stageLabel: "Estimating",
      displayOrder: 20,
      workflowRoute: "service",
      daysInStage: null,
      pipelineValue: 75_000,
      expectedCloseDate: null,
      estimatorUserId: null,
      estimatorName: null,
      estimatorActive: null,
      legacyEstimatorName: "S. Gibson",
      assignmentIssue: "unmapped_legacy",
      isBidBoardOwned: true,
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  hook.request = null;
  hook.data = evidence;
  hook.loading = false;
  hook.error = null;
  hook.refetch.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll('[data-slot="sheet-portal"]').forEach((node) => node.remove());
});

function renderSheet(
  selected: EstimatorDrillSelection | null = selection,
  onOpenChange = vi.fn<(open: boolean) => void>(),
  officeScopeKey = "office-dallas",
) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/reports/operations/estimator-pipeline?officeId=office-dallas"]}>
        <EstimatorEvidenceSheet selection={selected} officeScopeKey={officeScopeKey} onOpenChange={onOpenChange} />
      </MemoryRouter>,
    );
  });
  return onOpenChange;
}

function bodyText() {
  return document.body.textContent ?? "";
}

describe("EstimatorEvidenceSheet", () => {
  it("renders a reconciled project list with assignment issues and canonical project links", () => {
    renderSheet();

    expect(bodyText()).toContain("Missing estimator: Estimating");
    expect(bodyText()).toContain("Current active projects in Estimating.");
    expect(bodyText()).toContain("2");
    expect(bodyText()).toContain("$175,000");
    expect(bodyText()).toContain("North Campus Reroof");
    expect(bodyText()).toContain("Project DFW-1001");
    expect(bodyText()).not.toContain("HS-should-not-be-used");
    expect(bodyText()).toContain("No assignment");
    expect(bodyText()).toContain("Legacy name not linked: S. Gibson");
    expect(bodyText()).toContain("No date");
    expect(bodyText()).toContain("N/A");

    const projectLink = document.body.querySelector('a[href="/deals/deal-unassigned?officeId=office-dallas"]');
    expect(projectLink?.textContent).toContain("North Campus Reroof");
    expect(document.body.querySelector("caption")?.textContent).toContain("selected estimator pipeline segment");
    expect(document.body.querySelector('[data-testid="scrollsync-body"]')).not.toBeNull();
  });

  it("requests the selected bucket and stage on page one", () => {
    renderSheet();

    expect(hook.request).toEqual({
      bucket: "missing",
      estimatorKey: undefined,
      stageSlug: "estimating",
      page: 1,
      pageSize: 25,
    });
  });

  it("advances evidence pagination without losing the drill scope", () => {
    renderSheet();
    const next = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Show next project evidence page",
    ) as HTMLButtonElement | undefined;
    expect(next).toBeTruthy();
    expect(next?.disabled).toBe(false);

    act(() => next!.click());

    expect(hook.request).toEqual({
      bucket: "missing",
      estimatorKey: undefined,
      stageSlug: "estimating",
      page: 2,
      pageSize: 25,
    });
  });

  it("returns to page one when the selected office changes", () => {
    renderSheet();
    const next = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Show next project evidence page",
    ) as HTMLButtonElement;
    act(() => next.click());
    expect(hook.request?.page).toBe(2);

    renderSheet(selection, vi.fn(), "office-atlanta");

    expect(hook.request).toMatchObject({ bucket: "missing", stageSlug: "estimating", page: 1 });
  });

  it("exposes accessible loading and retry states", () => {
    hook.data = null;
    hook.loading = true;
    renderSheet();
    expect(document.body.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Loading estimator project evidence",
    );

    hook.loading = false;
    hook.error = "Network unavailable";
    renderSheet();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");

    const retry = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Try again"),
    ) as HTMLButtonElement | undefined;
    act(() => retry!.click());
    expect(hook.refetch).toHaveBeenCalledTimes(1);
  });

  it("stays closed and clears the evidence request when there is no selection", () => {
    renderSheet(null);

    expect(hook.request).toBeNull();
    expect(document.body.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });
});
