import {
  coreWeeklyReportSecretReadiness,
  type CoreWeeklyReportSecretReadiness,
} from "./core-api-auth.js";
import {
  coreWeeklyReportWorkloadKeyReadiness,
  type CoreWeeklyReportWorkloadKeyReadiness,
  type CoreWeeklyReportWorkloadKeyring,
} from "./core-api-workload-auth.js";

export const CORE_WEEKLY_REPORT_READ_API_FLAG =
  "ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API" as const;
export const CORE_WEEKLY_REPORT_CURRENT_SECRET_ENV =
  "TROCK_CORE_WEEKLY_REPORT_API_SECRET" as const;
export const CORE_WEEKLY_REPORT_PREVIOUS_SECRET_ENV =
  "TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET" as const;

export interface CoreWeeklyReportApiEnvironment {
  ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API?: string;
  TROCK_CORE_WEEKLY_REPORT_API_SECRET?: string;
  TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY?: string;
}

export type CoreWeeklyReportApiRuntimeConfig =
  | { state: "disabled" }
  | {
      state: "unready";
      reason:
        | Exclude<CoreWeeklyReportSecretReadiness, { ok: true }>["reason"]
        | Exclude<CoreWeeklyReportWorkloadKeyReadiness, { ok: true }>["reason"]
        | "workload_hmac_key_material_reuse";
    }
  | {
      state: "ready";
      currentSecret: string;
      previousSecret: string | null;
      workloadKeys: CoreWeeklyReportWorkloadKeyring;
    };

export interface CoreWeeklyReportApiReadiness {
  feature: "crm_core_weekly_report_read_api";
  state: CoreWeeklyReportApiRuntimeConfig["state"];
  enabled: boolean;
  ready: boolean;
  currentSecretPresent: boolean;
  previousSecretPresent: boolean;
  reason:
    | "disabled"
    | Exclude<CoreWeeklyReportSecretReadiness, { ok: true }>["reason"]
    | Exclude<CoreWeeklyReportWorkloadKeyReadiness, { ok: true }>["reason"]
    | "workload_hmac_key_material_reuse"
    | null;
  workloadCurrentKeyPresent: boolean;
  workloadPreviousKeyPresent: boolean;
}

/**
 * Resolve the dark-by-default runtime state without trimming or accepting truthy aliases. A deployment
 * has to set the reviewed flag to the exact string `true`; `TRUE`, `1`, and whitespace-padded values
 * remain dark. Once enabled, unsafe key rotation configuration is a distinct fail-closed state.
 */
export function resolveCoreWeeklyReportApiRuntimeConfig(
  env: CoreWeeklyReportApiEnvironment,
): CoreWeeklyReportApiRuntimeConfig {
  if (env.ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API !== "true") {
    return { state: "disabled" };
  }

  const secrets = coreWeeklyReportSecretReadiness(
    env.TROCK_CORE_WEEKLY_REPORT_API_SECRET,
    env.TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET,
  );
  if (!secrets.ok) return { state: "unready", reason: secrets.reason };
  const workloadKeys = coreWeeklyReportWorkloadKeyReadiness(env);
  if (!workloadKeys.ok) return { state: "unready", reason: workloadKeys.reason };
  const encodedWorkloadKeys = [
    env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY,
    env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY,
  ];
  if (
    encodedWorkloadKeys.includes(secrets.currentSecret) ||
    (secrets.previousSecret !== null && encodedWorkloadKeys.includes(secrets.previousSecret))
  ) {
    return { state: "unready", reason: "workload_hmac_key_material_reuse" };
  }
  return {
    state: "ready",
    currentSecret: secrets.currentSecret,
    previousSecret: secrets.previousSecret,
    workloadKeys: workloadKeys.keyring,
  };
}

/** Redacted operator/readiness projection: it never returns key material or a key-derived value. */
export function getCoreWeeklyReportApiReadiness(
  env: CoreWeeklyReportApiEnvironment,
): CoreWeeklyReportApiReadiness {
  const runtime = resolveCoreWeeklyReportApiRuntimeConfig(env);
  return {
    feature: "crm_core_weekly_report_read_api",
    state: runtime.state,
    enabled: runtime.state !== "disabled",
    ready: runtime.state === "ready",
    currentSecretPresent: typeof env.TROCK_CORE_WEEKLY_REPORT_API_SECRET === "string" &&
      env.TROCK_CORE_WEEKLY_REPORT_API_SECRET.length > 0,
    previousSecretPresent:
      typeof env.TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET === "string" &&
      env.TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET.length > 0,
    workloadCurrentKeyPresent:
      typeof env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID === "string" &&
      env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID.length > 0 &&
      typeof env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY === "string" &&
      env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY.length > 0,
    workloadPreviousKeyPresent:
      typeof env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID === "string" &&
      env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID.length > 0 &&
      typeof env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY === "string" &&
      env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY.length > 0,
    reason:
      runtime.state === "disabled"
        ? "disabled"
        : runtime.state === "unready"
          ? runtime.reason
          : null,
  };
}
