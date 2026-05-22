// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AtRiskResult } from "@trock-crm/shared/types";
import { AtRiskBadge } from "./at-risk-badge";

function makeAtRiskResult(overrides: Partial<AtRiskResult> = {}): AtRiskResult {
  return {
    isAtRisk: true,
    status: "at_risk",
    severity: "at_risk",
    reason: "threshold_reached",
    stageSlug: "estimating",
    canonicalStageSlug: "estimating",
    viewerRole: "rep",
    audience: "rep",
    policy: {
      audience: "rep",
      stageSlug: "estimating",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    },
    effectiveStageAgeSeconds: 864_000,
    effectiveStageAgeDays: 10,
    thresholdSeconds: 604_800,
    thresholdDays: 7,
    secondsUntilThreshold: 0,
    secondsPastThreshold: 259_200,
    ...overrides,
  };
}

describe("AtRiskBadge", () => {
  it("renders the shared at-risk status and severity", () => {
    const html = renderToStaticMarkup(<AtRiskBadge atRisk={makeAtRiskResult()} />);

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-status="at_risk"');
    expect(html).toContain('data-at-risk-severity="at_risk"');
    expect(html).toContain("10d");
    expect(html).toContain("7d SLA");
  });

  it("renders a compact badge for card surfaces", () => {
    const html = renderToStaticMarkup(<AtRiskBadge atRisk={makeAtRiskResult()} compact />);

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-severity="at_risk"');
    expect(html).not.toContain("7d SLA");
  });

  it("renders nothing when Slice B has not supplied at-risk data", () => {
    const html = renderToStaticMarkup(<AtRiskBadge atRisk={undefined} />);

    expect(html).toBe("");
  });

  it("renders nothing for not-at-risk results", () => {
    const html = renderToStaticMarkup(
      <AtRiskBadge
        atRisk={makeAtRiskResult({
          isAtRisk: false,
          status: "not_at_risk",
          severity: "none",
          reason: "within_sla",
          effectiveStageAgeDays: 3,
          secondsUntilThreshold: 345_600,
          secondsPastThreshold: 0,
        })}
      />
    );

    expect(html).toBe("");
  });
});
