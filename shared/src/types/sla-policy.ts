import type { UserRole } from "./enums.js";

export const SLA_POLICY_DAY_COUNTING = "calendar_days" as const;

export type SlaPolicyDayCounting = typeof SLA_POLICY_DAY_COUNTING;
export type SlaAudience = "rep" | "leadership";
export type SlaPolicyStageSlug =
  | "opportunity"
  | "estimating"
  | "service_estimating"
  | "estimate_sent_to_client"
  | "contract";

export interface SlaPolicyRule {
  dayCounting: SlaPolicyDayCounting;
  thresholdDays: number;
  recurs: boolean;
  recurrenceDays: number | null;
}

export interface ResolvedSlaPolicy extends SlaPolicyRule {
  stageSlug: SlaPolicyStageSlug;
  audience: SlaAudience;
}

type SlaPolicyMatrix = Readonly<
  Record<SlaPolicyStageSlug, Readonly<Record<SlaAudience, Readonly<SlaPolicyRule>>>>
>;

function freezeSlaPolicy<T extends SlaPolicyMatrix>(policy: T): T {
  for (const stagePolicy of Object.values(policy)) {
    for (const audiencePolicy of Object.values(stagePolicy)) {
      Object.freeze(audiencePolicy);
    }
    Object.freeze(stagePolicy);
  }
  return Object.freeze(policy);
}

const SLA_POLICY = freezeSlaPolicy({
  opportunity: {
    rep: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    },
    leadership: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 30,
      recurs: false,
      recurrenceDays: null,
    },
  },
  estimating: {
    rep: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 14,
      recurs: true,
      recurrenceDays: 7,
    },
    leadership: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 14,
      recurs: false,
      recurrenceDays: null,
    },
  },
  service_estimating: {
    rep: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    },
    leadership: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 14,
      recurs: false,
      recurrenceDays: null,
    },
  },
  estimate_sent_to_client: {
    rep: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    },
    leadership: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 30,
      recurs: true,
      recurrenceDays: 30,
    },
  },
  contract: {
    rep: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 2,
      recurs: false,
      recurrenceDays: null,
    },
    leadership: {
      dayCounting: SLA_POLICY_DAY_COUNTING,
      thresholdDays: 2,
      recurs: false,
      recurrenceDays: null,
    },
  },
} satisfies SlaPolicyMatrix);

function isSlaPolicyStageSlug(value: string): value is SlaPolicyStageSlug {
  return Object.prototype.hasOwnProperty.call(SLA_POLICY, value);
}

export function getSlaAudienceForRole(role: UserRole | null | undefined): SlaAudience | null {
  if (role === "rep") return "rep";
  if (role === "director" || role === "admin") return "leadership";
  return null;
}

export function getSlaPolicy(
  stageSlug: string | null | undefined,
  audience: SlaAudience | null | undefined
): ResolvedSlaPolicy | null {
  if (!stageSlug || !isSlaPolicyStageSlug(stageSlug)) {
    return null;
  }

  if (!audience) {
    return null;
  }

  return {
    stageSlug,
    audience,
    ...SLA_POLICY[stageSlug][audience],
  };
}

export function getSlaPolicyForRole(
  stageSlug: string | null | undefined,
  role: UserRole | null | undefined
): ResolvedSlaPolicy | null {
  const audience = getSlaAudienceForRole(role);
  if (!audience) {
    return null;
  }

  return getSlaPolicy(stageSlug, audience);
}
