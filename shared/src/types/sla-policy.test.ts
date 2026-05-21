import { describe, expect, it } from "vitest";
import {
  getSlaAudienceForRole,
  getSlaPolicy,
  getSlaPolicyForRole,
} from "./sla-policy.js";

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
    expect(getSlaPolicy("estimate_sent_to_client", "rep")).toMatchObject({
      stageSlug: "estimate_sent_to_client",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    });
    expect(getSlaPolicy("contract", "rep")).toMatchObject({
      stageSlug: "contract",
      audience: "rep",
      dayCounting: "calendar_days",
      thresholdDays: 2,
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
      thresholdDays: 2,
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
      thresholdDays: 2,
      recurs: false,
      recurrenceDays: null,
    });
  });

  it("handles unknown stage or unsupported role gracefully", () => {
    expect(getSlaPolicy("won", "rep")).toBeNull();
    expect(getSlaPolicy("unknown-stage", "leadership")).toBeNull();
    expect(getSlaPolicy("__proto__", "rep")).toBeNull();
    expect(getSlaPolicyForRole("won", "rep")).toBeNull();
    expect(getSlaPolicyForRole("opportunity", "construction")).toBeNull();
  });
});
