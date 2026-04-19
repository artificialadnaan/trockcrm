# Intervention Case Copilot and Inference Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded, advisory-only Case Copilot inside the intervention detail sheet using intervention-scoped AI packets, normalized copilot view data, and safe heuristic fallback.

**Architecture:** Extend the existing AI copilot packet pipeline to support `scopeType = "intervention_case"` and `packetKind = "intervention_case"` while keeping the UI embedded inside `InterventionDetailPanel`. The server will expose intervention-scoped copilot endpoints under the existing `/ai/ops/interventions/:id` namespace, derive similar historical cases from intervention data, normalize packet content into a client-safe view model, and reuse the existing feedback path. The client will add an intervention-specific hook and one embedded panel component with refresh, feedback, and localized failure handling.

**Tech Stack:** Express, Drizzle, PostgreSQL tenant schema tables, existing AI copilot provider/fallback pipeline, React 19, React Router 7, Vitest, server-rendered component tests.

---

## File Structure

- Modify: `shared/src/schema/tenant/ai-copilot-packets.ts`
  - No structural schema change expected; confirm current columns are sufficient for `intervention_case`.
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
  - Add normalized intervention copilot view/result types.
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
  - Add similar-case derivation helpers, freshness timestamps, and packet invalidation hooks for intervention mutations.
- Modify: `server/src/modules/ai-copilot/service.ts`
  - Extend packet persistence / retrieval helpers if needed for intervention packet reuse.
- Modify: `server/src/modules/ai-copilot/prompt-contract.ts`
  - Add intervention-specific prompt input/output types alongside the existing deal contracts.
- Modify: `server/src/modules/ai-copilot/provider.ts`
  - Widen the provider interface to support intervention-scoped generation and reuse the heuristic provider path.
- Modify: `server/src/modules/ai-copilot/routes.ts`
  - Add `GET /ai/ops/interventions/:id/copilot` and `POST /ai/ops/interventions/:id/copilot/regenerate`.
- Create: `server/tests/modules/ai-copilot/intervention-case-copilot.test.ts`
  - Focused server tests for normalized copilot view generation and similar-case logic.
- Modify: `server/tests/modules/ai-copilot/routes.test.ts`
  - Route-level coverage for new copilot endpoints and access rules.
- Modify: `client/src/hooks/use-admin-interventions.ts`
  - Add `useInterventionCopilot(caseId)` hook and related client-side types.
- Create: `client/src/components/ai/intervention-case-copilot-panel.tsx`
  - Embedded advisory UI for the detail sheet.
- Create: `client/src/components/ai/intervention-case-copilot-panel.test.tsx`
  - Server-rendered component tests for loading/error/data states.
- Modify: `client/src/components/ai/intervention-detail-panel.tsx`
  - Insert copilot panel in the existing sheet and keep current direct actions unchanged.
- Create: `client/src/components/ai/intervention-detail-panel.test.tsx`
  - Verify the detail sheet still renders with copilot embedded and current direct actions still mount.

## Task 1: Add Failing Server Tests for Intervention Copilot View

**Files:**
- Create: `server/tests/modules/ai-copilot/intervention-case-copilot.test.ts`
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Reference: `server/src/modules/ai-copilot/intervention-service.ts`

- [ ] **Step 1: Write failing tests for normalized copilot view and similar-case ranking**

```ts
import { describe, expect, it } from "vitest";
import {
  buildInterventionCopilotView,
} from "../../../src/modules/ai-copilot/intervention-service";
import type { InterventionCaseDetail } from "../../../src/modules/ai-copilot/intervention-types";

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-default",
    officeId: "office-1",
    businessKey: "office-1:missing_next_task:deal:deal-1",
    scopeType: "deal",
    scopeId: "deal-1",
    dealId: "deal-1",
    companyId: "company-1",
    disconnectType: "missing_next_task",
    clusterKey: "follow_through_gap",
    severity: "high",
    status: "open",
    assignedTo: "user-1",
    generatedTaskId: null,
    escalated: false,
    snoozedUntil: null,
    reopenCount: 0,
    firstDetectedAt: new Date("2026-04-18T12:00:00.000Z"),
    lastDetectedAt: new Date("2026-04-19T12:00:00.000Z"),
    currentLifecycleStartedAt: new Date("2026-04-18T12:00:00.000Z"),
    lastReopenedAt: null,
    resolvedAt: null,
    resolutionReason: null,
    metadataJson: { stageKey: "estimating" },
    ...overrides,
  };
}

function makeHistory(overrides: Record<string, unknown> = {}) {
  return {
    id: "history-1",
    disconnectCaseId: "case-default",
    actionType: "resolve",
    actedBy: "user-1",
    actedAt: new Date("2026-04-19T12:00:00.000Z"),
    fromStatus: "open",
    toStatus: "resolved",
    fromAssignee: null,
    toAssignee: "user-1",
    fromSnoozedUntil: null,
    toSnoozedUntil: null,
    notes: null,
    metadataJson: null,
    ...overrides,
  };
}

function createTenantDb(state: Record<string, unknown>) {
  return { state } as any;
}

describe("buildInterventionCopilotView", () => {
  it("returns a normalized intervention copilot view with packet, freshness, and similar cases", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-current",
          officeId: "office-1",
          disconnectType: "missing_next_task",
          clusterKey: "follow_through_gap",
          severity: "high",
          assignedTo: "user-1",
        }),
        makeCase({
          id: "case-prior",
          officeId: "office-1",
          disconnectType: "missing_next_task",
          clusterKey: "follow_through_gap",
          severity: "high",
          status: "resolved",
        }),
      ],
      history: [
        makeHistory({
          disconnectCaseId: "case-prior",
          actionType: "resolve",
          metadataJson: {
            conclusion: { kind: "resolve", reasonCode: "follow_up_completed" },
          },
        }),
      ],
      packets: [
        {
          id: "packet-1",
          scopeType: "intervention_case",
          scopeId: "case-current",
          packetKind: "intervention_case",
          status: "ready",
          summaryText: "This case likely needs owner alignment before a resolve attempt.",
          confidence: "0.7800",
          generatedAt: new Date("2026-04-19T12:00:00.000Z"),
          nextStepJson: {
            action: "assign",
            rationale: "The generated task is unowned while the case is already high severity.",
            suggestedOwner: "Admin User",
            suggestedOwnerId: "user-1",
          },
          blindSpotsJson: [
            { flagType: "reopen_risk", severity: "medium", title: "Repeat-open pattern" },
          ],
          evidenceJson: [{ sourceType: "case_history", textSnippet: "resolved once, reopened later" }],
        },
      ],
      feedback: [],
    });

    const view = await buildInterventionCopilotView(tenantDb, {
      caseId: "case-current",
      officeId: "office-1",
      viewerUserId: "viewer-1",
    });

    expect(view.packet?.id).toBe("packet-1");
    expect(view.recommendedAction?.action).toBe("assign");
    expect(view.currentAssignee?.id).toBe("user-1");
    expect(view.similarCases).toHaveLength(1);
    expect(view.similarCases[0]?.caseId).toBe("case-prior");
    expect(view.similarCases[0]?.conclusionKind).toBe("resolve");
    expect(view.isStale).toBe(false);
  });

  it("excludes the current case and other-office cases from similar-case matches", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({ id: "case-current", officeId: "office-1", disconnectType: "missing_next_task" }),
        makeCase({ id: "case-other-office", officeId: "office-2", disconnectType: "missing_next_task", status: "resolved" }),
      ],
      history: [
        makeHistory({ disconnectCaseId: "case-other-office", actionType: "resolve" }),
      ],
    });

    const view = await buildInterventionCopilotView(tenantDb, {
      caseId: "case-current",
      officeId: "office-1",
      viewerUserId: "viewer-1",
    });

    expect(view.similarCases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the focused server test file to verify it fails**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-case-copilot.test.ts
```

Expected:

- FAIL because intervention copilot view generation does not exist yet

- [ ] **Step 3: Commit the failing server test scaffold**

```bash
git add server/tests/modules/ai-copilot/intervention-case-copilot.test.ts
git commit -m "test: add intervention case copilot server coverage"
```

## Task 2: Add Server Types and Deterministic Copilot View Builder

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Test: `server/tests/modules/ai-copilot/intervention-case-copilot.test.ts`

- [ ] **Step 1: Add normalized intervention copilot types**

Add types such as:

```ts
export interface InterventionCopilotRecommendedAction {
  action: "assign" | "resolve" | "snooze" | "escalate" | "investigate";
  rationale: string;
  suggestedOwner: string | null;
  suggestedOwnerId: string | null;
}

export interface InterventionCopilotSimilarCase {
  caseId: string;
  businessKey: string;
  disconnectType: string;
  clusterKey: string | null;
  assigneeAtConclusion: string | null;
  conclusionKind: "resolve" | "snooze" | "escalate";
  reasonCode: string | null;
  durableClose: boolean | null;
  reopened: boolean;
  daysToDurableClosure: number | null;
  queueLink: string;
}

export interface InterventionCopilotView {
  packet: {
    id: string;
    summaryText: string | null;
    confidence: number | null;
    generatedAt: string | null;
  } | null;
  recommendedAction: InterventionCopilotRecommendedAction | null;
  riskFlags: Array<{
    flagType: string;
    severity: string;
    title: string;
    details: string | null;
  }>;
  rootCause: { label: string; details: string | null } | null;
  blockerOwner: { label: string; details: string | null } | null;
  reopenRisk: { level: "low" | "medium" | "high"; rationale: string | null } | null;
  currentAssignee: { id: string | null; name: string | null };
  similarCases: InterventionCopilotSimilarCase[];
  isRefreshPending: boolean;
  isStale: boolean;
  latestCaseChangedAt: string | null;
  packetGeneratedAt: string | null;
  viewerFeedbackValue: string | null;
}
```

- [ ] **Step 2: Add pure helpers for freshness and similar-case ranking**

In `intervention-service.ts`, add helpers that:

- derive `latestCaseChangedAt`
- compute deterministic similar-case scoring
- exclude current case id
- restrict candidates to the same office
- only include concluded historical cases

Keep the scoring legible:

```ts
function scoreSimilarCase(input: {
  current: DisconnectCaseRow;
  candidate: DisconnectCaseRow;
  candidateStageKey: string | null;
  currentStageKey: string | null;
}) {
  let score = 0;
  if (candidate.disconnectType !== current.disconnectType) return Number.NEGATIVE_INFINITY;
  score += 100;
  if (candidate.clusterKey && candidate.clusterKey === current.clusterKey) score += 30;
  if (candidate.severity === current.severity) score += 10;
  if (candidateStageKey && currentStageKey && candidateStageKey === currentStageKey) score += 5;
  return score;
}
```

- [ ] **Step 3: Implement `buildInterventionCopilotView(...)`**

Add a server function like:

```ts
export async function buildInterventionCopilotView(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { caseId: string; officeId: string; viewerUserId: string }
): Promise<InterventionCopilotView> {
  // load current case
  // load latest ready intervention packet for scopeType/scopeId
  // load feedback latest opinion for viewer
  // derive similar historical cases
  // normalize recommendedAction / rootCause / blockerOwner / reopenRisk
  // compute isStale using latestCaseChangedAt vs packetGeneratedAt
}
```

For v1, normalize packet content defensively:

- if packet JSON is missing structured owner/root-cause/risk fields, derive reasonable fallback values from blind spots and next step data
- never throw because optional packet JSON fields are absent

- [ ] **Step 4: Run the focused server tests**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-case-copilot.test.ts
```

Expected:

- PASS

- [ ] **Step 5: Commit the server copilot view layer**

```bash
git add server/src/modules/ai-copilot/intervention-types.ts server/src/modules/ai-copilot/intervention-service.ts server/tests/modules/ai-copilot/intervention-case-copilot.test.ts
git commit -m "feat: add intervention case copilot view builder"
```

## Task 3: Add Intervention Packet Generation and Invalidation Hooks

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Modify: `server/src/modules/ai-copilot/prompt-contract.ts`
- Modify: `server/src/modules/ai-copilot/provider.ts`
- Modify: `server/src/modules/ai-copilot/service.ts`
- Test: `server/tests/modules/ai-copilot/intervention-case-copilot.test.ts`

- [ ] **Step 1: Add intervention-specific prompt input/output types and provider contract**

Extend `prompt-contract.ts` with intervention-scoped input/output contracts and widen `AiCopilotProvider` in `provider.ts` to expose an intervention generator:

```ts
export interface InterventionCopilotPromptInput {
  context: {
    caseId: string;
    disconnectType: string;
    severity: string;
    status: string;
    assignedToName: string | null;
    generatedTaskStatus: string | null;
    reopenCount: number;
  };
  signals: {
    rootCauseHints: string[];
    riskHints: string[];
    similarCaseSummaries: Array<{ label: string; outcome: string }>;
  };
  evidence: Array<Record<string, unknown>>;
}

export interface InterventionCopilotPromptOutput {
  summary: string;
  recommendedAction: {
    action: "assign" | "resolve" | "snooze" | "escalate" | "investigate";
    rationale: string;
    suggestedOwner: string | null;
    suggestedOwnerId: string | null;
  };
  rootCause: { label: string; details: string | null } | null;
  blockerOwner: { label: string; details: string | null } | null;
  reopenRisk: { level: "low" | "medium" | "high"; rationale: string | null } | null;
  blindSpotFlags: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  confidence: number;
}
```

Use the same provider abstraction and heuristic fallback rather than creating a second AI stack.

- [ ] **Step 2: Implement intervention packet generation**

Add a function like:

```ts
export async function regenerateInterventionCopilot(
  tenantDb: TenantDb,
  input: { caseId: string; officeId: string; requestedBy: string }
) {
  // load case + detail context
  // derive similar-case summaries
  // build provider input
  // call provider.generateInterventionCopilotPacket or normalized generic generator
  // persist ai_copilot_packets / ai_risk_flags for scopeType=intervention_case
}
```

Keep v1 task suggestion writes disabled for intervention scope. Persist only:

- packet
- normalized `nextStepJson`
- normalized `blindSpotsJson`
- evidence

- [ ] **Step 3: Add deterministic packet invalidation hooks**

On successful intervention changes and relevant backend changes, mark the latest intervention packet stale by comparing `packetGeneratedAt` with `latestCaseChangedAt`.

Implementation can stay derived rather than writing a `stale` column:

- update freshness sources when assign/snooze/resolve/escalate happen
- include reopen/materialization and generated-task linkage/status in the derived freshness timestamp

- [ ] **Step 4: Add/extend server tests for freshness and heuristic fallback**

Add assertions that:

- heuristic fallback returns a usable packet view without external provider keys
- `isStale` becomes true after a mutation that postdates the packet
- `viewerFeedbackValue` reflects the latest user opinion

- [ ] **Step 5: Run the server copilot test suite**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-case-copilot.test.ts server/tests/modules/ai-copilot/routes.test.ts
```

Expected:

- PASS

- [ ] **Step 6: Commit packet generation and invalidation**

```bash
git add server/src/modules/ai-copilot/intervention-service.ts server/src/modules/ai-copilot/prompt-contract.ts server/src/modules/ai-copilot/provider.ts server/src/modules/ai-copilot/service.ts server/tests/modules/ai-copilot/intervention-case-copilot.test.ts server/tests/modules/ai-copilot/routes.test.ts
git commit -m "feat: add intervention copilot packet generation"
```

## Task 4: Add Intervention Copilot API Routes

**Files:**
- Modify: `server/src/modules/ai-copilot/routes.ts`
- Test: `server/tests/modules/ai-copilot/routes.test.ts`

- [ ] **Step 1: Write/extend failing route tests**

Add route tests that verify:

- `admin` and `director` can read intervention copilot
- unauthorized roles are rejected
- `GET /ai/ops/interventions/:id/copilot` returns normalized fields
- `POST /ai/ops/interventions/:id/copilot/regenerate` returns queued/refresh state

Expected response shape to lock in:

```ts
expect(body).toMatchObject({
  packet: expect.anything(),
  recommendedAction: {
    action: expect.any(String),
    rationale: expect.any(String),
    suggestedOwner: expect.anything(),
    suggestedOwnerId: expect.anything(),
  },
  currentAssignee: expect.anything(),
  similarCases: expect.any(Array),
  isRefreshPending: expect.any(Boolean),
  isStale: expect.any(Boolean),
  latestCaseChangedAt: expect.anything(),
  packetGeneratedAt: expect.anything(),
      viewerFeedbackValue: expect.toSatisfy((value) => value === null || typeof value === "string"),
});
```

Use a standard matcher in the route test and assert the nullable string separately after parsing the body:

```ts
expect(body).toMatchObject({
  packet: expect.anything(),
  recommendedAction: expect.anything(),
  currentAssignee: expect.anything(),
});
expect(body.viewerFeedbackValue === null || typeof body.viewerFeedbackValue === "string").toBe(true);
```

- [ ] **Step 2: Implement the routes**

Add routes in `routes.ts`:

```ts
router.get("/ops/interventions/:id/copilot", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const view = await buildInterventionCopilotView(req.tenantDb!, {
      caseId: req.params.id,
      officeId: getActiveOfficeId(req),
      viewerUserId: req.user!.id,
    });
    await req.commitTransaction!();
    res.json(view);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/:id/copilot/regenerate", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const result = await regenerateInterventionCopilot(req.tenantDb!, {
      caseId: req.params.id,
      officeId: getActiveOfficeId(req),
      requestedBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(result.queued ? 202 : 200).json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Run route tests**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/routes.test.ts
```

Expected:

- PASS

- [ ] **Step 4: Commit the route layer**

```bash
git add server/src/modules/ai-copilot/routes.ts server/tests/modules/ai-copilot/routes.test.ts
git commit -m "feat: add intervention copilot routes"
```

## Task 5: Add Client Hook and Embedded Copilot Panel

**Files:**
- Modify: `client/src/hooks/use-admin-interventions.ts`
- Create: `client/src/components/ai/intervention-case-copilot-panel.tsx`
- Create: `client/src/components/ai/intervention-case-copilot-panel.test.tsx`
- Modify: `client/src/components/ai/intervention-detail-panel.tsx`
- Create: `client/src/hooks/use-admin-interventions.test.ts`

- [ ] **Step 1: Write failing client tests for panel states**

Create server-rendered tests that lock in:

- loading state
- localized error state
- populated state with:
  - brief
  - confidence
  - recommended action with suggested owner
  - similar cases
  - feedback buttons
- stale badge / refresh-pending badge rendering

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InterventionCaseCopilotPanel } from "./intervention-case-copilot-panel";

describe("InterventionCaseCopilotPanel", () => {
  it("renders a populated copilot view", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionCaseCopilotPanel
          data={{
            packet: { id: "packet-1", summaryText: "Likely owner mismatch.", confidence: 0.78, generatedAt: "2026-04-19T12:00:00.000Z" },
            recommendedAction: { action: "assign", rationale: "Task owner is missing.", suggestedOwner: "Admin User", suggestedOwnerId: "user-1" },
            currentAssignee: { id: "user-2", name: "Director User" },
            riskFlags: [],
            rootCause: { label: "Owner mismatch", details: "The generated task has no durable owner." },
            blockerOwner: { label: "Admin follow-up", details: "Admin ownership is more durable in similar cases." },
            reopenRisk: { level: "medium", rationale: "Similar cases reopened after weak snoozes." },
            similarCases: [],
            isRefreshPending: false,
            isStale: false,
            latestCaseChangedAt: "2026-04-19T12:00:00.000Z",
            packetGeneratedAt: "2026-04-19T12:00:00.000Z",
            viewerFeedbackValue: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Case Copilot");
    expect(html).toContain("Likely owner mismatch.");
    expect(html).toContain("assign");
    expect(html).toContain("Admin User");
  });

  it("renders loading, localized error, and stale/pending badges", () => {
    const loading = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionCaseCopilotPanel loading />
      </MemoryRouter>,
    );
    const errored = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionCaseCopilotPanel error="Failed to load copilot" />
      </MemoryRouter>,
    );
    const stale = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionCaseCopilotPanel
          data={{
            packet: null,
            recommendedAction: null,
            currentAssignee: { id: null, name: null },
            riskFlags: [],
            rootCause: null,
            blockerOwner: null,
            reopenRisk: null,
            similarCases: [],
            isRefreshPending: true,
            isStale: true,
            latestCaseChangedAt: "2026-04-19T12:05:00.000Z",
            packetGeneratedAt: "2026-04-19T12:00:00.000Z",
            viewerFeedbackValue: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(loading).toContain("Case Copilot");
    expect(errored).toContain("Failed to load copilot");
    expect(stale).toContain("Refresh queued");
  });
});
```

- [ ] **Step 2: Add focused hook tests for polling and action wiring**

Create `client/src/hooks/use-admin-interventions.test.ts` alongside the existing hook tests and follow the current no-DOM pattern used in `use-ai-ops.test.ts`:

- mock `react` state/effect primitives
- mock `@/lib/api`
- verify the hook:
  - fetches `/ai/ops/interventions/:id/copilot`
  - polls every 5 seconds while `refreshQueuedAt` is newer than `packetGeneratedAt`
  - clears pending once a refreshed packet arrives
  - posts regenerate to `/ai/ops/interventions/:id/copilot/regenerate`
  - posts feedback through the existing packet feedback route

This keeps the hook behavior covered without requiring a `jsdom` client test environment.

- [ ] **Step 3: Add `useInterventionCopilot(caseId)`**

In `use-admin-interventions.ts`, add:

- intervention copilot view types
- fetch hook
- regenerate action
- feedback submit action
- 5-second polling while `refreshQueuedAt` is set
- clear pending when `packetGeneratedAt >= refreshQueuedAt`

- [ ] **Step 4: Build the embedded panel component**

`intervention-case-copilot-panel.tsx` should render:

- header with confidence/timestamp/refresh
- localized stale badge
- brief
- recommended action card
- risk + root-cause section
- similar historical cases
- evidence list
- useful / not useful feedback buttons

Keep it visually consistent with the existing detail sheet cards. No new tabs.

- [ ] **Step 5: Insert the panel into `InterventionDetailPanel`**

Keep the ownership split explicit:

- `useInterventionCopilot(caseId)` stays in `InterventionDetailPanel`
- `InterventionCaseCopilotPanel` stays presentational and receives `data`, `loading`, `error`, `onRefresh`, and `onFeedback`
- the detail sheet remains responsible for localized retry/feedback wiring

Place the copilot block:

- after the case summary card
- before the generated task card

The detail sheet must keep working if the copilot fails or loads slowly.

- [ ] **Step 6: Add a focused detail-panel server-render test**

Create `client/src/components/ai/intervention-detail-panel.test.tsx` to verify:

- the detail sheet still renders current direct-action sections
- the copilot section mounts in the sheet body
- localized copilot errors do not suppress the rest of the detail content

Keep this test server-rendered with `renderToStaticMarkup` like the panel tests. Do not require a DOM test environment for this slice.

- [ ] **Step 7: Run focused client tests**

Run:

```bash
npx vitest run client/src/hooks/use-admin-interventions.test.ts client/src/components/ai/intervention-case-copilot-panel.test.tsx client/src/components/ai/intervention-detail-panel.test.tsx --config client/vite.config.ts
```

Expected:

- PASS

- [ ] **Step 8: Commit the client copilot UI**

```bash
git add client/src/hooks/use-admin-interventions.ts client/src/hooks/use-admin-interventions.test.ts client/src/components/ai/intervention-case-copilot-panel.tsx client/src/components/ai/intervention-case-copilot-panel.test.tsx client/src/components/ai/intervention-detail-panel.tsx client/src/components/ai/intervention-detail-panel.test.tsx
git commit -m "feat: add intervention case copilot panel"
```

## Task 6: Full Verification and Deployment Ralph Loop

**Files:**
- No code changes unless issues surface

- [ ] **Step 1: Run local verification before push**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-case-copilot.test.ts server/tests/modules/ai-copilot/routes.test.ts
npx vitest run client/src/hooks/use-admin-interventions.test.ts client/src/components/ai/intervention-case-copilot-panel.test.tsx client/src/components/ai/intervention-detail-panel.test.tsx --config client/vite.config.ts
npm run typecheck
git diff --check
```

Expected:

- all pass

- [ ] **Step 2: Push, review, merge, and redeploy**

```bash
git push -u origin feat/intervention-case-copilot
```

- [ ] **Step 3: Run production Playwright Ralph loop after Railway is green**

Validate:

- no new sidebar entry or menu tab appears
- `/admin/interventions` still loads
- opening a case detail sheet shows `Case Copilot`
- copilot loading/error states stay localized
- brief / recommended action / similar cases render
- refresh works
- feedback works
- direct actions still work after copilot is present

- [ ] **Step 4: If production issues surface, fix and repeat until clean**

After each fix, rerun:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-case-copilot.test.ts server/tests/modules/ai-copilot/routes.test.ts
npx vitest run client/src/hooks/use-admin-interventions.test.ts client/src/components/ai/intervention-case-copilot-panel.test.tsx client/src/components/ai/intervention-detail-panel.test.tsx --config client/vite.config.ts
npm run typecheck
git diff --check
```

- [ ] **Step 5: Record final production-tested behaviors**

Include:

- exact routes tested
- what the copilot rendered
- whether refresh/feedback/direct actions worked
- any bugs found and fixed during the Ralph loop
