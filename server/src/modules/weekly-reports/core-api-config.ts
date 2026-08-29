import {
  coreWeeklyReportSecretReadiness,
  type CoreWeeklyReportSecretReadiness,
} from "./core-api-auth.js";

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
}

export type CoreWeeklyReportApiRuntimeConfig =
  | { state: "disabled" }
  | {
      state: "unready";
      reason:
        | "missing_peer_authorizer"
        | Exclude<CoreWeeklyReportSecretReadiness, { ok: true }>["reason"];
    }
  | {
      state: "ready";
      currentSecret: string;
      previousSecret: string | null;
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
    | "missing_peer_authorizer"
    | Exclude<CoreWeeklyReportSecretReadiness, { ok: true }>["reason"]
    | null;
}

export interface CoreWeeklyReportApiRuntimeRequirements {
  /**
   * True only when the HTTP host supplied a verifier backed by trusted workload identity or mTLS.
   * Forwarded/header claims are deliberately insufficient.
   */
  peerAuthorizerConfigured?: boolean;
}

/**
 * Resolve the dark-by-default runtime state without trimming or accepting truthy aliases. A deployment
 * has to set the reviewed flag to the exact string `true`; `TRUE`, `1`, and whitespace-padded values
 * remain dark. Once enabled, unsafe key rotation configuration is a distinct fail-closed state.
 */
export function resolveCoreWeeklyReportApiRuntimeConfig(
  env: CoreWeeklyReportApiEnvironment,
  requirements: CoreWeeklyReportApiRuntimeRequirements = {},
): CoreWeeklyReportApiRuntimeConfig {
  if (env.ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API !== "true") {
    return { state: "disabled" };
  }

  const secrets = coreWeeklyReportSecretReadiness(
    env.TROCK_CORE_WEEKLY_REPORT_API_SECRET,
    env.TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET,
  );
  if (!secrets.ok) return { state: "unready", reason: secrets.reason };
  if (requirements.peerAuthorizerConfigured !== true) {
    return { state: "unready", reason: "missing_peer_authorizer" };
  }
  return {
    state: "ready",
    currentSecret: secrets.currentSecret,
    previousSecret: secrets.previousSecret,
  };
}

/** Redacted operator/readiness projection: it never returns key material or a key-derived value. */
export function getCoreWeeklyReportApiReadiness(
  env: CoreWeeklyReportApiEnvironment,
  requirements: CoreWeeklyReportApiRuntimeRequirements = {},
): CoreWeeklyReportApiReadiness {
  const runtime = resolveCoreWeeklyReportApiRuntimeConfig(env, requirements);
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
    reason:
      runtime.state === "disabled"
        ? "disabled"
        : runtime.state === "unready"
          ? runtime.reason
          : null,
  };
}
