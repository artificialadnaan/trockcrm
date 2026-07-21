// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EstimatorPipelineEvidenceResponse,
  EstimatorPipelineReport,
} from "@trock-crm/shared/types";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: mocks.api }));

import {
  useEstimatorPipelineEvidence,
  useEstimatorPipelineReport,
  type EstimatorPipelineEvidenceRequest,
} from "./use-estimator-pipeline-report";

const report: EstimatorPipelineReport = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  scope: {
    kind: "active_office",
    cohort: "current_open_pipeline_plus_won_ytd",
    note: "Current open pipeline plus Won YTD in the active office.",
  },
  valueBasisLabel: "Best current estimate",
  valueBasisLabels: { open: "Best current estimate", won: "Awarded-first won value" },
  pipeline: { count: 0, value: 0 },
  won: { count: 0, value: 0 },
  wonPeriod: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
  stageColumns: [],
  estimators: [],
  otherAssigned: { count: 0, value: 0, won: { count: 0, value: 0 }, stages: [] },
  missingEstimator: {
    count: 0,
    value: 0,
    actionableCount: 0,
    actionableValue: 0,
    won: { count: 0, value: 0 },
    stages: [],
  },
  warnings: [],
};

// estimatorKey is now the estimator's CRM user id (a UUID string).
const SIDNEY_USER_ID = "00000000-0000-0000-0000-000000005101";

const evidence: EstimatorPipelineEvidenceResponse = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  filter: {
    cohort: "open",
    bucket: "target",
    estimatorKey: SIDNEY_USER_ID,
    estimatorName: "Sidney Gibson",
    stageSlug: "estimating",
    stageLabel: "Estimating",
    valueBasisLabel: "Best current estimate",
    period: null,
  },
  total: { count: 0, value: 0 },
  pagination: { page: 2, pageSize: 25, total: 0, totalPages: 0 },
  records: [],
};

let container: HTMLDivElement;
let root: Root;
let latestReport: ReturnType<typeof useEstimatorPipelineReport> | null = null;
let latestEvidence: ReturnType<typeof useEstimatorPipelineEvidence> | null = null;

function ReportProbe({ officeScopeKey }: { officeScopeKey?: string }) {
  latestReport = useEstimatorPipelineReport(officeScopeKey);
  return null;
}

function EvidenceProbe({
  request,
  officeScopeKey,
}: {
  request: EstimatorPipelineEvidenceRequest | null;
  officeScopeKey?: string;
}) {
  latestEvidence = useEstimatorPipelineEvidence(request, officeScopeKey);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latestReport = null;
  latestEvidence = null;
  mocks.api.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useEstimatorPipelineReport", () => {
  it("loads the current-office summary from the dedicated report endpoint", async () => {
    mocks.api.mockResolvedValue({ data: report });

    act(() => root.render(<ReportProbe officeScopeKey="office-dallas" />));
    expect(latestReport?.loading).toBe(true);
    await flush();

    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][0]).toBe("/reports/estimator-pipeline");
    expect(mocks.api.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(latestReport).toMatchObject({ data: report, loading: false, error: null });
  });

  it("aborts and reloads when the active office scope changes", async () => {
    mocks.api.mockImplementation(() => new Promise(() => {}));

    act(() => root.render(<ReportProbe officeScopeKey="office-dallas" />));
    const firstSignal = mocks.api.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    act(() => root.render(<ReportProbe officeScopeKey="office-atlanta" />));

    expect(firstSignal.aborted).toBe(true);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect((mocks.api.mock.calls[1][1].signal as AbortSignal).aborted).toBe(false);
  });
});

describe("useEstimatorPipelineEvidence", () => {
  it("encodes the stable estimator key, exact stage slug, and pagination in the drill request", async () => {
    mocks.api.mockResolvedValue({ data: evidence });
    const request: EstimatorPipelineEvidenceRequest = {
      cohort: "open",
      bucket: "target",
      estimatorKey: SIDNEY_USER_ID,
      stageSlug: "estimating",
      page: 2,
      pageSize: 25,
    };

    act(() => root.render(<EvidenceProbe request={request} officeScopeKey="office-dallas" />));
    await flush();

    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][0]).toBe(
      `/reports/estimator-pipeline/evidence?cohort=open&bucket=target&page=2&pageSize=25&estimatorKey=${SIDNEY_USER_ID}&stageSlug=estimating`,
    );
    expect(mocks.api.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(latestEvidence).toMatchObject({ data: evidence, loading: false, error: null });
  });

  it("encodes the Won cohort without inventing an open-stage filter", async () => {
    const wonEvidence: EstimatorPipelineEvidenceResponse = {
      ...evidence,
      filter: {
        ...evidence.filter,
        cohort: "won",
        stageSlug: null,
        stageLabel: null,
        valueBasisLabel: "Awarded-first won value",
        period: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
      },
    };
    mocks.api.mockResolvedValue({ data: wonEvidence });

    act(() => root.render(
      <EvidenceProbe
        request={{
          cohort: "won",
          asOf: "2026-07-13",
          bucket: "target",
          estimatorKey: SIDNEY_USER_ID,
          page: 1,
          pageSize: 25,
        }}
        officeScopeKey="office-dallas"
      />,
    ));
    await flush();

    expect(mocks.api.mock.calls[0][0]).toBe(
      `/reports/estimator-pipeline/evidence?cohort=won&bucket=target&page=1&pageSize=25&estimatorKey=${SIDNEY_USER_ID}&asOf=2026-07-13`,
    );
    expect(latestEvidence).toMatchObject({ data: wonEvidence, loading: false, error: null });
  });

  it("requests the missing-assignment bucket without an estimator or stage parameter", async () => {
    mocks.api.mockResolvedValue({
      data: {
        ...evidence,
        filter: {
          ...evidence.filter,
          bucket: "missing",
          estimatorKey: null,
          estimatorName: null,
          stageSlug: null,
          stageLabel: null,
        },
      },
    });

    act(() => root.render(
      <EvidenceProbe request={{ cohort: "open", bucket: "missing", page: 1, pageSize: 50 }} />,
    ));
    await flush();

    expect(mocks.api.mock.calls[0][0]).toBe(
      "/reports/estimator-pipeline/evidence?cohort=open&bucket=missing&page=1&pageSize=50",
    );
  });

  it("stays idle and clears evidence when no drill is open", () => {
    act(() => root.render(<EvidenceProbe request={null} />));

    expect(mocks.api).not.toHaveBeenCalled();
    expect(latestEvidence).toMatchObject({ data: null, loading: false, error: null });
  });
});
