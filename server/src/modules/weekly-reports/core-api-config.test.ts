import { describe, expect, it } from "vitest";
import {
  getCoreWeeklyReportApiReadiness,
  resolveCoreWeeklyReportApiRuntimeConfig,
} from "./core-api-config.js";

const CURRENT = "crm-current-weekly-report-key-material-0001";
const PREVIOUS = "crm-previous-weekly-report-key-material-001";

describe("CRM Core weekly-report API runtime readiness", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true "])(
    "is hard-dark unless the flag is the exact string true: %j",
    (flag) => {
      expect(
        resolveCoreWeeklyReportApiRuntimeConfig({
          ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: flag,
          TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
          TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: PREVIOUS,
        }, { peerAuthorizerConfigured: true }),
      ).toEqual({ state: "disabled" });
    },
  );

  it("fails enabled readiness on missing, weak, unsafe, or duplicate rotation keys", () => {
    const enabled = { ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true" } as const;
    expect(
      resolveCoreWeeklyReportApiRuntimeConfig(enabled, { peerAuthorizerConfigured: true }),
    ).toEqual({ state: "unready", reason: "missing_current_secret" });
    expect(
      resolveCoreWeeklyReportApiRuntimeConfig(
        { ...enabled, TROCK_CORE_WEEKLY_REPORT_API_SECRET: "short" },
        { peerAuthorizerConfigured: true },
      ),
    ).toEqual({ state: "unready", reason: "weak_current_secret" });
    expect(
      resolveCoreWeeklyReportApiRuntimeConfig(
        {
          ...enabled,
          TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
          TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: `${PREVIOUS}\n`,
        },
        { peerAuthorizerConfigured: true },
      ),
    ).toEqual({ state: "unready", reason: "weak_previous_secret" });
    expect(
      resolveCoreWeeklyReportApiRuntimeConfig(
        {
          ...enabled,
          TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
          TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: CURRENT,
        },
        { peerAuthorizerConfigured: true },
      ),
    ).toEqual({ state: "unready", reason: "duplicate_rotation_secrets" });
  });

  it("requires an independently supplied trusted-peer verifier in addition to valid HMAC keys", () => {
    const env = {
      ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
      TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
      TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: PREVIOUS,
    };
    expect(resolveCoreWeeklyReportApiRuntimeConfig(env)).toEqual({
      state: "unready",
      reason: "missing_peer_authorizer",
    });
    expect(resolveCoreWeeklyReportApiRuntimeConfig(env, { peerAuthorizerConfigured: true })).toEqual({
      state: "ready",
      currentSecret: CURRENT,
      previousSecret: PREVIOUS,
    });
  });

  it("projects only redacted state and key-slot presence", () => {
    const env = {
      ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
      TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
      TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: PREVIOUS,
    };
    const readiness = getCoreWeeklyReportApiReadiness(env, { peerAuthorizerConfigured: true });
    expect(readiness).toEqual({
      feature: "crm_core_weekly_report_read_api",
      state: "ready",
      enabled: true,
      ready: true,
      currentSecretPresent: true,
      previousSecretPresent: true,
      reason: null,
    });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain(CURRENT);
    expect(serialized).not.toContain(PREVIOUS);
    expect(serialized).not.toMatch(/fingerprint|digest|secretValue/i);
  });
});
