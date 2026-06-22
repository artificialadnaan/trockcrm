import { describe, expect, it } from "vitest";
import {
  CANONICAL_DEAL_WORKFLOW_CONTRACTS,
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
} from "./workflow.js";
import {
  getSlaAudienceForRole,
  getSlaPolicy,
  getSlaPolicyForRole,
} from "./sla-policy.js";

const ACTIVE_SLA_STAGES = CANONICAL_DEAL_WORKFLOW_CONTRACTS
  .filter((contract) => !contract.isTerminal)
  .map((contract) => contract.slug);

describe("SLA policy helpers", () => {
  it("returns the expected rep policy for every supported stage", () => {
    expect(getSlaPolicy("opportunity", "rep")).toMatchObject({
      stageSlug: "opportunity",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    });
    expect(getSlaPolicy("estimating", "rep")).toMatchObject({
      stageSlug: "estimating",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 14,
      recurs: true,
      recurrenceDays: 7,
    });
    expect(getSlaPolicy("service_estimating", "rep")).toMatchObject({
      stageSlug: "service_estimating",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    });
    expect(getSlaPolicy("estimate_under_review", "rep")).toMatchObject({
      stageSlug: "estimate_under_review",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 3,
      recurs: true,
      recurrenceDays: 3,
    });
    expect(getSlaPolicy("estimate_sent_to_client", "rep")).toMatchObject({
      stageSlug: "estimate_sent_to_client",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 30,
      recurs: true,
      recurrenceDays: 30,
    });
    expect(getSlaPolicy("contract", "rep")).toMatchObject({
      stageSlug: "contract",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: false,
      recurrenceDays: null,
    });
  });

  it("returns the expected leadership policy for every supported stage", () => {
    expect(getSlaPolicy("opportunity", "leadership")).toMatchObject({
      stageSlug: "opportunity",
      audience: "leadership",
      dayCounting: "calendar_days",
      thresholdDays: 30,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicy("estimating", "leadership")).toMatchObject({
      stageSlug: "estimating",
      audience: "leadership",
      dayCounting: "calendar_days",
      thresholdDays: 14,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicy("service_estimating", "leadership")).toMatchObject({
      stageSlug: "service_estimating",
      audience: "leadership",
      dayCounting: "calendar_days",
      thresholdDays: 14,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicy("estimate_under_review", "leadership")).toMatchObject({
      stageSlug: "estimate_under_review",
      audience: "leadership",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicy("estimate_sent_to_client", "leadership")).toMatchObject({
      stageSlug: "estimate_sent_to_client",
      audience: "leadership",
      dayCounting: "calendar_days",
      thresholdDays: 30,
      recurs: true,
      recurrenceDays: 30,
    });
    expect(getSlaPolicy("contract", "leadership")).toMatchObject({
      stageSlug: "contract",
      audience: "leadership",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: false,
      recurrenceDays: null,
    });
  });

  it("maps supported viewer roles to the correct SLA audience", () => {
    expect(getSlaAudienceForRole("rep")).toBe("rep");
    expect(getSlaAudienceForRole("director")).toBe("leadership");
    expect(getSlaAudienceForRole("admin")).toBe("leadership");
    expect(getSlaAudienceForRole("construction")).toBeNull();
    expect(getSlaAudienceForRole("field_contractor")).toBeNull();
  });

  it("provides a dedicated role-based accessor without mixing role and audience inputs", () => {
    expect(getSlaPolicyForRole("opportunity", "rep")).toMatchObject({
      stageSlug: "opportunity",
      audience: "rep",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    });
    expect(getSlaPolicyForRole("opportunity", "director")).toMatchObject({
      stageSlug: "opportunity",
      audience: "leadership",
      thresholdDays: 30,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicyForRole("opportunity", "construction")).toBeNull();
  });

  it("encodes recurrence semantics separately from the initial threshold", () => {
    expect(getSlaPolicy("opportunity", "rep")).toMatchObject({
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    });
    expect(getSlaPolicy("estimate_under_review", "rep")).toMatchObject({
      thresholdDays: 3,
      recurs: true,
      recurrenceDays: 3,
    });
    expect(getSlaPolicy("estimate_under_review", "leadership")).toMatchObject({
      thresholdDays: 7,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicy("estimating", "leadership")).toMatchObject({
      thresholdDays: 14,
      recurs: false,
      recurrenceDays: null,
    });
    expect(getSlaPolicy("estimate_sent_to_client", "leadership")).toMatchObject({
      thresholdDays: 30,
      recurs: true,
      recurrenceDays: 30,
    });
    expect(getSlaPolicy("contract", "rep")).toMatchObject({
      thresholdDays: 7,
      recurs: false,
      recurrenceDays: null,
    });
  });

  it("handles unknown stage or unsupported role gracefully", () => {
    expect(getSlaPolicy("unknown-stage" as never, "leadership")).toBeNull();
    expect(getSlaPolicy("__proto__" as never, "rep")).toBeNull();
    expect(getSlaPolicy("opportunity", "bogus" as "rep")).toBeNull();
    for (const stageSlug of CANONICAL_TERMINAL_DEAL_STAGE_SLUGS) {
      expect(getSlaPolicy(stageSlug as never, "rep")).toBeNull();
      expect(getSlaPolicy(stageSlug as never, "leadership")).toBeNull();
      expect(getSlaPolicyForRole(stageSlug as never, "rep")).toBeNull();
    }
    expect(getSlaPolicyForRole("opportunity", "construction")).toBeNull();
  });

  it("covers every active non-terminal stage for both audiences", () => {
    expect(ACTIVE_SLA_STAGES).toEqual([
      "opportunity",
      "estimating",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "contract",
    ]);

    for (const stageSlug of ACTIVE_SLA_STAGES) {
      expect(getSlaPolicy(stageSlug, "rep")).toMatchObject({
        stageSlug,
        audience: "rep",
        dayCounting: "calendar_days",
      });
      expect(getSlaPolicy(stageSlug, "leadership")).toMatchObject({
        stageSlug,
        audience: "leadership",
        dayCounting: "calendar_days",
      });
    }
  });

  it("rejects historical or non-SLA stage aliases so the step-1 API stays canonical-only", () => {
    expect(getSlaPolicy("service_estimate_under_review" as never, "rep")).toBeNull();
    expect(getSlaPolicy("service_estimate_sent_to_client" as never, "leadership")).toBeNull();
    expect(getSlaPolicyForRole("contract_signed" as never, "director")).toBeNull();
  });
});
