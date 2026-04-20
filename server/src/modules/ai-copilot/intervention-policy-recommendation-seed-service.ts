import crypto from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { aiDisconnectCaseHistory, aiDisconnectCases } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

type InMemoryTenantDb = {
  state: {
    cases: Array<Record<string, any>>;
    history: Array<Record<string, any>>;
  };
};

function isInMemoryTenantDb(value: unknown): value is InMemoryTenantDb {
  return Boolean(value && typeof value === "object" && "state" in value);
}

function deterministicUuid(seed: string) {
  const digest = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function fixtureAssigneeId(seedKey: string, suffix: string) {
  return deterministicUuid(`${seedKey}:assignee:${suffix}`);
}

function buildFixtureCase(seedKey: string, officeId: string, name: string, overrides: Record<string, unknown>) {
  const id = deterministicUuid(`${seedKey}:case:${name}`);
  return {
    id,
    officeId,
    scopeType: "deal",
    scopeId: deterministicUuid(`${seedKey}:scope:${name}`),
    dealId: deterministicUuid(`${seedKey}:deal:${name}`),
    companyId: deterministicUuid(`${seedKey}:company:${name}`),
    disconnectType: "missing_next_task",
    clusterKey: "follow_through_gap",
    businessKey: `${officeId}:fixture:${seedKey}:${name}`,
    severity: "high",
    status: "open",
    assignedTo: null,
    generatedTaskId: null,
    escalated: false,
    snoozedUntil: null,
    reopenCount: 0,
    firstDetectedAt: new Date("2026-04-10T12:00:00.000Z"),
    lastDetectedAt: new Date("2026-04-18T12:00:00.000Z"),
    currentLifecycleStartedAt: new Date("2026-04-10T12:00:00.000Z"),
    lastReopenedAt: null,
    lastIntervenedAt: null,
    resolvedAt: null,
    resolutionReason: null,
    metadataJson: {
      fixtureSeedKey: seedKey,
      fixtureName: name,
      evidenceSummary: `Fixture recommendation seed case ${name}.`,
      dealName: `Fixture Deal ${name}`,
      dealNumber: `FX-${name.toUpperCase()}`,
      companyName: "Fixture Company",
      stageKey: "estimating",
      stageName: "Estimating",
    },
    createdAt: new Date("2026-04-10T12:00:00.000Z"),
    updatedAt: new Date("2026-04-18T12:00:00.000Z"),
    ...overrides,
  };
}

function buildFixtureHistory(seedKey: string, caseId: string, actionType: string, actedAt: string, metadataJson: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: deterministicUuid(`${seedKey}:history:${caseId}:${actionType}:${actedAt}`),
    disconnectCaseId: caseId,
    actionType,
    actedBy: fixtureAssigneeId(seedKey, "actor"),
    actedAt: new Date(actedAt),
    fromStatus: "open",
    toStatus: actionType === "snooze" ? "snoozed" : actionType === "resolve" ? "resolved" : "open",
    fromAssignee: null,
    toAssignee: fixtureAssigneeId(seedKey, "manager-1"),
    fromSnoozedUntil: null,
    toSnoozedUntil: actionType === "snooze" ? new Date("2026-04-18T12:00:00.000Z") : null,
    notes: "Fixture qualification seed",
    metadataJson: {
      fixtureSeedKey: seedKey,
      ...metadataJson,
    },
    ...overrides,
  };
}

function buildFixtureCohort(input: { officeId: string; seedKey: string; actorUserId: string }) {
  const manager1 = input.actorUserId;
  const manager2 = fixtureAssigneeId(input.seedKey, "manager-2");
  const cases: Array<Record<string, any>> = [];
  const history: Array<Record<string, any>> = [];

  for (let index = 1; index <= 8; index++) {
    cases.push(
      buildFixtureCase(input.seedKey, input.officeId, `assignee-${index}`, {
        assignedTo: manager1,
        escalated: index <= 5,
      })
    );
  }

  for (let index = 1; index <= 5; index++) {
    const fixtureCase = buildFixtureCase(input.seedKey, input.officeId, `snooze-breached-${index}`, {
      status: "snoozed",
      assignedTo: manager1,
      snoozedUntil: new Date("2026-04-15T12:00:00.000Z"),
      lastIntervenedAt: new Date("2026-04-12T12:00:00.000Z"),
    });
    cases.push(fixtureCase);
    history.push(
      buildFixtureHistory(input.seedKey, fixtureCase.id, "snooze", `2026-04-${10 + index}T12:00:00.000Z`, {
        conclusion: {
          kind: "snooze",
          snoozeReasonCode: "waiting_on_customer",
          expectedOwnerType: "manager",
          expectedNextStepCode: "follow_up",
        },
        disconnectTypeAtConclusion: "missing_next_task",
        assigneeAtConclusion: manager1,
        lifecycleStartedAt: "2026-04-10T12:00:00.000Z",
      })
    );
  }

  for (let index = 1; index <= 3; index++) {
    const fixtureCase = buildFixtureCase(input.seedKey, input.officeId, `snooze-reopened-${index}`, {
      status: "open",
      assignedTo: manager1,
      reopenCount: 1,
      lastReopenedAt: new Date(`2026-04-${17 + index}T12:00:00.000Z`),
      currentLifecycleStartedAt: new Date(`2026-04-${17 + index}T12:00:00.000Z`),
      lastIntervenedAt: new Date(`2026-04-${13 + index}T12:00:00.000Z`),
    });
    cases.push(fixtureCase);
    const snoozeHistory = buildFixtureHistory(input.seedKey, fixtureCase.id, "snooze", `2026-04-${13 + index}T12:00:00.000Z`, {
      conclusion: {
        kind: "snooze",
        snoozeReasonCode: "waiting_on_customer",
        expectedOwnerType: "manager",
        expectedNextStepCode: "follow_up",
      },
      disconnectTypeAtConclusion: "missing_next_task",
      assigneeAtConclusion: manager1,
      lifecycleStartedAt: "2026-04-10T12:00:00.000Z",
    });
    history.push(snoozeHistory);
    history.push(
      buildFixtureHistory(
        input.seedKey,
        fixtureCase.id,
        "reopened",
        `2026-04-${17 + index}T12:00:00.000Z`,
        {
          priorConclusionActionId: snoozeHistory.id,
        },
        {
          toStatus: "open",
          actedBy: manager1,
        }
      )
    );
  }

  for (let index = 1; index <= 5; index++) {
    const fixtureCase = buildFixtureCase(input.seedKey, input.officeId, `escalate-open-${index}`, {
      status: "open",
      assignedTo: manager1,
      escalated: true,
      lastIntervenedAt: new Date(`2026-04-${12 + index}T12:00:00.000Z`),
    });
    cases.push(fixtureCase);
    history.push(
      buildFixtureHistory(input.seedKey, fixtureCase.id, "escalate", `2026-04-${12 + index}T12:00:00.000Z`, {
        conclusion: {
          kind: "escalate",
          escalationReasonCode: "manager_visibility_required",
          escalationTargetType: "ops_manager",
          urgency: "high",
        },
        disconnectTypeAtConclusion: "missing_next_task",
        assigneeAtConclusion: manager1,
        lifecycleStartedAt: "2026-04-10T12:00:00.000Z",
      })
    );
  }

  for (let index = 1; index <= 5; index++) {
    const resolvedAt = new Date(`2026-04-${14 + index}T12:00:00.000Z`);
    const fixtureCase = buildFixtureCase(input.seedKey, input.officeId, `resolve-durable-${index}`, {
      status: "resolved",
      assignedTo: manager2,
      resolvedAt,
      resolutionReason: "customer_replied_and_owner_followed_up",
      lastIntervenedAt: new Date(`2026-04-${12 + index}T12:00:00.000Z`),
    });
    cases.push(fixtureCase);
    history.push(
      buildFixtureHistory(input.seedKey, fixtureCase.id, "resolve", `2026-04-${12 + index}T12:00:00.000Z`, {
        conclusion: {
          kind: "resolve",
          outcomeCategory: "customer_response_recovered",
          reasonCode: "customer_replied_and_owner_followed_up",
          effectiveness: "confirmed",
        },
        disconnectTypeAtConclusion: "missing_next_task",
        assigneeAtConclusion: manager2,
        lifecycleStartedAt: "2026-04-10T12:00:00.000Z",
      })
    );
  }

  return {
    cases,
    history,
    patternsCreated: [
      "snooze_policy_adjustment",
      "escalation_policy_adjustment",
      "assignee_load_balancing",
    ] as const,
  };
}

async function deleteExistingFixtureCohort(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  seedKey: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    const caseIds = tenantDb.state.cases
      .filter((row) => row.officeId === officeId && row.metadataJson?.fixtureSeedKey === seedKey)
      .map((row) => row.id);
    tenantDb.state.cases = tenantDb.state.cases.filter(
      (row) => !(row.officeId === officeId && row.metadataJson?.fixtureSeedKey === seedKey)
    );
    tenantDb.state.history = tenantDb.state.history.filter((row) => !caseIds.includes(row.disconnectCaseId));
    return;
  }

  const existing = await tenantDb
    .select({ id: aiDisconnectCases.id })
    .from(aiDisconnectCases)
    .where(and(eq(aiDisconnectCases.officeId, officeId), sql`${aiDisconnectCases.metadataJson}->>'fixtureSeedKey' = ${seedKey}`));
  const caseIds = existing.map((row) => row.id);
  if (caseIds.length > 0) {
    await tenantDb.delete(aiDisconnectCaseHistory).where(inArray(aiDisconnectCaseHistory.disconnectCaseId, caseIds));
    await tenantDb.delete(aiDisconnectCases).where(inArray(aiDisconnectCases.id, caseIds));
  }
}

async function insertFixtureCohort(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { cases: Array<Record<string, any>>; history: Array<Record<string, any>> }
) {
  if (isInMemoryTenantDb(tenantDb)) {
    tenantDb.state.cases.push(...input.cases);
    tenantDb.state.history.push(...input.history);
    return;
  }

  await tenantDb.insert(aiDisconnectCases).values(input.cases as any);
  await tenantDb.insert(aiDisconnectCaseHistory).values(input.history as any);
}

async function replaceFixtureCohort(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    seedKey: string;
    fixture: { cases: Array<Record<string, any>>; history: Array<Record<string, any>> };
  }
) {
  if (isInMemoryTenantDb(tenantDb)) {
    await deleteExistingFixtureCohort(tenantDb, input.officeId, input.seedKey);
    await insertFixtureCohort(tenantDb, input.fixture);
    return;
  }

  await (tenantDb as any).transaction(async (tx: TenantDb) => {
    await deleteExistingFixtureCohort(tx, input.officeId, input.seedKey);
    await insertFixtureCohort(tx, input.fixture);
  });
}

export async function seedInterventionPolicyRecommendationQualificationData(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    actorUserId: string;
    environment: string;
    allowedOfficeIds?: string[] | null;
    seedKey?: string;
  }
) {
  if (input.environment === "production") {
    throw new AppError(403, "Policy recommendation qualification seed is not available in production.");
  }

  const allowedOfficeIds = input.allowedOfficeIds?.filter(Boolean) ?? [];
  if (allowedOfficeIds.length > 0 && !allowedOfficeIds.includes(input.officeId)) {
    throw new AppError(403, "Policy recommendation qualification seed is only available for approved fixture offices.");
  }

  const seedKey = input.seedKey ?? "policy-recommendation-fixture";
  const fixture = buildFixtureCohort({
    officeId: input.officeId,
    seedKey,
    actorUserId: input.actorUserId,
  });
  await replaceFixtureCohort(tenantDb, {
    officeId: input.officeId,
    seedKey,
    fixture,
  });

  return {
    seeded: true as const,
    patternsCreated: [...fixture.patternsCreated],
    seedKey,
  };
}
