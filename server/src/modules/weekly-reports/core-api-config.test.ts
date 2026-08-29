import { describe, expect, it } from "vitest";
import {
  getCoreWeeklyReportApiReadiness,
  resolveCoreWeeklyReportApiRuntimeConfig,
  type CoreWeeklyReportApiEnvironment,
} from "./core-api-config.js";

const CURRENT = "crm-current-weekly-report-key-material-0001";
const PREVIOUS = "crm-previous-weekly-report-key-material-001";
const CURRENT_PUBLIC =
  "MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const PREVIOUS_PUBLIC =
  "MCowBQYDK2VwAyEAPUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

const READY_ENV: CoreWeeklyReportApiEnvironment = {
  ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
  TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
  TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: PREVIOUS,
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID: "core-weekly-2026-08",
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: CURRENT_PUBLIC,
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID: "core-weekly-2026-07",
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY: PREVIOUS_PUBLIC,
};

describe("CRM Core weekly-report API runtime readiness", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true "])(
    "is hard-dark unless the flag is the exact string true: %j",
    (flag) => {
      expect(resolveCoreWeeklyReportApiRuntimeConfig({
        ...READY_ENV,
        ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: flag,
      })).toEqual({ state: "disabled" });
    },
  );

  it("fails enabled readiness on missing, weak, unsafe, or duplicate HMAC rotation keys", () => {
    const workload = {
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID: READY_ENV.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: CURRENT_PUBLIC,
    };
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
      ...workload,
    })).toEqual({ state: "unready", reason: "missing_current_secret" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
      TROCK_CORE_WEEKLY_REPORT_API_SECRET: "short",
      ...workload,
    })).toEqual({ state: "unready", reason: "weak_current_secret" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...READY_ENV,
      TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: `${PREVIOUS}\n`,
    })).toEqual({ state: "unready", reason: "weak_previous_secret" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...READY_ENV,
      TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: CURRENT,
    })).toEqual({ state: "unready", reason: "duplicate_rotation_secrets" });
  });

  it("requires a complete, distinct Ed25519 workload public-key ring", () => {
    const base = {
      ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
      TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT,
      TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: PREVIOUS,
    };
    expect(resolveCoreWeeklyReportApiRuntimeConfig(base)).toEqual({
      state: "unready",
      reason: "missing_workload_current_key_id",
    });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...base,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID: "Core Weekly",
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: CURRENT_PUBLIC,
    })).toEqual({ state: "unready", reason: "invalid_workload_current_key_id" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...base,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID: "core-weekly-2026-08",
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: `${CURRENT_PUBLIC}=`,
    })).toEqual({ state: "unready", reason: "invalid_workload_current_public_key" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...READY_ENV,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY: undefined,
    })).toEqual({ state: "unready", reason: "incomplete_workload_previous_key" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...READY_ENV,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID: "core-weekly-2026-08",
    })).toEqual({ state: "unready", reason: "duplicate_workload_rotation_key_id" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...READY_ENV,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY: CURRENT_PUBLIC,
    })).toEqual({ state: "unready", reason: "duplicate_workload_rotation_public_key" });
    expect(resolveCoreWeeklyReportApiRuntimeConfig({
      ...READY_ENV,
      TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT_PUBLIC,
    })).toEqual({ state: "unready", reason: "workload_hmac_key_material_reuse" });
  });

  it("becomes ready only with independent HMAC and workload-key configuration", () => {
    const runtime = resolveCoreWeeklyReportApiRuntimeConfig(READY_ENV);
    expect(runtime).toMatchObject({
      state: "ready",
      currentSecret: CURRENT,
      previousSecret: PREVIOUS,
      workloadKeys: {
        current: { keyId: "core-weekly-2026-08" },
        previous: { keyId: "core-weekly-2026-07" },
      },
    });
    if (runtime.state !== "ready") throw new Error("expected ready runtime");
    expect(runtime.workloadKeys.current.publicKey.asymmetricKeyType).toBe("ed25519");
    expect(runtime.workloadKeys.previous?.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("projects only redacted state and key-slot presence", () => {
    const readiness = getCoreWeeklyReportApiReadiness(READY_ENV);
    expect(readiness).toEqual({
      feature: "crm_core_weekly_report_read_api",
      state: "ready",
      enabled: true,
      ready: true,
      currentSecretPresent: true,
      previousSecretPresent: true,
      workloadCurrentKeyPresent: true,
      workloadPreviousKeyPresent: true,
      reason: null,
    });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain(CURRENT);
    expect(serialized).not.toContain(PREVIOUS);
    expect(serialized).not.toContain(CURRENT_PUBLIC);
    expect(serialized).not.toContain(PREVIOUS_PUBLIC);
    expect(serialized).not.toMatch(/fingerprint|digest|secretValue/i);
  });
});
