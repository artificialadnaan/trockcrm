// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("flags a change-order child deal record with the Change Order badge", () => {
    expect(render(makeRecord({ isChangeOrder: true }))).toContain('data-change-order="true"');
  });

  it("does not flag a regular deal record", () => {
    expect(render(makeRecord())).not.toContain('data-change-order="true"');
  });

  it("never shows the Change Order badge on a non-deal (lead) record", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineRecordCard entity="lead" record={makeRecord({ isChangeOrder: true })} />
      </MemoryRouter>
    );

    expect(html).not.toContain('data-change-order="true"');
  });

  it("flags an on-hold deal record with the On Hold badge", () => {
    const html = render(makeRecord({ onHold: true }));

    expect(html).toContain('data-on-hold="true"');
    expect(html).toContain("On Hold");
  });

  it("does not flag a non-held deal record as on hold", () => {
    expect(render(makeRecord())).not.toContain('data-on-hold="true"');
    expect(render(makeRecord({ onHold: false }))).not.toContain('data-on-hold="true"');
  });

  it("never shows the On Hold badge on a non-deal (lead) record", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineRecordCard entity="lead" record={makeRecord({ onHold: true })} />
      </MemoryRouter>
    );

    expect(html).not.toContain('data-on-hold="true"');
  });

  it("uses the engine effective stage age for the record age label when supplied", () => {
    const html = render(
      makeRecord({
        atRisk: makeAtRiskResult({
          isAtRisk: false,
          status: "not_at_risk",
          severity: "none",
          reason: "within_sla",
          effectiveStageAgeDays: 5,
          effectiveStageAgeSeconds: 5 * 86_400,
          secondsUntilThreshold: 9 * 86_400,
          secondsPastThreshold: 0,
        }),
      })
    );

    expect(html).toContain("5d in stage");
  });

  it("falls back to shared effective stage age for Bid Board-owned records without engine data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));

    const html = render(
      makeRecord({
        atRisk: null,
        isBidBoardOwned: true,
        stageEnteredAt: "2026-05-10T00:00:00.000Z",
        bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-06T00:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      })
    );

    expect(html).toContain("5d in stage");
    expect(html).not.toContain("9d in stage");
    expect(html).not.toContain("0d in stage");
  });
});
