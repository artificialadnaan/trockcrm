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
  cohort: "open",
  bucket: "missing",
  stageSlug: "estimating",
  title: "Missing estimator: Estimating",
  description: "Current active projects in Estimating.",
};

const evidence: EstimatorPipelineEvidenceResponse = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  filter: {
    cohort: "open",
    bucket: "missing",
    estimatorKey: null,
    estimatorName: null,
    stageSlug: "estimating",
    stageLabel: "Estimating",
    valueBasisLabel: "Best current estimate",
    period: null,
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
      wonClosedDate: null,
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
      wonClosedDate: null,
      estimatorUserId: null,
      estimatorName: null,
      estimatorActive: null,
      legacyEstimatorName: "S. Gibson",
      assignmentIssue: "unmapped_legacy",
      isBidBoardOwned: true,
    },
  ],
};

// estimatorKey is now the estimator's CRM user id (a UUID string).
const SIDNEY_USER_ID = "00000000-0000-0000-0000-000000005101";

const wonSelection: EstimatorDrillSelection = {
  cohort: "won",
  period: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
  bucket: "target",
  estimatorKey: SIDNEY_USER_ID,
  title: "Sidney Gibson: Won YTD",
  description: "Projects won from 2026-01-01 through 2026-07-13.",
};

const wonEvidence: EstimatorPipelineEvidenceResponse = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  filter: {
    cohort: "won",
    bucket: "target",
    estimatorKey: SIDNEY_USER_ID,
    estimatorName: "Sidney Gibson",
    stageSlug: null,
    stageLabel: null,
    valueBasisLabel: "Awarded-first won value",
    period: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
  },
  total: { count: 1, value: 325_000 },
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
  records: [
    {
      dealId: "deal-won",
      dealNumber: "D-2001",
      projectNumber: "DFW-2001",
      dealName: "River Center Award",
      ownerId: "owner-2",
      ownerName: "Jordan Rep",
      companyName: "River Center LLC",
      propertyName: "River Center",
      stageSlug: "won",
      stageLabel: "Won",
      displayOrder: 90,
      workflowRoute: "normal",
      daysInStage: 4,
      pipelineValue: 325_000,
      expectedCloseDate: "2026-02-01",
      wonClosedDate: "2026-06-30",
      estimatorUserId: "sidney-user",
      estimatorName: "Sidney Gibson",
      estimatorActive: true,
      legacyEstimatorName: null,
      assignmentIssue: "none",
      isBidBoardOwned: false,
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
  it("renders responsive table and card evidence without a horizontal-scroll wrapper", () => {
    renderSheet();

    expect(bodyText()).toContain("Missing estimator: Estimating");
    expect(bodyText()).toContain("Current active projects in Estimating.");
    expect(bodyText()).toContain("2");
    expect(bodyText()).toContain("$175,000");
    expect(bodyText()).toContain("North Campus Reroof");
    expect(bodyText()).toContain("Project DFW-1001");
    expect(bodyText()).not.toContain("HS-should-not-be-used");
    expect(bodyText()).toContain("No assignment");
    expect(bodyText()).toContain("Legacy name not linked");
    expect(bodyText()).toContain("S. Gibson");
    expect(bodyText()).toContain("No date");
    expect(bodyText()).toContain("Stage age unavailable");
    expect(bodyText()).toContain("Expected close");
    expect(bodyText()).toContain("Best current estimate");

    const projectLink = document.body.querySelector('a[href="/deals/deal-unassigned?officeId=office-dallas"]');
    expect(projectLink?.textContent).toContain("North Campus Reroof");
    expect(document.body.querySelector("caption")?.textContent).toContain("selected estimator report segment");
    const desktop = document.body.querySelector('[data-testid="estimator-evidence-table"]') as HTMLElement;
    const cards = document.body.querySelector('[data-testid="estimator-evidence-cards"]') as HTMLElement;
    expect(desktop.className).toContain("lg:block");
    expect(desktop.querySelector("table")?.className).toContain("table-fixed");
    expect(cards.className).toContain("lg:hidden");
    expect(cards.querySelectorAll("article")).toHaveLength(2);
    expect(document.body.querySelector('[data-testid="scrollsync-body"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain("min-w-[1180px]");
    expect(document.body.innerHTML).not.toContain("overflow-x-auto");
  });

  it("uses a near-full side-scoped sheet width and a 44px close target", () => {
    const onOpenChange = renderSheet();

    const sheet = document.body.querySelector('[data-slot="sheet-content"]') as HTMLElement;
    expect(sheet.className).toContain("data-[side=right]:w-[96vw]");
    expect(sheet.className).toContain("data-[side=right]:sm:w-[min(94vw,90rem)]");
    expect(sheet.className).toContain("[&_[data-slot=sheet-close]]:size-11");
    expect(sheet.className).toContain("overflow-hidden");
    expect(sheet.querySelector('[data-slot="sheet-close"]')).not.toBeNull();

    act(() => (sheet.querySelector('[data-slot="sheet-close"]') as HTMLButtonElement).click());
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("uses awarded value and won date semantics for a Won YTD drill", () => {
    hook.data = wonEvidence;
    renderSheet(wonSelection);

    expect(bodyText()).toContain("Sidney Gibson: Won YTD");
    expect(bodyText()).toContain("Awarded-first won value");
    expect(bodyText()).toContain("Won date");
    expect(bodyText()).toContain("Jun 30, 2026");
    expect(bodyText()).toContain("Jan 1, 2026 to Jul 13, 2026");
    expect(bodyText()).toContain("$325,000");
    expect(bodyText()).toContain("River Center Award");
    expect(document.body.querySelector('[data-testid="estimator-evidence-table"] th:nth-child(4)')?.textContent).toBe("Won date");
    expect(document.body.querySelector('[data-testid="estimator-evidence-table"] th:nth-child(5)')?.textContent).toBe(
      "Awarded-first won value",
    );
    expect(hook.request?.asOf).toBe("2026-07-13");
  });

  it("requests the selected bucket and stage on page one", () => {
    renderSheet();

    expect(hook.request).toEqual({
      cohort: "open",
      asOf: undefined,
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
      cohort: "open",
      asOf: undefined,
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

    expect(hook.request).toMatchObject({ cohort: "open", bucket: "missing", stageSlug: "estimating", page: 1 });
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
