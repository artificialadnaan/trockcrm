# Intervention Outcome Capture and Resolution Effectiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require structured outcome capture for resolve/snooze/escalate actions, persist canonical conclusion and reopen events in case history, and surface initial effectiveness analytics for managers.

**Architecture:** Extend the existing intervention mutation pipeline instead of adding a new outcome subsystem. The server remains the canonical validator/writer for conclusion payloads and history events, the client collects structured conclusion forms in batch/detail flows, and analytics derive effectiveness from `ai_disconnect_case_history` plus explicit `reopened` events.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Vitest, existing React hooks/pages/components, tenant-scoped Postgres schemas.

---

## File Structure

### Existing files to modify

- `shared/src/schema/tenant/ai-disconnect-case-history.ts`
  - extend history event metadata expectations in code comments/types only if needed for clarity
- `shared/src/schema/tenant/ai-disconnect-cases.ts`
  - confirm latest-state fields already support reopen/escalation semantics; add fields only if implementation proves necessary
- `server/src/modules/ai-copilot/intervention-service.ts`
  - canonical mutation validation, structured history writes, reopen event writes, effectiveness aggregation inputs
- `server/src/modules/ai-copilot/intervention-types.ts`
  - request/result and analytics DTOs for structured conclusions, queue summary/filters, and effectiveness reporting
- `server/src/modules/ai-copilot/routes.ts`
  - route-level payload validation/transition handling for batch/detail snooze/resolve/escalate
- `server/tests/modules/ai-copilot/intervention-service.test.ts`
  - primary server behavior and history assertions
- `server/tests/modules/ai-copilot/routes.test.ts`
  - route contract and mixed-deploy compatibility assertions
- `client/src/hooks/use-admin-interventions.ts`
  - request payloads, mutation helpers, queue `summary` / `availableFilters`, and result handling
- `client/src/hooks/use-admin-interventions.test.ts`
  - payload and state regressions
- `client/src/components/ai/intervention-batch-toolbar.tsx`
  - structured conclusion forms for batch actions
- `client/src/components/ai/intervention-detail-panel.tsx`
  - structured conclusion forms for single-case actions
- `client/src/pages/admin/admin-intervention-analytics-page.tsx`
  - initial effectiveness cards/tables and “intervention useful” reporting on the existing analytics page
- `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
  - analytics UI regressions

### New files likely needed

- `shared/src/lib/intervention-outcome-taxonomy.ts`
  - canonical enum-like code sets and compatibility helpers shared by server and client
- `server/tests/modules/ai-copilot/intervention-outcome-taxonomy.test.ts`
  - deterministic mapping/validation coverage
- `client/src/components/ai/intervention-conclusion-form.tsx`
  - shared structured form surface for resolve/snooze/escalate
- `client/src/components/ai/intervention-conclusion-form.test.tsx`
  - shared form behavior coverage
- `client/src/lib/intervention-outcome-taxonomy.ts`
  - client-safe re-export of the shared taxonomy helpers for form options and legacy mapping
- `client/src/components/ai/intervention-effectiveness-summary.tsx`
  - focused analytics UI if the existing analytics page would otherwise get too large

### Boundaries

- Keep taxonomy and compatibility mapping centralized in one shared module.
- Keep history-writing logic inside `intervention-service.ts`; do not split outcome persistence into a parallel store.
- Keep batch/detail client behavior on one shared form component so validation stays identical across surfaces.

---

### Task 1: Lock Taxonomy and Compatibility Mapping

**Files:**
- Create: `shared/src/lib/intervention-outcome-taxonomy.ts`
- Test: `server/tests/modules/ai-copilot/intervention-outcome-taxonomy.test.ts`

- [ ] **Step 1: Write the failing taxonomy tests**

```ts
import { describe, expect, it } from "vitest";
import {
  RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES,
  SNOOZE_REASON_TO_EXPECTED_OPTIONS,
  ESCALATION_TARGET_TYPES,
  REOPEN_REASONS,
  mapStructuredResolveReasonToLegacyResolutionReason,
} from "../../../../shared/src/lib/intervention-outcome-taxonomy.js";

describe("intervention outcome taxonomy", () => {
  it("keeps resolve reason codes one-to-one with outcome categories", () => {
    expect(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES.issue_fixed).toEqual([
      "customer_replied_and_owner_followed_up",
      "work_advanced_after_follow_up",
    ]);
    expect(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES.task_completed).toEqual([
      "missing_task_created_and_completed",
    ]);
  });

  it("maps structured resolve reasons back to legacy resolution reasons during transition", () => {
    expect(mapStructuredResolveReasonToLegacyResolutionReason("owner_assigned_and_confirmed")).toBe("owner_aligned");
    expect(mapStructuredResolveReasonToLegacyResolutionReason("duplicate_case_consolidated")).toBe("duplicate_case");
  });

  it("defines valid snooze combinations and reopen reasons", () => {
    expect(SNOOZE_REASON_TO_EXPECTED_OPTIONS.waiting_on_external).toEqual({
      ownerTypes: ["external"],
      nextStepCodes: ["external_dependency_expected"],
    });
    expect(REOPEN_REASONS).toContain("resolution_did_not_hold");
    expect(ESCALATION_TARGET_TYPES).toContain("other");
  });
});
```

- [ ] **Step 2: Run the taxonomy test to verify it fails**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-outcome-taxonomy.test.ts`
Expected: FAIL with module-not-found or missing export errors.

- [ ] **Step 3: Write the minimal taxonomy module**

```ts
export const RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES = {
  issue_fixed: ["customer_replied_and_owner_followed_up", "work_advanced_after_follow_up"],
  owner_aligned: ["owner_assigned_and_confirmed"],
  task_completed: ["missing_task_created_and_completed"],
  duplicate_or_merged: ["duplicate_case_consolidated"],
  false_positive: ["signal_was_not_actionable"],
  no_longer_relevant: ["business_context_changed"],
} as const;

export const SNOOZE_REASON_TO_EXPECTED_OPTIONS = {
  waiting_on_customer: { ownerTypes: ["customer"], nextStepCodes: ["customer_reply_expected"] },
  waiting_on_rep: { ownerTypes: ["rep"], nextStepCodes: ["rep_follow_up_expected"] },
  waiting_on_estimating: { ownerTypes: ["estimating"], nextStepCodes: ["estimating_update_expected"] },
  waiting_on_manager_review: { ownerTypes: ["director"], nextStepCodes: ["manager_review_expected"] },
  waiting_on_external: { ownerTypes: ["external"], nextStepCodes: ["external_dependency_expected"] },
  timing_not_actionable_yet: { ownerTypes: ["admin", "director"], nextStepCodes: ["timing_window_reached"] },
  temporary_false_positive: { ownerTypes: ["admin", "director"], nextStepCodes: ["manager_review_expected"] },
} as const;

export const ESCALATION_TARGET_TYPES = ["director", "admin", "estimating_lead", "office_manager", "other"] as const;
export const REOPEN_REASONS = [
  "signal_still_present",
  "snooze_expired_without_progress",
  "escalation_did_not_move_issue",
  "resolution_did_not_hold",
  "new_evidence_reopened_case",
] as const;

export function mapStructuredResolveReasonToLegacyResolutionReason(reasonCode: string) {
  switch (reasonCode) {
    case "customer_replied_and_owner_followed_up":
    case "work_advanced_after_follow_up":
      return "follow_up_completed";
    case "owner_assigned_and_confirmed":
      return "owner_aligned";
    case "missing_task_created_and_completed":
      return "task_completed";
    case "duplicate_case_consolidated":
      return "duplicate_case";
    case "signal_was_not_actionable":
      return "false_positive";
    case "business_context_changed":
      return "issue_no_longer_relevant";
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the taxonomy test to verify it passes**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-outcome-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/lib/intervention-outcome-taxonomy.ts server/tests/modules/ai-copilot/intervention-outcome-taxonomy.test.ts
git commit -m "feat: add intervention outcome taxonomy"
```

### Task 2: Add Server-Side Structured Conclusion Validation

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Modify: `server/tests/modules/ai-copilot/intervention-service.test.ts`
- Use: `shared/src/lib/intervention-outcome-taxonomy.ts`

- [ ] **Step 1: Write failing service tests for structured conclusion payloads**

```ts
it("allows legacy-only resolve payloads while legacy outcome writes remain enabled", async () => {
  const tenantDb = createTenantDb({ cases: [makeCase()] });

  const result = await resolveInterventionCases(tenantDb as any, {
    officeId: "office-1",
    actorUserId: "director-1",
    actorRole: "director",
    caseIds: ["case-1"],
    resolutionReason: "task_completed",
    conclusion: null,
    allowLegacyOutcomeWrites: true,
  });

  expect(result.updatedCount).toBe(1);
});

it("rejects resolving without a structured conclusion payload once legacy outcome writes are disabled", async () => {
  const tenantDb = createTenantDb({ cases: [makeCase()] });

  await expect(
    resolveInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      resolutionReason: "task_completed",
      conclusion: null,
      allowLegacyOutcomeWrites: false,
    })
  ).rejects.toThrow("Structured resolve conclusion is required");
});

it("rejects invalid snooze reason/owner/next-step combinations", async () => {
  const tenantDb = createTenantDb({ cases: [makeCase()] });

  await expect(
    snoozeInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      conclusion: {
        kind: "snooze",
        snoozeReasonCode: "waiting_on_customer",
        expectedOwnerType: "rep",
        expectedNextStepCode: "rep_follow_up_expected",
      },
    })
  ).rejects.toThrow("Invalid snooze conclusion combination");
});
```

- [ ] **Step 2: Run the service test subset to verify it fails**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: FAIL on missing `conclusion` support and validation.

- [ ] **Step 3: Extend service input types and validation helpers**

```ts
type ResolveConclusionInput = {
  kind: "resolve";
  outcomeCategory: "issue_fixed" | "owner_aligned" | "task_completed" | "duplicate_or_merged" | "false_positive" | "no_longer_relevant";
  resolutionReasonCode: string;
  effectivenessExpectation: "high_confidence" | "partial_fix" | "administrative_close";
  notes?: string | null;
};

type SnoozeConclusionInput = {
  kind: "snooze";
  snoozeReasonCode: string;
  expectedOwnerType: "rep" | "admin" | "director" | "customer" | "estimating" | "external";
  expectedNextStepCode: string;
  notes?: string | null;
};

type EscalateConclusionInput = {
  kind: "escalate";
  escalationReasonCode: string;
  escalationTargetType: "director" | "admin" | "estimating_lead" | "office_manager" | "other";
  escalationTargetLabel?: string | null;
  urgencyLevel: "same_day" | "this_week" | "monitor_only";
  notes?: string | null;
};

function assertValidResolveConclusion(input: ResolveConclusionInput) {
  const allowed = RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES[input.outcomeCategory];
  if (!allowed?.includes(input.resolutionReasonCode as never)) {
    throw new AppError(400, "Invalid resolve conclusion combination");
  }
}

function assertValidSnoozeConclusion(input: SnoozeConclusionInput) {
  const allowed = SNOOZE_REASON_TO_EXPECTED_OPTIONS[input.snoozeReasonCode];
  if (
    !allowed ||
    !allowed.ownerTypes.includes(input.expectedOwnerType as never) ||
    !allowed.nextStepCodes.includes(input.expectedNextStepCode as never)
  ) {
    throw new AppError(400, "Invalid snooze conclusion combination");
  }
}

function assertValidEscalateConclusion(input: EscalateConclusionInput) {
  if (!ESCALATION_TARGET_TYPES.includes(input.escalationTargetType as never)) {
    throw new AppError(400, "Invalid escalation conclusion combination");
  }
}

function assertStructuredConclusionPresent<TConclusion>(
  conclusion: TConclusion | null,
  options: { allowLegacyOutcomeWrites: boolean; kind: "resolve" | "snooze" | "escalate" }
) {
  if (conclusion || options.allowLegacyOutcomeWrites) return;
  throw new AppError(400, `Structured ${options.kind} conclusion is required`);
}

type ResolveInterventionCasesInput = {
  officeId: string;
  actorUserId: string;
  actorRole: string;
  caseIds: string[];
  resolutionReason?: string | null;
  conclusion: ResolveConclusionInput | null;
  allowLegacyOutcomeWrites: boolean;
  notes?: string | null;
};

type SnoozeInterventionCasesInput = {
  officeId: string;
  actorUserId: string;
  actorRole: string;
  caseIds: string[];
  snoozedUntil: string;
  conclusion: SnoozeConclusionInput | null;
  allowLegacyOutcomeWrites: boolean;
  notes?: string | null;
};

type EscalateInterventionCasesInput = {
  officeId: string;
  actorUserId: string;
  actorRole: string;
  caseIds: string[];
  conclusion: EscalateConclusionInput | null;
  allowLegacyOutcomeWrites: boolean;
  notes?: string | null;
};
```

- [ ] **Step 4: Persist canonical conclusion metadata on resolve/snooze/escalate history writes**

```ts
assertStructuredConclusionPresent(input.conclusion, {
  allowLegacyOutcomeWrites: input.allowLegacyOutcomeWrites,
  kind: "resolve",
});

await writeMutationArtifacts(tenantDb, row, {
  actionType: "resolve",
  actedBy: input.actorUserId,
  comment: input.conclusion?.notes ?? input.notes ?? null,
  fromStatus,
  toStatus: "resolved",
  metadataJson: {
    resolutionReason: input.resolutionReason,
    taskOutcome,
    lifecycleStartedAt: row.currentLifecycleStartedAt.toISOString(),
    assigneeAtConclusion: row.assignedTo ?? null,
    disconnectTypeAtConclusion: row.disconnectType,
    conclusion: input.conclusion
      ? {
          kind: "resolve",
          outcomeCategory: input.conclusion.outcomeCategory,
          resolutionReasonCode: input.conclusion.resolutionReasonCode,
          effectivenessExpectation: input.conclusion.effectivenessExpectation,
        }
      : null,
  },
});

assertStructuredConclusionPresent(input.conclusion, {
  allowLegacyOutcomeWrites: input.allowLegacyOutcomeWrites,
  kind: "snooze",
});
if (input.conclusion) {
  assertValidSnoozeConclusion(input.conclusion);
}
await writeMutationArtifacts(tenantDb, row, {
  actionType: "snooze",
  actedBy: input.actorUserId,
  comment: input.conclusion?.notes ?? input.notes ?? null,
  fromStatus,
  toStatus: "snoozed",
  metadataJson: {
    lifecycleStartedAt: row.currentLifecycleStartedAt.toISOString(),
    assigneeAtConclusion: row.assignedTo ?? null,
    disconnectTypeAtConclusion: row.disconnectType,
    conclusion: input.conclusion,
  },
});

assertStructuredConclusionPresent(input.conclusion, {
  allowLegacyOutcomeWrites: input.allowLegacyOutcomeWrites,
  kind: "escalate",
});
if (input.conclusion) {
  assertValidEscalateConclusion(input.conclusion);
}
await writeMutationArtifacts(tenantDb, row, {
  actionType: "escalate",
  actedBy: input.actorUserId,
  comment: input.conclusion?.notes ?? input.notes ?? null,
  fromStatus,
  toStatus: row.status,
  metadataJson: {
    lifecycleStartedAt: row.currentLifecycleStartedAt.toISOString(),
    assigneeAtConclusion: row.assignedTo ?? null,
    disconnectTypeAtConclusion: row.disconnectType,
    conclusion: input.conclusion,
  },
});
```

- [ ] **Step 5: Run the service test subset to verify it passes**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: PASS with new conclusion assertions.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/ai-copilot/intervention-types.ts server/src/modules/ai-copilot/intervention-service.ts server/tests/modules/ai-copilot/intervention-service.test.ts
git commit -m "feat: require structured intervention conclusions"
```

- [ ] **Step 7: Extend queue/detail DTOs and list/detail handlers with outcome-ready fields**

```ts
export interface InterventionQueueItem {
  // existing fields...
  snoozedUntil: string | null;
}

export interface InterventionQueueResult {
  items: InterventionQueueItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  summary: {
    openCount: number;
    snoozedCount: number;
    resolvedCount: number;
    escalatedCount: number;
  };
  availableFilters: {
    disconnectTypes: string[];
    assignees: Array<{ id: string; name: string }>;
    stages: Array<{ key: string; label: string }>;
  };
  supportedSorts: Array<"ageDays" | "severity" | "lastIntervenedAt" | "lastDetectedAt">;
}

function buildInterventionQueueResult(rows: InterventionRow[]): InterventionQueueResult {
  return {
    items: rows.map(mapInterventionRowToQueueItem),
    totalCount,
    page,
    pageSize,
    summary: buildInterventionQueueSummary(rows),
    availableFilters: buildInterventionAvailableFilters(rows),
    supportedSorts: ["ageDays", "severity", "lastIntervenedAt", "lastDetectedAt"],
  };
}

// wire the new result shape through listInterventionCases() and GET /api/ai/ops/interventions
```

- [ ] **Step 8: Run the service and hook tests to verify the DTO additions pass**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts client/src/hooks/use-admin-interventions.test.ts --config client/vite.config.ts`
Expected: PASS with `snoozedUntil`, `summary`, and `availableFilters` covered.

### Task 3: Add Reopen Event Writing and Idempotent Lifecycle Attribution

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Modify: `server/tests/modules/ai-copilot/intervention-service.test.ts`
- Create: `migrations/0031_intervention_system_actor.sql`

- [ ] **Step 1: Write a failing test for reopen event emission**

```ts
import * as serviceModule from "../../../src/modules/ai-copilot/intervention-service.js";

it("writes one reopened history event when a resolved case reopens", async () => {
  const tenantDb = createTenantDb({
    cases: [
      makeCase({
        status: "resolved",
        resolvedAt: new Date("2026-04-15T10:00:00.000Z"),
        resolutionReason: "owner_aligned",
        reopenCount: 0,
      }),
    ],
  });

  vi.spyOn(serviceModule, "listCurrentSalesProcessDisconnectRows").mockResolvedValue([
    makeDisconnectRow({ id: "deal-1" }),
  ]);

  await materializeDisconnectCases(tenantDb as any, {
    officeId: "office-1",
    now: new Date("2026-04-16T15:00:00.000Z"),
  });

  expect(tenantDb.state.history.find((row) => row.actionType === "reopened")).toMatchObject({
    actedBy: serviceModule.INTERVENTION_SYSTEM_ACTOR_ID,
    metadataJson: {
      reopenReason: "signal_still_present",
    },
  });
});
```

- [ ] **Step 2: Run the failing reopen test**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: FAIL because no `reopened` event exists yet.

- [ ] **Step 3: Implement idempotent reopen writing in the materialization/reopen path**

```ts
import { sql } from "drizzle-orm";

export const INTERVENTION_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";

// migration 0031 inserts a real public.users row with this id so reopened
// history writes satisfy the actedBy FK at runtime

function getSystemActorUserId() {
  return INTERVENTION_SYSTEM_ACTOR_ID;
}

function buildReopenHistoryMetadata(input: {
  priorConclusionActionId: string;
  priorConclusionKind: "resolve" | "snooze" | "escalate";
  reopenReason: string;
  lifecycleStartedAt: string;
}) {
  return {
    priorConclusionActionId: input.priorConclusionActionId,
    priorConclusionKind: input.priorConclusionKind,
    reopenReason: input.reopenReason,
    lifecycleStartedAt: input.lifecycleStartedAt,
  };
}

function readHistoryConclusionKind(
  row: { metadataJson: Record<string, unknown> | null; actionType: string }
): "resolve" | "snooze" | "escalate" {
  const kind = row.metadataJson?.conclusion && typeof row.metadataJson.conclusion === "object"
    ? (row.metadataJson.conclusion as { kind?: "resolve" | "snooze" | "escalate" }).kind
    : undefined;
  if (kind === "resolve" || kind === "snooze" || kind === "escalate") return kind;
  if (row.actionType === "resolve" || row.actionType === "snooze" || row.actionType === "escalate") {
    return row.actionType;
  }
  return "resolve";
}

async function hasReopenHistoryForConclusionAction(
  tenantDb: TenantDb | InMemoryTenantDb,
  caseId: string,
  priorConclusionActionId: string
) {
  if ("state" in tenantDb) {
    return (
      tenantDb.state.history.find(
        (item) =>
          item.disconnectCaseId === caseId &&
          item.actionType === "reopened" &&
          item.metadataJson?.priorConclusionActionId === priorConclusionActionId
      ) ?? null
    );
  }
  return tenantDb
    .select({ id: aiDisconnectCaseHistory.id })
    .from(aiDisconnectCaseHistory)
    .where(
      and(
        eq(aiDisconnectCaseHistory.disconnectCaseId, caseId),
        eq(aiDisconnectCaseHistory.actionType, "reopened"),
        sql`${aiDisconnectCaseHistory.metadataJson}->>'priorConclusionActionId' = ${priorConclusionActionId}`
      )
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function getLatestConclusionHistoryEvent(
  tenantDb: TenantDb | InMemoryTenantDb,
  caseId: string
) {
  if ("state" in tenantDb) {
    const row = [...tenantDb.state.history]
      .filter(
        (item) =>
          item.disconnectCaseId === caseId &&
          ["resolve", "snooze", "escalate"].includes(item.actionType)
      )
      .sort((left, right) => new Date(right.actedAt).getTime() - new Date(left.actedAt).getTime())[0];
    if (!row) throw new AppError(500, `Missing latest conclusion history for case ${caseId}`);
    return row;
  }

  const row = await tenantDb
    .select()
    .from(aiDisconnectCaseHistory)
    .where(
      and(
        eq(aiDisconnectCaseHistory.disconnectCaseId, caseId),
        inArray(aiDisconnectCaseHistory.actionType, ["resolve", "snooze", "escalate"])
      )
    )
    .orderBy(desc(aiDisconnectCaseHistory.actedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw new AppError(500, `Missing latest conclusion history for case ${caseId}`);
  return row;
}

// in the reopen branch
const nextLifecycleStartedAt = now;
const systemActorUserId = getSystemActorUserId();
const latestConclusionEvent = await getLatestConclusionHistoryEvent(tenantDb, row.id);
if (!(await hasReopenHistoryForConclusionAction(tenantDb, row.id, latestConclusionEvent.id))) {
  await writeMutationArtifacts(tenantDb, row, {
    actionType: "reopened",
    actedBy: systemActorUserId,
    fromStatus: row.status,
    toStatus: "open",
    fromAssignee: row.assignedTo ?? null,
    toAssignee: row.assignedTo ?? null,
    metadataJson: buildReopenHistoryMetadata({
      priorConclusionActionId: latestConclusionEvent.id,
      priorConclusionKind: readHistoryConclusionKind(latestConclusionEvent),
      reopenReason: "signal_still_present",
      lifecycleStartedAt: nextLifecycleStartedAt.toISOString(),
    }),
  });
}
```

- [ ] **Step 4: Add dedupe coverage for repeated materialization**

```ts
it("does not duplicate reopened history events on repeated materialization retries", async () => {
  // materialize same reopen twice
  expect(tenantDb.state.history.filter((row) => row.actionType === "reopened")).toHaveLength(1);
});
```

- [ ] **Step 5: Run the reopen-focused service tests**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts`
Expected: PASS with explicit `reopened` event coverage.

- [ ] **Step 6: Commit**

```bash
git add migrations/0031_intervention_system_actor.sql server/src/modules/ai-copilot/intervention-service.ts server/tests/modules/ai-copilot/intervention-service.test.ts
git commit -m "feat: track reopened intervention outcomes"
```

### Task 4: Support Mixed-Deploy Compatibility at the Route Layer

**Files:**
- Modify: `server/src/modules/ai-copilot/routes.ts`
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Modify: `server/tests/modules/ai-copilot/routes.test.ts`
- Use: `shared/src/lib/intervention-outcome-taxonomy.ts`

- [ ] **Step 1: Write failing route tests for transition behavior**

```ts
import { assertHomogeneousBatchConclusionCohort } from "../../../src/modules/ai-copilot/intervention-service.js";
import { mapStructuredResolveReasonToLegacyResolutionReason } from "../../../../shared/src/lib/intervention-outcome-taxonomy.js";

vi.mock("../../../src/modules/ai-copilot/intervention-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/ai-copilot/intervention-service.js")>(
    "../../../src/modules/ai-copilot/intervention-service.js"
  );
  return {
    ...actual,
    assertHomogeneousBatchConclusionCohort: vi.fn(),
  };
});

it("rejects conflicting legacy and structured resolve payloads", async () => {
  const res = await request(app)
    .post("/api/ai/ops/interventions/case-1/resolve")
    .send({
      resolutionReason: "owner_aligned",
      conclusion: {
        kind: "resolve",
        outcomeCategory: "task_completed",
        resolutionReasonCode: "missing_task_created_and_completed",
        effectivenessExpectation: "high_confidence",
      },
    });

  expect(res.status).toBe(400);
});

it("rejects conflicting legacy and structured snooze payloads", async () => {
  const res = await request(app)
    .post("/api/ai/ops/interventions/case-1/snooze")
    .send({
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      notes: "legacy note",
      conclusion: {
        kind: "snooze",
        snoozeReasonCode: "waiting_on_customer",
        expectedOwnerType: "rep",
        expectedNextStepCode: "rep_follow_up_expected",
      },
    });

  expect(res.status).toBe(400);
});

it("requires structured conclusions on batch resolve/snooze/escalate routes when legacy writes are disabled", async () => {
  const resolveRes = await request(app)
    .post("/api/ai/ops/interventions/batch-resolve")
    .send({ caseIds: ["case-1"], resolutionReason: "owner_aligned" });

  const snoozeRes = await request(app)
    .post("/api/ai/ops/interventions/batch-snooze")
    .send({ caseIds: ["case-1"], snoozedUntil: "2026-04-20T00:00:00.000Z" });

  const escalateRes = await request(app)
    .post("/api/ai/ops/interventions/batch-escalate")
    .send({ caseIds: ["case-1"] });

  expect(resolveRes.status).toBe(400);
  expect(snoozeRes.status).toBe(400);
  expect(escalateRes.status).toBe(400);
});

it("rejects heterogeneous batch conclusion cohorts", async () => {
  vi.mocked(assertHomogeneousBatchConclusionCohort).mockRejectedValueOnce(
    new AppError(400, "Batch conclusion requires a homogeneous cohort")
  );

  const res = await request(app)
    .post("/api/ai/ops/interventions/batch-resolve")
    .send({
      caseIds: ["case-1", "case-2"],
      conclusion: {
        kind: "resolve",
        outcomeCategory: "task_completed",
        resolutionReasonCode: "missing_task_created_and_completed",
        effectivenessExpectation: "high_confidence",
      },
    });

  expect(res.status).toBe(400);
  expect(res.body.error.message).toContain("Batch conclusion requires a homogeneous cohort");
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run: `npx vitest run server/tests/modules/ai-copilot/routes.test.ts`
Expected: FAIL due to missing conclusion parsing.

- [ ] **Step 3: Add route parsing for structured conclusion payloads and transition gate**

```ts
import { assertHomogeneousBatchConclusionCohort } from "./intervention-service.js";
import { mapStructuredResolveReasonToLegacyResolutionReason } from "../../../../shared/src/lib/intervention-outcome-taxonomy.js";

const allowLegacyOutcomeWrites = process.env.ALLOW_LEGACY_OUTCOME_WRITES === "true";

function readStructuredConclusion(body: any, kind: "resolve" | "snooze" | "escalate") {
  if (body?.conclusion?.kind === kind) return body.conclusion;
  if (!allowLegacyOutcomeWrites) {
    throw new AppError(400, `Structured ${kind} conclusion is required`);
  }
  return null;
}

function assertNoLegacyConflict(input: {
  legacyResolutionReason?: string | null;
  structuredResolveConclusion?: { resolutionReasonCode: string } | null;
}) {
  if (!input.legacyResolutionReason || !input.structuredResolveConclusion) return;
  const mappedLegacy = mapStructuredResolveReasonToLegacyResolutionReason(
    input.structuredResolveConclusion.resolutionReasonCode
  );
  if (mappedLegacy !== input.legacyResolutionReason) {
    throw new AppError(400, "Legacy resolutionReason conflicts with structured conclusion");
  }
}
```

- [ ] **Step 4: Add compatibility conflict checks**

```ts
const conclusion = readStructuredConclusion(req.body, "resolve");
const resolutionReason =
  typeof req.body?.resolutionReason === "string"
    ? req.body.resolutionReason
    : conclusion
      ? mapStructuredResolveReasonToLegacyResolutionReason(conclusion.resolutionReasonCode)
      : null;
if (!conclusion && !resolutionReason) {
  throw new AppError(400, "resolutionReason is required");
}
if (resolutionReason && !RESOLUTION_REASONS.has(resolutionReason)) {
  throw new AppError(400, "Invalid resolutionReason");
}
assertNoLegacyConflict({
  legacyResolutionReason: req.body?.resolutionReason ?? null,
  structuredResolveConclusion: conclusion,
});

const result = await resolveInterventionCases(req.tenantDb!, {
  officeId: getActiveOfficeId(req),
  actorUserId: req.user!.id,
  actorRole: req.user!.role,
  caseIds: [caseId],
  resolutionReason,
  conclusion,
  allowLegacyOutcomeWrites,
  notes: typeof req.body?.notes === "string" ? req.body.notes : null,
});

const singleSnoozeConclusion = readStructuredConclusion(req.body, "snooze");
const singleEscalateConclusion = readStructuredConclusion(req.body, "escalate");
if (typeof req.body?.snoozedUntil !== "string" || req.body.snoozedUntil.trim().length === 0) {
  throw new AppError(400, "snoozedUntil is required");
}

await snoozeInterventionCases(req.tenantDb!, {
  officeId: getActiveOfficeId(req),
  actorUserId: req.user!.id,
  actorRole: req.user!.role,
  caseIds: [caseId],
  snoozedUntil: req.body.snoozedUntil,
  conclusion: singleSnoozeConclusion,
  allowLegacyOutcomeWrites,
  notes: typeof req.body?.notes === "string" ? req.body.notes : null,
});

await escalateInterventionCases(req.tenantDb!, {
  officeId: getActiveOfficeId(req),
  actorUserId: req.user!.id,
  actorRole: req.user!.role,
  caseIds: [caseId],
  conclusion: singleEscalateConclusion,
  allowLegacyOutcomeWrites,
  notes: typeof req.body?.notes === "string" ? req.body.notes : null,
});

// in the batch-resolve handler:
const batchResolveConclusion = readStructuredConclusion(req.body, "resolve");
// in the batch-snooze handler:
const batchSnoozeConclusion = readStructuredConclusion(req.body, "snooze");
// in the batch-escalate handler:
const batchEscalateConclusion = readStructuredConclusion(req.body, "escalate");
const caseIds = requireCaseIds(req.body?.caseIds);
if (
  // in the batch-snooze handler, keep the current fail-fast requirement
  // regardless of rollout mode or whether a structured conclusion is present
  (typeof req.body?.snoozedUntil !== "string" || req.body.snoozedUntil.trim().length === 0)
) {
  throw new AppError(400, "snoozedUntil is required");
}
if (
  typeof req.body?.resolutionReason === "string" &&
  !RESOLUTION_REASONS.has(req.body.resolutionReason)
) {
  throw new AppError(400, "Invalid resolutionReason");
}
const snoozedUntil = req.body.snoozedUntil;
const legacyResolutionReason = typeof req.body?.resolutionReason === "string" ? req.body.resolutionReason : null;
const batchResolutionReason =
  legacyResolutionReason
    ? legacyResolutionReason
    : batchResolveConclusion
      ? mapStructuredResolveReasonToLegacyResolutionReason(batchResolveConclusion.resolutionReasonCode)
      : null;
if (!batchResolveConclusion && !batchResolutionReason) {
  throw new AppError(400, "resolutionReason is required");
}
assertNoLegacyConflict({
  legacyResolutionReason: req.body?.resolutionReason ?? null,
  structuredResolveConclusion: batchResolveConclusion,
});
if (batchResolveConclusion) {
  await assertHomogeneousBatchConclusionCohort(
    req.tenantDb!,
    getActiveOfficeId(req),
    caseIds,
    "resolve"
  );
}
if (batchSnoozeConclusion) {
  await assertHomogeneousBatchConclusionCohort(
    req.tenantDb!,
    getActiveOfficeId(req),
    caseIds,
    "snooze"
  );
}
if (batchEscalateConclusion) {
  await assertHomogeneousBatchConclusionCohort(
    req.tenantDb!,
    getActiveOfficeId(req),
    caseIds,
    "escalate"
  );
}
// apply the same transition + conflict rules in both batch and single-case handlers,
// and thread the same cohort validation into the underlying batch service helpers so
// direct service callers cannot bypass it; also forward allowLegacyOutcomeWrites
// into batchResolveInterventions / batchSnoozeInterventions / batchEscalateInterventions
await resolveInterventionCases(req.tenantDb!, {
  officeId: getActiveOfficeId(req),
  actorUserId: req.user!.id,
  actorRole: req.user!.role,
  caseIds,
  resolutionReason: batchResolutionReason,
  conclusion: batchResolveConclusion,
  allowLegacyOutcomeWrites,
});
await snoozeInterventionCases(req.tenantDb!, {
  officeId: getActiveOfficeId(req),
  actorUserId: req.user!.id,
  actorRole: req.user!.role,
  caseIds,
  snoozedUntil,
  conclusion: batchSnoozeConclusion,
  allowLegacyOutcomeWrites,
});
await escalateInterventionCases(req.tenantDb!, {
  officeId: getActiveOfficeId(req),
  actorUserId: req.user!.id,
  actorRole: req.user!.role,
  caseIds,
  conclusion: batchEscalateConclusion,
  allowLegacyOutcomeWrites,
});
```

- [ ] **Step 4a: Add and export the service-owned batch cohort validator**

```ts
export async function assertHomogeneousBatchConclusionCohort(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  caseIds: string[],
  actionKind: "resolve" | "snooze" | "escalate"
) {
  const rows = await loadCasesForMutation(tenantDb, officeId, caseIds);
  if (rows.length === 0) {
    throw new AppError(400, "At least one intervention case is required");
  }
  if (!rows.every((row) => row.disconnectType === rows[0]!.disconnectType)) {
    throw new AppError(400, "Batch conclusion requires a homogeneous cohort");
  }
  const expectedReasonFamily = getConclusionReasonFamilyForCase(rows[0]!, actionKind);
  const matchesReasonFamily = rows.every(
    (row) => getConclusionReasonFamilyForCase(row, actionKind) === expectedReasonFamily
  );
  if (!matchesReasonFamily) {
    throw new AppError(400, "Batch conclusion requires a homogeneous cohort");
  }
}

function getConclusionReasonFamilyForCase(
  row: { disconnectType: string },
  actionKind: "resolve" | "snooze" | "escalate"
) {
  switch (`${actionKind}:${row.disconnectType}`) {
    case "resolve:missing_next_task":
      return "resolve:task_execution";
    case "resolve:inbound_without_followup":
      return "resolve:follow_up_execution";
    case "snooze:estimating_gate_gap":
      return "snooze:estimating_wait";
    case "escalate:revision_loop":
      return "escalate:manager_intervention";
    default:
      return `${actionKind}:${row.disconnectType}`;
  }
}

// call this from resolveInterventionCases / snoozeInterventionCases /
// escalateInterventionCases when caseIds.length > 1 and a structured
// conclusion payload is present so direct service callers cannot bypass
// the homogeneous-batch rule
export async function resolveInterventionCases(tenantDb: TenantDb, input: ResolveInterventionCasesInput) {
  if (input.caseIds.length > 1) {
    await assertHomogeneousBatchConclusionCohort(
      tenantDb,
      input.officeId,
      input.caseIds,
      "resolve"
    );
  }
}

export async function snoozeInterventionCases(tenantDb: TenantDb, input: SnoozeInterventionCasesInput) {
  if (input.caseIds.length > 1) {
    await assertHomogeneousBatchConclusionCohort(
      tenantDb,
      input.officeId,
      input.caseIds,
      "snooze"
    );
  }
}

export async function escalateInterventionCases(tenantDb: TenantDb, input: EscalateInterventionCasesInput) {
  if (input.caseIds.length > 1) {
    await assertHomogeneousBatchConclusionCohort(
      tenantDb,
      input.officeId,
      input.caseIds,
      "escalate"
    );
  }
}
```

- [ ] **Step 5: Run route tests to verify pass**

Run: `npx vitest run server/tests/modules/ai-copilot/routes.test.ts`
Expected: PASS with new `400` and transition assertions.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/ai-copilot/routes.ts server/src/modules/ai-copilot/intervention-service.ts server/tests/modules/ai-copilot/routes.test.ts
git commit -m "feat: add transition-safe intervention outcome routes"
```

### Task 5: Build Shared Client Conclusion Forms for Batch and Detail Flows

**Files:**
- Create: `client/src/components/ai/intervention-conclusion-form.tsx`
- Test: `client/src/components/ai/intervention-conclusion-form.test.tsx`
- Create: `client/src/lib/intervention-outcome-taxonomy.ts`
- Modify: `client/src/components/ai/intervention-batch-toolbar.tsx`
- Modify: `client/src/components/ai/intervention-detail-panel.tsx`
- Modify: `client/src/pages/admin/admin-intervention-workspace-page.tsx`
- Modify: `client/src/hooks/use-admin-interventions.ts`
- Modify: `client/src/hooks/use-admin-interventions.test.ts`

- [ ] **Step 1: Write failing client form tests**

```tsx
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InterventionConclusionForm,
  canSubmitInterventionConclusion,
} from "./intervention-conclusion-form";

it("keeps resolve submit disabled until required structured fields are complete", () => {
  expect(
    canSubmitInterventionConclusion("resolve", {
      kind: "resolve",
      outcomeCategory: "",
      resolutionReasonCode: "",
      effectivenessExpectation: "",
      notes: "",
    })
  ).toBe(false);
});

it("renders taxonomy-backed snooze fields in static markup", () => {
  const html = renderToStaticMarkup(
    <InterventionConclusionForm mode="snooze" submitLabel="Snooze" onSubmit={vi.fn()} />
  );
  expect(html).toContain("Snooze reason");
  expect(html).toContain("Expected owner");
});
```

- [ ] **Step 2: Run the client form tests to verify failure**

Run: `npx vitest run client/src/components/ai/intervention-conclusion-form.test.tsx --config client/vite.config.ts`
Expected: FAIL because component does not exist yet.

- [ ] **Step 3: Create the shared conclusion form component**

```tsx
// client/src/lib/intervention-outcome-taxonomy.ts
export type ResolveConclusionPayload = {
  kind: "resolve";
  outcomeCategory: string;
  resolutionReasonCode: string;
  effectivenessExpectation: string;
  notes: string | null;
};

export type SnoozeConclusionPayload = {
  kind: "snooze";
  snoozeReasonCode: string;
  expectedOwnerType: string;
  expectedNextStepCode: string;
  snoozedUntil: string;
  notes: string | null;
};

export type EscalateConclusionPayload = {
  kind: "escalate";
  escalationReasonCode: string;
  escalationTargetType: string;
  urgencyLevel: string;
  notes: string | null;
  escalationTargetLabel?: string;
};

export {
  ESCALATION_TARGET_TYPES,
  RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES,
  SNOOZE_REASON_TO_EXPECTED_OPTIONS,
  mapStructuredResolveReasonToLegacyResolutionReason,
} from "../../../shared/src/lib/intervention-outcome-taxonomy.js";

// client/src/components/ai/intervention-conclusion-form.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ESCALATION_TARGET_TYPES,
  type EscalateConclusionPayload,
  type ResolveConclusionPayload,
  RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES,
  SNOOZE_REASON_TO_EXPECTED_OPTIONS,
  type SnoozeConclusionPayload,
} from "@/lib/intervention-outcome-taxonomy";

export function canSubmitInterventionConclusion(
  mode: "resolve",
  form: ResolveConclusionPayload
): boolean;
export function canSubmitInterventionConclusion(
  mode: "snooze",
  form: SnoozeConclusionPayload
): boolean;
export function canSubmitInterventionConclusion(
  mode: "escalate",
  form: EscalateConclusionPayload
): boolean;
export function canSubmitInterventionConclusion(
  mode: "resolve" | "snooze" | "escalate",
  form: ResolveConclusionPayload | SnoozeConclusionPayload | EscalateConclusionPayload
) {
  if (mode === "resolve") {
    return Boolean(
      (form as ResolveConclusionPayload).outcomeCategory &&
      (form as ResolveConclusionPayload).resolutionReasonCode &&
      (form as ResolveConclusionPayload).effectivenessExpectation
    );
  }
  if (mode === "snooze") {
    return Boolean(
      (form as SnoozeConclusionPayload).snoozeReasonCode &&
      (form as SnoozeConclusionPayload).expectedOwnerType &&
      (form as SnoozeConclusionPayload).expectedNextStepCode &&
      (form as SnoozeConclusionPayload).snoozedUntil
    );
  }
  return Boolean(
    (form as EscalateConclusionPayload).escalationReasonCode &&
    (form as EscalateConclusionPayload).escalationTargetType &&
    (form as EscalateConclusionPayload).urgencyLevel
  );
}

export function InterventionConclusionForm(props: {
  mode: "resolve" | "snooze" | "escalate";
  onSubmit: (payload: ResolveConclusionPayload | SnoozeConclusionPayload | EscalateConclusionPayload) => Promise<void> | void;
  submitLabel: string;
}) {
  const [resolveForm, setResolveForm] = useState({
    kind: "resolve" as const,
    outcomeCategory: "",
    resolutionReasonCode: "",
    effectivenessExpectation: "",
    notes: "",
  });
  const [snoozeForm, setSnoozeForm] = useState({
    kind: "snooze" as const,
    snoozeReasonCode: "",
    expectedOwnerType: "",
    expectedNextStepCode: "",
    snoozedUntil: "",
    notes: "",
  });
  const [escalateForm, setEscalateForm] = useState({
    kind: "escalate" as const,
    escalationReasonCode: "",
    escalationTargetType: "",
    escalationTargetLabel: "",
    urgencyLevel: "",
    notes: "",
  });
  const canSubmit = canSubmitInterventionConclusion(
    props.mode,
    props.mode === "resolve" ? resolveForm : props.mode === "snooze" ? snoozeForm : escalateForm
  );

  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!canSubmit) return;
      void props.onSubmit(props.mode === "resolve" ? resolveForm : props.mode === "snooze" ? snoozeForm : escalateForm);
    }}>
      {props.mode === "resolve" && (
        <>
          <select
            aria-label="Outcome category"
            value={resolveForm.outcomeCategory}
            onChange={(event) => setResolveForm((current) => ({ ...current, outcomeCategory: event.target.value }))}
          >
            <option value="">Select outcome category</option>
            {Object.keys(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES).map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <select
            aria-label="Resolution reason"
            value={resolveForm.resolutionReasonCode}
            onChange={(event) => setResolveForm((current) => ({ ...current, resolutionReasonCode: event.target.value }))}
          >
            <option value="">Select resolution reason</option>
            {(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES[resolveForm.outcomeCategory] ?? []).map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <select
            aria-label="Effectiveness expectation"
            value={resolveForm.effectivenessExpectation}
            onChange={(event) => setResolveForm((current) => ({ ...current, effectivenessExpectation: event.target.value }))}
          >
            <option value="">Select effectiveness expectation</option>
            <option value="high_confidence">high_confidence</option>
            <option value="partial_fix">partial_fix</option>
            <option value="administrative_close">administrative_close</option>
          </select>
          <textarea
            aria-label="Notes"
            value={resolveForm.notes}
            onChange={(event) => setResolveForm((current) => ({ ...current, notes: event.target.value }))}
          />
        </>
      )}
      {props.mode === "snooze" && (
        <>
          <select
            aria-label="Snooze reason"
            value={snoozeForm.snoozeReasonCode}
            onChange={(event) => setSnoozeForm((current) => ({ ...current, snoozeReasonCode: event.target.value }))}
          >
            <option value="">Select snooze reason</option>
            {Object.keys(SNOOZE_REASON_TO_EXPECTED_OPTIONS).map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <select
            aria-label="Expected owner"
            value={snoozeForm.expectedOwnerType}
            onChange={(event) => setSnoozeForm((current) => ({ ...current, expectedOwnerType: event.target.value }))}
          >
            <option value="">Select expected owner</option>
            {(SNOOZE_REASON_TO_EXPECTED_OPTIONS[snoozeForm.snoozeReasonCode]?.ownerTypes ?? []).map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <select
            aria-label="Expected next step"
            value={snoozeForm.expectedNextStepCode}
            onChange={(event) => setSnoozeForm((current) => ({ ...current, expectedNextStepCode: event.target.value }))}
          >
            <option value="">Select expected next step</option>
            {(SNOOZE_REASON_TO_EXPECTED_OPTIONS[snoozeForm.snoozeReasonCode]?.nextStepCodes ?? []).map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <input
            aria-label="Snoozed until"
            type="datetime-local"
            value={snoozeForm.snoozedUntil}
            onChange={(event) => setSnoozeForm((current) => ({ ...current, snoozedUntil: event.target.value }))}
          />
          <textarea
            aria-label="Notes"
            value={snoozeForm.notes}
            onChange={(event) => setSnoozeForm((current) => ({ ...current, notes: event.target.value }))}
          />
        </>
      )}
      {props.mode === "escalate" && (
        <>
          <select
            aria-label="Escalation reason"
            value={escalateForm.escalationReasonCode}
            onChange={(event) => setEscalateForm((current) => ({ ...current, escalationReasonCode: event.target.value }))}
          >
            <option value="">Select escalation reason</option>
            <option value="manager_attention_required">manager_attention_required</option>
            <option value="estimating_follow_up_required">estimating_follow_up_required</option>
            <option value="customer_commitment_blocked">customer_commitment_blocked</option>
          </select>
          <select
            aria-label="Escalation target"
            value={escalateForm.escalationTargetType}
            onChange={(event) => setEscalateForm((current) => ({ ...current, escalationTargetType: event.target.value }))}
          >
            <option value="">Select escalation target</option>
            {ESCALATION_TARGET_TYPES.map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <select
            aria-label="Urgency level"
            value={escalateForm.urgencyLevel}
            onChange={(event) => setEscalateForm((current) => ({ ...current, urgencyLevel: event.target.value }))}
          >
            <option value="">Select urgency level</option>
            <option value="same_day">same_day</option>
            <option value="this_week">this_week</option>
            <option value="monitor_only">monitor_only</option>
          </select>
          <textarea
            aria-label="Notes"
            value={escalateForm.notes}
            onChange={(event) => setEscalateForm((current) => ({ ...current, notes: event.target.value }))}
          />
        </>
      )}
      <Button type="submit" disabled={!canSubmit}>{props.submitLabel}</Button>
    </form>
  );
}
```

- [ ] **Step 4: Wire batch/detail actions through the shared form and hook payloads**

```ts
import { mapStructuredResolveReasonToLegacyResolutionReason } from "@/lib/intervention-outcome-taxonomy";
import type {
  EscalateConclusionPayload,
  ResolveConclusionPayload,
  SnoozeConclusionPayload,
} from "@/lib/intervention-outcome-taxonomy";

await batchResolveInterventions({
  caseIds,
  resolutionReason: mapStructuredResolveReasonToLegacyResolutionReason(form.resolutionReasonCode),
  conclusion: {
    kind: "resolve",
    outcomeCategory: form.outcomeCategory,
    resolutionReasonCode: form.resolutionReasonCode,
    effectivenessExpectation: form.effectivenessExpectation,
    notes: form.notes || null,
  },
});

await batchSnoozeInterventions({
  caseIds,
  snoozedUntil: form.snoozedUntil,
  conclusion: {
    kind: "snooze",
    snoozeReasonCode: form.snoozeReasonCode,
    expectedOwnerType: form.expectedOwnerType,
    expectedNextStepCode: form.expectedNextStepCode,
    notes: form.notes || null,
  },
});

await batchEscalateInterventions({
  caseIds,
  conclusion: {
    kind: "escalate",
    escalationReasonCode: form.escalationReasonCode,
    escalationTargetType: form.escalationTargetType,
    escalationTargetLabel: form.escalationTargetLabel || null,
    urgencyLevel: form.urgencyLevel,
    notes: form.notes || null,
  },
});

await resolveIntervention({
  caseId,
  resolutionReason: mapStructuredResolveReasonToLegacyResolutionReason(form.resolutionReasonCode),
  conclusion: {
    kind: "resolve",
    outcomeCategory: form.outcomeCategory,
    resolutionReasonCode: form.resolutionReasonCode,
    effectivenessExpectation: form.effectivenessExpectation,
    notes: form.notes || null,
  },
});

await snoozeIntervention({
  caseId,
  snoozedUntil: form.snoozedUntil,
  conclusion: {
    kind: "snooze",
    snoozeReasonCode: form.snoozeReasonCode,
    expectedOwnerType: form.expectedOwnerType,
    expectedNextStepCode: form.expectedNextStepCode,
    notes: form.notes || null,
  },
});

await escalateIntervention({
  caseId,
  conclusion: {
    kind: "escalate",
    escalationReasonCode: form.escalationReasonCode,
    escalationTargetType: form.escalationTargetType,
    escalationTargetLabel: form.escalationTargetLabel || null,
    urgencyLevel: form.urgencyLevel,
    notes: form.notes || null,
  },
});

// widen the exported hook helper signatures so batchResolveInterventions,
// batchSnoozeInterventions, and batchEscalateInterventions all accept
// structured `conclusion` payloads plus the legacy compatibility fields
type BatchResolveInterventionsInput = {
  caseIds: string[];
  resolutionReason?: string | null;
  conclusion: ResolveConclusionPayload | null;
  notes?: string | null;
};

type BatchSnoozeInterventionsInput = {
  caseIds: string[];
  snoozedUntil: string;
  conclusion: SnoozeConclusionPayload | null;
  notes?: string | null;
};

type BatchEscalateInterventionsInput = {
  caseIds: string[];
  conclusion: EscalateConclusionPayload | null;
  notes?: string | null;
};

type ResolveInterventionInput = {
  caseId: string;
  resolutionReason?: string | null;
  conclusion: ResolveConclusionPayload | null;
  notes?: string | null;
};

type SnoozeInterventionInput = {
  caseId: string;
  snoozedUntil: string;
  conclusion: SnoozeConclusionPayload | null;
  notes?: string | null;
};

type EscalateInterventionInput = {
  caseId: string;
  conclusion: EscalateConclusionPayload | null;
  notes?: string | null;
};

export async function batchResolveInterventions(input: BatchResolveInterventionsInput) {
  return api("/ai/ops/interventions/batch-resolve", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      resolutionReason: input.resolutionReason ?? null,
      conclusion: input.conclusion,
      notes: input.notes ?? null,
    },
  });
}

export async function batchSnoozeInterventions(input: BatchSnoozeInterventionsInput) {
  return api("/ai/ops/interventions/batch-snooze", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      snoozedUntil: localDateTimeInputToIso(input.snoozedUntil),
      conclusion: input.conclusion,
      notes: input.notes ?? null,
    },
  });
}

export async function batchEscalateInterventions(input: BatchEscalateInterventionsInput) {
  return api("/ai/ops/interventions/batch-escalate", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      conclusion: input.conclusion,
      notes: input.notes ?? null,
    },
  });
}

export async function resolveIntervention(input: ResolveInterventionInput) {
  return api(`/ai/ops/interventions/${input.caseId}/resolve`, {
    method: "POST",
    json: {
      resolutionReason: input.resolutionReason ?? null,
      conclusion: input.conclusion,
      notes: input.notes ?? null,
    },
  });
}

export async function snoozeIntervention(input: SnoozeInterventionInput) {
  return api(`/ai/ops/interventions/${input.caseId}/snooze`, {
    method: "POST",
    json: {
      snoozedUntil: localDateTimeInputToIso(input.snoozedUntil),
      conclusion: input.conclusion,
      notes: input.notes ?? null,
    },
  });
}

export async function escalateIntervention(input: EscalateInterventionInput) {
  return api(`/ai/ops/interventions/${input.caseId}/escalate`, {
    method: "POST",
    json: {
      conclusion: input.conclusion,
      notes: input.notes ?? null,
    },
  });
}

// update use-admin-interventions.test.ts batch helper call sites so legacy-only
// cases either pass `conclusion: null` during the rollout window or the new
// structured conclusion payload when asserting the upgraded request bodies
// update the existing single-case helper assertions to the object form too:
// resolveIntervention({ caseId: "case-1", resolutionReason: "owner_aligned", conclusion: null })
// snoozeIntervention({ caseId: "case-1", snoozedUntil: "2026-04-20T12:00", conclusion: null })
// escalateIntervention({ caseId: "case-1", conclusion: null })
```

- [ ] **Step 5: Run the focused client tests**

Run: `npx vitest run client/src/components/ai/intervention-conclusion-form.test.tsx client/src/hooks/use-admin-interventions.test.ts --config client/vite.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ai/intervention-conclusion-form.tsx client/src/components/ai/intervention-conclusion-form.test.tsx client/src/lib/intervention-outcome-taxonomy.ts client/src/components/ai/intervention-batch-toolbar.tsx client/src/components/ai/intervention-detail-panel.tsx client/src/pages/admin/admin-intervention-workspace-page.tsx client/src/hooks/use-admin-interventions.ts client/src/hooks/use-admin-interventions.test.ts
git commit -m "feat: add structured intervention conclusion forms"
```

### Task 6: Add Initial Resolution Effectiveness Analytics

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Modify: `server/tests/modules/ai-copilot/intervention-service.test.ts`
- Modify: `client/src/hooks/use-ai-ops.ts`
- Modify: `client/src/hooks/use-ai-ops.test.ts`
- Modify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Create: `client/src/components/ai/intervention-effectiveness-summary.tsx`
- Test: `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`

Note:
- `/admin/intervention-analytics` is already routed in `client/src/App.tsx` in this checkout, so this task extends the existing page rather than adding a new route.

- [ ] **Step 1: Write failing analytics tests**

```ts
it("computes reopen rate by conclusion family from history events", async () => {
  const dashboard = await getInterventionAnalyticsDashboard(tenantDb as any, { officeId: "office-1" });
  expect(dashboard.outcomeEffectiveness.reopenRateByConclusionFamily.resolve).toBe(0.5);
});
```

- [ ] **Step 2: Run analytics tests to verify failure**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts`
Expected: FAIL because effectiveness fields do not exist yet.

- [ ] **Step 3: Extend analytics DTOs and compute history-backed effectiveness**

```ts
// in client/src/hooks/use-ai-ops.ts
export type InterventionOutcomeEffectiveness = {
  reopenRateByConclusionFamily: Record<"resolve" | "snooze" | "escalate", number | null>;
  reopenRateByResolveCategory: Array<{ key: string; rate: number | null; count: number }>;
  reopenRateBySnoozeReason: Array<{ key: string; rate: number | null; count: number }>;
  reopenRateByEscalationReason: Array<{ key: string; rate: number | null; count: number }>;
  conclusionMixByDisconnectType: Array<{ key: string; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  conclusionMixByActingUser: Array<{ actorUserId: string; actorName: string | null; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  conclusionMixByAssigneeAtConclusion: Array<{ assigneeId: string | null; assigneeName: string | null; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  medianDaysToReopenByConclusionFamily: Array<{ key: string; medianDays: number | null }>;
};

// only count history rows with metadataJson.conclusion in structured
// effectiveness metrics; legacy-only transition rows stay out of these
// analytics until they are backfilled or naturally replaced
export interface InterventionAnalyticsDashboard {
  // existing fields...
  outcomeEffectiveness: InterventionOutcomeEffectiveness;
}

// in server/src/modules/ai-copilot/intervention-types.ts:
export type InterventionOutcomeEffectiveness = {
  reopenRateByConclusionFamily: Record<"resolve" | "snooze" | "escalate", number | null>;
  reopenRateByResolveCategory: Array<{ key: string; rate: number | null; count: number }>;
  reopenRateBySnoozeReason: Array<{ key: string; rate: number | null; count: number }>;
  reopenRateByEscalationReason: Array<{ key: string; rate: number | null; count: number }>;
  conclusionMixByDisconnectType: Array<{ key: string; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  conclusionMixByActingUser: Array<{ actorUserId: string; actorName: string | null; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  conclusionMixByAssigneeAtConclusion: Array<{ assigneeId: string | null; assigneeName: string | null; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  medianDaysToReopenByConclusionFamily: Array<{ key: string; medianDays: number | null }>;
};

export interface InterventionAnalyticsDashboard {
  // existing fields...
  outcomeEffectiveness: InterventionOutcomeEffectiveness;
}

// in server/src/modules/ai-copilot/intervention-service.ts:
import type { InterventionOutcomeEffectiveness } from "./intervention-types.js";

function buildGroupedRate(
  rows: DisconnectCaseHistoryRow[],
  keyFor: (row: DisconnectCaseHistoryRow) => string,
  reopenedByActionId: Set<string>
) {
  return rows.reduce<Record<string, number | null>>((acc, row) => {
    const key = keyFor(row);
    const group = rows.filter((candidate) => keyFor(candidate) === key);
    const reopened = group.filter((candidate) => reopenedByActionId.has(candidate.id));
    acc[key] = group.length === 0 ? null : reopened.length / group.length;
    return acc;
  }, {});
}

function readHistoryMetadata(row: DisconnectCaseHistoryRow) {
  return (row.metadataJson ?? {}) as {
    conclusion?: {
      kind?: "resolve" | "snooze" | "escalate";
      outcomeCategory?: string;
      snoozeReasonCode?: string;
      escalationReasonCode?: string;
    };
    priorConclusionActionId?: string;
    assigneeAtConclusion?: string | null;
    disconnectTypeAtConclusion?: string;
  };
}

function buildGroupedRateTable(
  rows: DisconnectCaseHistoryRow[],
  keyFor: (row: DisconnectCaseHistoryRow) => string,
  reopenedByActionId: Set<string>
) {
  const rates = buildGroupedRate(rows, keyFor, reopenedByActionId);
  return Object.entries(rates).map(([key, rate]) => ({
    key,
    rate,
    count: rows.filter((row) => keyFor(row) === key).length,
  }));
}

function buildConclusionMixByDisconnectType(rows: DisconnectCaseHistoryRow[]) {
  return Array.from(new Set(rows.map((row) => String(readHistoryMetadata(row).disconnectTypeAtConclusion ?? "")))).map((key) => ({
    key,
    resolveCount: rows.filter((row) => String(readHistoryMetadata(row).disconnectTypeAtConclusion ?? "") === key && readHistoryMetadata(row).conclusion?.kind === "resolve").length,
    snoozeCount: rows.filter((row) => String(readHistoryMetadata(row).disconnectTypeAtConclusion ?? "") === key && readHistoryMetadata(row).conclusion?.kind === "snooze").length,
    escalateCount: rows.filter((row) => String(readHistoryMetadata(row).disconnectTypeAtConclusion ?? "") === key && readHistoryMetadata(row).conclusion?.kind === "escalate").length,
  }));
}

function buildConclusionMixByActingUser(rows: DisconnectCaseHistoryRow[]) {
  return Array.from(new Set(rows.map((row) => row.actedBy))).map((actorUserId) => ({
    actorUserId,
    actorName: null,
    resolveCount: rows.filter((row) => row.actedBy === actorUserId && readHistoryMetadata(row).conclusion?.kind === "resolve").length,
    snoozeCount: rows.filter((row) => row.actedBy === actorUserId && readHistoryMetadata(row).conclusion?.kind === "snooze").length,
    escalateCount: rows.filter((row) => row.actedBy === actorUserId && readHistoryMetadata(row).conclusion?.kind === "escalate").length,
  }));
}

function buildConclusionMixByAssigneeAtConclusion(rows: DisconnectCaseHistoryRow[]) {
  return Array.from(new Set(rows.map((row) => String(readHistoryMetadata(row).assigneeAtConclusion ?? "")))).map((assigneeId) => ({
    assigneeId: assigneeId || null,
    assigneeName: null,
    resolveCount: rows.filter((row) => String(readHistoryMetadata(row).assigneeAtConclusion ?? "") === assigneeId && readHistoryMetadata(row).conclusion?.kind === "resolve").length,
    snoozeCount: rows.filter((row) => String(readHistoryMetadata(row).assigneeAtConclusion ?? "") === assigneeId && readHistoryMetadata(row).conclusion?.kind === "snooze").length,
    escalateCount: rows.filter((row) => String(readHistoryMetadata(row).assigneeAtConclusion ?? "") === assigneeId && readHistoryMetadata(row).conclusion?.kind === "escalate").length,
  }));
}

function buildMedianDaysToReopenTable(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[]
) {
  return ["resolve", "snooze", "escalate"].map((key) => ({
    key,
    medianDays: computeMedianDaysToLinkedReopen(concludedRows, history, key as "resolve" | "snooze" | "escalate"),
  }));
}

function computeMedianDaysToLinkedReopen(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  family: "resolve" | "snooze" | "escalate"
) {
  const reopenDurations = concludedRows
    .filter((row) => readHistoryMetadata(row).conclusion?.kind === family)
    .map((row) => {
      const reopen = history.find(
        (candidate) => candidate.actionType === "reopened" && readHistoryMetadata(candidate).priorConclusionActionId === row.id
      );
      if (!reopen) return null;
      return Math.floor(
        (new Date(String(reopen.actedAt)).getTime() - new Date(String(row.actedAt)).getTime()) /
          (1000 * 60 * 60 * 24)
      );
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (reopenDurations.length === 0) return null;
  return reopenDurations[Math.floor(reopenDurations.length / 2)] ?? null;
}

function buildInterventionOutcomeEffectiveness(history: DisconnectCaseHistoryRow[]): InterventionOutcomeEffectiveness {
  const concludedRows = history.filter((row) => readHistoryMetadata(row).conclusion);
  const reopenedByActionId = new Set(
    history
      .filter((row) => row.actionType === "reopened")
      .map((row) => String(readHistoryMetadata(row).priorConclusionActionId ?? ""))
      .filter(Boolean)
  );

  const reopenRateByConclusionFamily = buildGroupedRate(
    concludedRows,
    (row) => String(readHistoryMetadata(row).conclusion?.kind),
    reopenedByActionId
  );
  const reopenRateByResolveCategory = buildGroupedRateTable(
    concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "resolve"),
    (row) => String(readHistoryMetadata(row).conclusion?.outcomeCategory),
    reopenedByActionId
  );
  const reopenRateBySnoozeReason = buildGroupedRateTable(
    concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "snooze"),
    (row) => String(readHistoryMetadata(row).conclusion?.snoozeReasonCode),
    reopenedByActionId
  );
  const reopenRateByEscalationReason = buildGroupedRateTable(
    concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate"),
    (row) => String(readHistoryMetadata(row).conclusion?.escalationReasonCode),
    reopenedByActionId
  );
  const conclusionMixByDisconnectType = buildConclusionMixByDisconnectType(concludedRows);
  const conclusionMixByActingUser = buildConclusionMixByActingUser(concludedRows);
  const conclusionMixByAssigneeAtConclusion = buildConclusionMixByAssigneeAtConclusion(concludedRows);
  const medianDaysToReopenByConclusionFamily = buildMedianDaysToReopenTable(concludedRows, history);
  return {
    reopenRateByConclusionFamily,
    reopenRateByResolveCategory,
    reopenRateBySnoozeReason,
    reopenRateByEscalationReason,
    conclusionMixByDisconnectType,
    conclusionMixByActingUser,
    conclusionMixByAssigneeAtConclusion,
    medianDaysToReopenByConclusionFamily,
  };
}

const outcomeEffectiveness = buildInterventionOutcomeEffectiveness(history);

return {
  summary,
  outcomes,
  hotspots,
  breachQueue,
  slaRules,
  outcomeEffectiveness,
};
```

- [ ] **Step 4: Render the initial effectiveness summary on the analytics page**

```tsx
import { InterventionEffectivenessSummary } from "@/components/ai/intervention-effectiveness-summary";
import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";

<InterventionEffectivenessSummary
  reopenRateByConclusionFamily={dashboard.outcomeEffectiveness.reopenRateByConclusionFamily}
  reopenRateByResolveCategory={dashboard.outcomeEffectiveness.reopenRateByResolveCategory}
  reopenRateBySnoozeReason={dashboard.outcomeEffectiveness.reopenRateBySnoozeReason}
  reopenRateByEscalationReason={dashboard.outcomeEffectiveness.reopenRateByEscalationReason}
  conclusionMixByDisconnectType={dashboard.outcomeEffectiveness.conclusionMixByDisconnectType}
  conclusionMixByActingUser={dashboard.outcomeEffectiveness.conclusionMixByActingUser}
  conclusionMixByAssigneeAtConclusion={dashboard.outcomeEffectiveness.conclusionMixByAssigneeAtConclusion}
  medianDaysToReopenByConclusionFamily={dashboard.outcomeEffectiveness.medianDaysToReopenByConclusionFamily}
/>

// client/src/components/ai/intervention-effectiveness-summary.tsx
import type { InterventionOutcomeEffectiveness } from "@/hooks/use-ai-ops";

export function InterventionEffectivenessSummary(props: InterventionOutcomeEffectiveness) {
  return (
    <section>
      <h2>Resolution Effectiveness</h2>
      <div>Resolve reopen rate: {props.reopenRateByConclusionFamily.resolve ?? "n/a"}</div>
      <div>Snooze reopen rate: {props.reopenRateByConclusionFamily.snooze ?? "n/a"}</div>
      <div>Escalate reopen rate: {props.reopenRateByConclusionFamily.escalate ?? "n/a"}</div>
    </section>
  );
}
```

- [ ] **Step 5: Run focused analytics tests**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-service.test.ts client/src/hooks/use-ai-ops.test.ts client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/ai-copilot/intervention-service.ts server/src/modules/ai-copilot/intervention-types.ts server/tests/modules/ai-copilot/intervention-service.test.ts client/src/hooks/use-ai-ops.ts client/src/hooks/use-ai-ops.test.ts client/src/components/ai/intervention-effectiveness-summary.tsx client/src/pages/admin/admin-intervention-analytics-page.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx
git commit -m "feat: add intervention outcome effectiveness analytics"
```

### Task 7: Full Verification and Cleanup

**Files:**
- Verify: `server/src/modules/ai-copilot/intervention-service.ts`
- Verify: `server/src/modules/ai-copilot/routes.ts`
- Verify: `client/src/components/ai/intervention-batch-toolbar.tsx`
- Verify: `client/src/components/ai/intervention-detail-panel.tsx`
- Verify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`

- [ ] **Step 1: Run focused server tests**

Run: `npx vitest run server/tests/modules/ai-copilot/intervention-outcome-taxonomy.test.ts server/tests/modules/ai-copilot/intervention-service.test.ts server/tests/modules/ai-copilot/routes.test.ts`
Expected: PASS.

- [ ] **Step 2: Run focused client tests**

Run: `npx vitest run client/src/components/ai/intervention-conclusion-form.test.tsx client/src/hooks/use-admin-interventions.test.ts client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts`
Expected: PASS.

- [ ] **Step 3: Run workspace typecheck**

Run: `npm run typecheck`
Expected: PASS across shared/server/worker/client.

- [ ] **Step 4: Run diff hygiene**

Run: `git diff --check`
Expected: no output.

- [ ] **Step 5: Commit final cleanups if needed**

```bash
git add .
git commit -m "fix: polish intervention outcome capture integration"
```

---

## Self-Review

### Spec coverage

- structured required outcome capture for resolve/snooze/escalate: covered by Tasks 1, 2, 4, 5
- history-first canonical storage: covered by Tasks 2 and 3
- reopen event + analytics precision: covered by Task 3 and Task 6
- rollout/compatibility gate: covered by Task 4
- manager-facing effectiveness reporting: covered by Task 6
- homogeneous batch semantics: covered by Tasks 4 and 5

### Placeholder scan

- no `TODO`/`TBD`
- every task has explicit files, commands, and concrete snippets

### Type consistency

- conclusion shapes are introduced in Task 2 and reused in Tasks 4-6
- reopen event semantics are introduced in Task 3 and reused in Task 6
- taxonomy helper is introduced in Task 1 and reused in Tasks 2, 4, and 5
