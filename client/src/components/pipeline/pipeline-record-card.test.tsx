// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AtRiskResult } from "@trock-crm/shared/types";
import { PipelineRecordCard, type PipelineRecordCardData } from "./pipeline-record-card";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
  }),
}));

function makeAtRiskResult(overrides: Partial<AtRiskResult> = {}): AtRiskResult {
  return {
    isAtRisk: true,
    status: "at_risk",
    severity: "at_risk",
    reason: "threshold_reached",
    stageSlug: "estimating",
    canonicalStageSlug: "estimating",
    viewerRole: "director",
    audience: "leadership",
    policy: {
      audience: "leadership",
      stageSlug: "estimating",
      dayCounting: "calendar_days",
      thresholdDays: 14,
      recurs: false,
      recurrenceDays: null,
    },
    effectiveStageAgeSeconds: 1_468_800,
    effectiveStageAgeDays: 17,
    thresholdSeconds: 1_209_600,
    thresholdDays: 14,
    secondsUntilThreshold: 0,
    secondsPastThreshold: 259_200,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<PipelineRecordCardData> = {}): PipelineRecordCardData {
  return {
    id: "deal-1",
    name: "Palm Villas",
    stageId: "stage-estimating",
    stageEnteredAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-15T10:00:00.000Z",
    dealNumber: "DFW-1-12826-aa",
    bidEstimate: "250000",
    workflowRoute: "normal",
    ...overrides,
  };
}

function render(record: PipelineRecordCardData) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PipelineRecordCard entity="deal" record={record} />
    </MemoryRouter>
  );
}

describe("PipelineRecordCard", () => {
  it("renders the shared at-risk badge for deal board records", () => {
    const html = render(makeRecord({ atRisk: makeAtRiskResult() }));

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-status="at_risk"');
  });

  it("renders safely without a badge before Slice B supplies at-risk data", () => {
    const html = render(makeRecord());

    expect(html).toContain("Palm Villas");
    expect(html).not.toContain("At Risk");
  });
});
