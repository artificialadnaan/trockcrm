# Estimator Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the estimating shell into an interactive estimator workbench with reviewable documents, extraction rows, catalog matches, pricing recommendations, review-event logging, and promotion readiness inside the existing estimating tab.

**Architecture:** Extend the current estimating workflow rather than introducing a second estimate editor. The backend adds explicit mutation services and routes for workbench actions, plus richer workflow-state payloads and review-event logging. The frontend replaces the current shell placeholders with a split-pane workbench that reads workflow state, allows targeted row edits and approvals, and refreshes from the canonical estimating APIs.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, Vitest

---

## File Structure

- Modify: `server/src/modules/deals/routes.ts`
  Responsibility: add the workbench mutation routes and extend workflow-state responses.
- Create: `server/src/modules/estimating/workbench-service.ts`
  Responsibility: centralize workflow-state shaping, summary counts, and promotion readiness for the workbench.
- Create: `server/src/modules/estimating/extraction-review-service.ts`
  Responsibility: update, approve, and reject extraction rows with review-event logging.
- Create: `server/src/modules/estimating/match-review-service.ts`
  Responsibility: select and reject catalog matches while maintaining current/selected match semantics and review events.
- Create: `server/src/modules/estimating/pricing-review-service.ts`
  Responsibility: approve, reject, and override pricing recommendations while returning eligible promotion state.
- Modify: `server/src/modules/estimating/document-service.ts`
  Responsibility: add document reprocess support and lifecycle reset behavior for the workbench.
- Modify: `server/src/modules/estimating/copilot-service.ts`
  Responsibility: delegate workflow-state shaping to the workbench service instead of returning raw arrays.
- Create: `server/tests/modules/estimating/workbench-service.test.ts`
  Responsibility: verify workflow-state summaries, selected/current markers, and promotion readiness.
- Create: `server/tests/modules/estimating/extraction-review-service.test.ts`
  Responsibility: verify extraction update/approve/reject transitions and review-event logging.
- Create: `server/tests/modules/estimating/match-review-service.test.ts`
  Responsibility: verify match selection/rejection semantics and current-row updates.
- Create: `server/tests/modules/estimating/pricing-review-service.test.ts`
  Responsibility: verify approve/reject/override transitions and override reason handling.
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
  Responsibility: cover the new workbench routes and summary payload contract.
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
  Responsibility: replace the placeholder stacked shell with the split-pane workbench container.
- Create: `client/src/components/estimating/estimate-workbench-summary-strip.tsx`
  Responsibility: render queue counts and promotion readiness.
- Create: `client/src/components/estimating/estimate-workbench-sidebar.tsx`
  Responsibility: render section switching for Documents, Extractions, Matches, Pricing, and Review Log.
- Create: `client/src/components/estimating/estimate-workbench-detail-pane.tsx`
  Responsibility: render either summary guidance or row-specific evidence and actions.
- Modify: `client/src/components/estimating/estimate-documents-panel.tsx`
  Responsibility: make documents interactive with reprocess actions and status display.
- Modify: `client/src/components/estimating/estimate-extraction-review-table.tsx`
  Responsibility: support row selection, inline edits, approve/reject actions, and refresh callbacks.
- Modify: `client/src/components/estimating/estimate-catalog-match-table.tsx`
  Responsibility: support row selection, current-match display, remap selection, and reject actions.
- Modify: `client/src/components/estimating/estimate-pricing-review-table.tsx`
  Responsibility: support row selection, approve/reject/override actions, and promotion eligibility display.
- Modify: `client/src/components/estimating/estimate-review-log-panel.tsx`
  Responsibility: render the real review log instead of a placeholder count.
- Modify: `client/src/pages/deals/deal-estimates-tab.tsx`
  Responsibility: manage workflow-state fetch/refresh and feed the workbench real callbacks and data.
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: verify the workbench shell, section switching, and detail-pane behavior.
- Create: `client/src/components/estimating/estimate-extraction-review-table.test.tsx`
  Responsibility: verify extraction table row selection and action affordances.
- Create: `client/src/components/estimating/estimate-pricing-review-table.test.tsx`
  Responsibility: verify pricing row actions and override UI affordances.

## Task 1: Build Workbench State and Route Contracts

**Files:**
- Create: `server/src/modules/estimating/workbench-service.ts`
- Modify: `server/src/modules/estimating/copilot-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Create: `server/tests/modules/estimating/workbench-service.test.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`

- [ ] **Step 1: Write the failing workbench-state service test**

```ts
import { describe, expect, it, vi } from "vitest";
import { buildEstimatingWorkbenchState } from "../../../src/modules/estimating/workbench-service.js";

describe("buildEstimatingWorkbenchState", () => {
  it("returns summary counts and promotion readiness from workflow rows", async () => {
    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([{ id: "doc-1", ocrStatus: "completed" }]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                { id: "ext-1", status: "approved" },
                { id: "ext-2", status: "pending" },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([
                  { id: "match-1", extractionId: "ext-1", status: "selected" },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                { id: "price-1", status: "approved", createdByRunId: "run-1" },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([{ id: "evt-1", eventType: "approved" }]),
            })),
          })),
        }),
    } as any;

    const result = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(result.summary.documents.total).toBe(1);
    expect(result.summary.extractions.pending).toBe(1);
    expect(result.summary.pricing.readyToPromote).toBe(1);
    expect(result.promotionReadiness.canPromote).toBe(true);
    expect(result.promotionReadiness.generationRunIds).toEqual(["run-1"]);
  });
});
```

- [ ] **Step 2: Run the focused workbench-state test to verify it fails**

Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts`

Expected: FAIL because `buildEstimatingWorkbenchState` does not exist yet.

- [ ] **Step 3: Implement the workbench-state service**

```ts
import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

function countByStatus<T extends { status?: string | null }>(rows: T[]) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.status ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export async function buildEstimatingWorkbenchState(tenantDb: TenantDb, dealId: string) {
  const [documents, extractionRows, matchRows, pricingRows, reviewEvents] = await Promise.all([
    tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.dealId, dealId))
      .orderBy(desc(estimateSourceDocuments.createdAt)),
    tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.dealId, dealId))
      .orderBy(desc(estimateExtractions.createdAt)),
    tenantDb
      .select({
        id: estimateExtractionMatches.id,
        extractionId: estimateExtractionMatches.extractionId,
        catalogItemId: estimateExtractionMatches.catalogItemId,
        catalogCodeId: estimateExtractionMatches.catalogCodeId,
        historicalLineItemId: estimateExtractionMatches.historicalLineItemId,
        matchType: estimateExtractionMatches.matchType,
        matchScore: estimateExtractionMatches.matchScore,
        status: estimateExtractionMatches.status,
        reasonJson: estimateExtractionMatches.reasonJson,
        evidenceJson: estimateExtractionMatches.evidenceJson,
        createdAt: estimateExtractionMatches.createdAt,
      })
      .from(estimateExtractionMatches)
      .innerJoin(
        estimateExtractions,
        eq(estimateExtractionMatches.extractionId, estimateExtractions.id)
      )
      .where(eq(estimateExtractions.dealId, dealId))
      .orderBy(desc(estimateExtractionMatches.createdAt)),
    tenantDb
      .select()
      .from(estimatePricingRecommendations)
      .where(eq(estimatePricingRecommendations.dealId, dealId))
      .orderBy(desc(estimatePricingRecommendations.createdAt)),
    tenantDb
      .select()
      .from(estimateReviewEvents)
      .where(eq(estimateReviewEvents.dealId, dealId))
      .orderBy(desc(estimateReviewEvents.createdAt)),
  ]);

  const extractionCounts = countByStatus(extractionRows);
  const matchCounts = countByStatus(matchRows);
  const pricingCounts = countByStatus(pricingRows);
  const promotableRows = pricingRows.filter((row) => ["approved", "overridden"].includes(row.status));
  const generationRunIds = Array.from(
    new Set(promotableRows.map((row) => row.createdByRunId).filter(Boolean))
  );

  return {
    documents,
    extractionRows,
    matchRows,
    pricingRows,
    reviewEvents,
    summary: {
      documents: {
        total: documents.length,
        queued: documents.filter((row) => row.ocrStatus === "queued").length,
        failed: documents.filter((row) => row.ocrStatus === "failed").length,
      },
      extractions: {
        total: extractionRows.length,
        pending: extractionCounts.pending ?? 0,
        approved: extractionCounts.approved ?? 0,
        rejected: extractionCounts.rejected ?? 0,
        unmatched: extractionCounts.unmatched ?? 0,
      },
      matches: {
        total: matchRows.length,
        suggested: matchCounts.suggested ?? 0,
        selected: matchCounts.selected ?? 0,
        rejected: matchCounts.rejected ?? 0,
      },
      pricing: {
        total: pricingRows.length,
        pending: pricingCounts.pending ?? 0,
        approved: pricingCounts.approved ?? 0,
        overridden: pricingCounts.overridden ?? 0,
        rejected: pricingCounts.rejected ?? 0,
        readyToPromote: promotableRows.length,
      },
    },
    promotionReadiness: {
      canPromote: promotableRows.length > 0 && generationRunIds.length > 0,
      generationRunIds,
    },
  };
}
```

- [ ] **Step 4: Wire the route and copilot workflow state call sites to the new service**

```ts
import { buildEstimatingWorkbenchState } from "./workbench-service.js";

export async function getEstimatingWorkflowState(tenantDb: TenantDb, dealId: string) {
  return buildEstimatingWorkbenchState(tenantDb, dealId);
}
```

Keep `server/src/modules/deals/routes.ts` on the existing `getEstimatingWorkflowState(...)` call path so the route test can continue mocking the estimating service boundary instead of a new direct import.

- [ ] **Step 5: Extend the workflow route test for summary payload**

```ts
it("returns workbench summary counts and promotion readiness", async () => {
  estimatingServiceMocks.getEstimatingWorkflowState.mockResolvedValue({
    documents: [],
    extractionRows: [],
    matchRows: [],
    pricingRows: [],
    reviewEvents: [],
    summary: {
      documents: { total: 0, queued: 0, failed: 0 },
      extractions: { total: 0, pending: 0, approved: 0, rejected: 0, unmatched: 0 },
      matches: { total: 0, suggested: 0, selected: 0, rejected: 0 },
      pricing: { total: 0, pending: 0, approved: 0, overridden: 0, rejected: 0, readyToPromote: 0 },
    },
    promotionReadiness: {
      canPromote: false,
      generationRunIds: [],
    },
  });

  const { res } = await invokeRoute("get", "/:id/estimating", {
    params: { id: "deal-1" },
  });

  expect(res.body.summary.pricing.readyToPromote).toBe(0);
  expect(res.body.promotionReadiness.canPromote).toBe(false);
});
```

- [ ] **Step 6: Run the focused workbench-state tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/workflow-state-routes.test.ts`

Expected: PASS with the workbench-state service and route summary assertions green.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/estimating/workbench-service.ts \
  server/src/modules/estimating/copilot-service.ts \
  server/src/modules/deals/routes.ts \
  server/tests/modules/estimating/workbench-service.test.ts \
  server/tests/modules/estimating/workflow-state-routes.test.ts
git commit -m "feat: add estimating workbench state"
```

## Task 2: Add Extraction Review Actions

**Files:**
- Create: `server/src/modules/estimating/extraction-review-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Create: `server/tests/modules/estimating/extraction-review-service.test.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`

- [ ] **Step 1: Write the failing extraction-review service test**

```ts
import { describe, expect, it, vi } from "vitest";
import { approveEstimateExtraction } from "../../../src/modules/estimating/extraction-review-service.js";

describe("approveEstimateExtraction", () => {
  it("marks the extraction approved and writes a review event", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "ext-1", status: "approved" }]);
    const values = vi.fn().mockResolvedValue(undefined);
    const tenantDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
      insert: vi.fn(() => ({ values })),
    } as any;

    const result = await approveEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-1",
      userId: "user-1",
    });

    expect(result.extraction.status).toBe("approved");
    expect(values).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the focused extraction-review test to verify it fails**

Run: `npx vitest run tests/modules/estimating/extraction-review-service.test.ts`

Expected: FAIL because `approveEstimateExtraction` does not exist yet.

- [ ] **Step 3: Implement extraction update, approve, and reject actions**

```ts
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimateExtractions, estimateReviewEvents } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

async function insertReviewEvent(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    subjectId: string;
    eventType: string;
    userId: string;
    beforeJson?: Record<string, unknown>;
    afterJson?: Record<string, unknown>;
    reason?: string | null;
  }
) {
  const [event] = await tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: input.dealId,
      subjectType: "estimate_extraction",
      subjectId: input.subjectId,
      eventType: input.eventType,
      userId: input.userId,
      beforeJson: input.beforeJson ?? {},
      afterJson: input.afterJson ?? {},
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

export async function approveEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
}) {
  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      status: "approved",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "approved",
    userId: args.userId,
    afterJson: { status: "approved" },
  });

  return { extraction: updated, reviewEvent };
}

export async function rejectEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  reason?: string | null;
}) {
  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      status: "rejected",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "rejected",
    userId: args.userId,
    afterJson: { status: "rejected" },
    reason: args.reason ?? null,
  });

  return { extraction: updated, reviewEvent };
}

export async function updateEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  input: {
    normalizedLabel?: string;
    quantity?: string | null;
    unit?: string | null;
    divisionHint?: string | null;
  };
}) {
  const [existing] = await args.tenantDb
    .select()
    .from(estimateExtractions)
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      normalizedLabel: args.input.normalizedLabel ?? existing.normalizedLabel,
      quantity: args.input.quantity ?? existing.quantity,
      unit: args.input.unit ?? existing.unit,
      divisionHint: args.input.divisionHint ?? existing.divisionHint,
      updatedAt: new Date(),
    })
    .where(eq(estimateExtractions.id, args.extractionId))
    .returning();

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "edited",
    userId: args.userId,
    beforeJson: {
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
  });

  return { extraction: updated, reviewEvent };
}
```

- [ ] **Step 4: Add the extraction mutation routes**

```ts
import {
  approveEstimateExtraction,
  rejectEstimateExtraction,
  updateEstimateExtraction,
} from "../estimating/extraction-review-service.js";

router.patch("/:id/estimating/extractions/:extractionId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await updateEstimateExtraction({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      extractionId: req.params.extractionId,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/extractions/:extractionId/approve", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await approveEstimateExtraction({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      extractionId: req.params.extractionId,
      userId: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/extractions/:extractionId/reject", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await rejectEstimateExtraction({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      extractionId: req.params.extractionId,
      userId: req.user!.id,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Add route coverage for the extraction actions**

```ts
const extractionReviewMocks = vi.hoisted(() => ({
  updateEstimateExtraction: vi.fn(),
  approveEstimateExtraction: vi.fn(),
  rejectEstimateExtraction: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/extraction-review-service.js", () => extractionReviewMocks);

it("approves an extraction row for the workbench", async () => {
  extractionReviewMocks.approveEstimateExtraction.mockResolvedValue({
    extraction: { id: "ext-1", status: "approved" },
    reviewEvent: { id: "evt-1", eventType: "approved" },
  });

  const { res } = await invokeRoute("post", "/:id/estimating/extractions/:extractionId/approve", {
    params: { id: "deal-1", extractionId: "ext-1" },
  });

  expect(res.statusCode).toBe(200);
  expect(res.body.extraction.status).toBe("approved");
});
```

- [ ] **Step 6: Run the extraction review tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/extraction-review-service.test.ts tests/modules/estimating/workflow-state-routes.test.ts`

Expected: PASS with extraction update/approve/reject coverage green.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/estimating/extraction-review-service.ts \
  server/src/modules/deals/routes.ts \
  server/tests/modules/estimating/extraction-review-service.test.ts \
  server/tests/modules/estimating/workflow-state-routes.test.ts
git commit -m "feat: add extraction review actions"
```

## Task 3: Add Match Review and Pricing Review Actions

**Files:**
- Create: `server/src/modules/estimating/match-review-service.ts`
- Create: `server/src/modules/estimating/pricing-review-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Create: `server/tests/modules/estimating/match-review-service.test.ts`
- Create: `server/tests/modules/estimating/pricing-review-service.test.ts`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`

- [ ] **Step 1: Write the failing match-selection test**

```ts
import { describe, expect, it, vi } from "vitest";
import { selectEstimateExtractionMatch } from "../../../src/modules/estimating/match-review-service.js";

describe("selectEstimateExtractionMatch", () => {
  it("marks the chosen match selected and demotes sibling suggestions", async () => {
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ id: "match-1", extractionId: "ext-1", status: "suggested" }]),
          })),
        })),
      })),
      update: vi
        .fn()
        .mockReturnValueOnce({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(undefined),
          })),
        })
        .mockReturnValueOnce({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "match-1", status: "selected" }]),
            })),
          })),
        }),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
    } as any;

    const result = await selectEstimateExtractionMatch({
      tenantDb,
      dealId: "deal-1",
      matchId: "match-1",
      userId: "user-1",
    });

    expect(result.match.status).toBe("selected");
  });
});
```

- [ ] **Step 2: Run the focused match/pricing tests to verify they fail**

Run: `npx vitest run tests/modules/estimating/match-review-service.test.ts tests/modules/estimating/pricing-review-service.test.ts`

Expected: FAIL because the match and pricing review services do not exist yet.

- [ ] **Step 3: Implement the match review service**

```ts
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimateExtractionMatches, estimateExtractions, estimateReviewEvents } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

async function insertMatchReviewEvent(
  tenantDb: TenantDb,
  input: { dealId: string; matchId: string; userId: string; eventType: string; reason?: string | null }
) {
  const [event] = await tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: input.dealId,
      subjectType: "estimate_extraction_match",
      subjectId: input.matchId,
      eventType: input.eventType,
      userId: input.userId,
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

export async function selectEstimateExtractionMatch(args: {
  tenantDb: TenantDb;
  dealId: string;
  matchId: string;
  userId: string;
}) {
  const [match] = await args.tenantDb
    .select({
      id: estimateExtractionMatches.id,
      extractionId: estimateExtractionMatches.extractionId,
      status: estimateExtractionMatches.status,
      dealId: estimateExtractions.dealId,
    })
    .from(estimateExtractionMatches)
    .innerJoin(estimateExtractions, eq(estimateExtractionMatches.extractionId, estimateExtractions.id))
    .where(
      and(
        eq(estimateExtractionMatches.id, args.matchId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .limit(1);

  if (!match) {
    throw new AppError(404, "Estimate extraction match not found");
  }

  await args.tenantDb
    .update(estimateExtractionMatches)
    .set({ status: "suggested" })
    .where(eq(estimateExtractionMatches.extractionId, match.extractionId));

  const [updated] = await args.tenantDb
    .update(estimateExtractionMatches)
    .set({ status: "selected" })
    .where(eq(estimateExtractionMatches.id, args.matchId))
    .returning();

  const reviewEvent = await insertMatchReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    matchId: args.matchId,
    userId: args.userId,
    eventType: "selected",
  });

  return { match: updated, reviewEvent };
}

export async function rejectEstimateExtractionMatch(args: {
  tenantDb: TenantDb;
  dealId: string;
  matchId: string;
  userId: string;
  reason?: string | null;
}) {
  const [updated] = await args.tenantDb
    .update(estimateExtractionMatches)
    .set({ status: "rejected" })
    .where(eq(estimateExtractionMatches.id, args.matchId))
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction match not found");
  }

  const reviewEvent = await insertMatchReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    matchId: args.matchId,
    userId: args.userId,
    eventType: "rejected",
    reason: args.reason ?? null,
  });

  return { match: updated, reviewEvent };
}
```

- [ ] **Step 4: Implement the pricing review service**

```ts
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimatePricingRecommendations, estimateReviewEvents } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

async function insertPricingReviewEvent(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    recommendationId: string;
    userId: string;
    eventType: string;
    beforeJson?: Record<string, unknown>;
    afterJson?: Record<string, unknown>;
    reason?: string | null;
  }
) {
  const [event] = await tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: input.dealId,
      subjectType: "estimate_pricing_recommendation",
      subjectId: input.recommendationId,
      eventType: input.eventType,
      userId: input.userId,
      beforeJson: input.beforeJson ?? {},
      afterJson: input.afterJson ?? {},
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

export async function approveEstimatePricingRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
}) {
  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      status: "approved",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const reviewEvent = await insertPricingReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    recommendationId: args.recommendationId,
    userId: args.userId,
    eventType: "approved",
    afterJson: { status: "approved" },
  });

  return { recommendation: updated, reviewEvent };
}

export async function rejectEstimatePricingRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  reason?: string | null;
}) {
  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      status: "rejected",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const reviewEvent = await insertPricingReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    recommendationId: args.recommendationId,
    userId: args.userId,
    eventType: "rejected",
    afterJson: { status: "rejected" },
    reason: args.reason ?? null,
  });

  return { recommendation: updated, reviewEvent };
}

export async function overrideEstimatePricingRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  input: {
    recommendedUnitPrice: string;
    recommendedTotalPrice: string;
    reason: string;
  };
}) {
  if (!args.input.reason?.trim()) {
    throw new AppError(400, "Override reason is required");
  }

  const [existing] = await args.tenantDb
    .select()
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      status: "overridden",
      recommendedUnitPrice: args.input.recommendedUnitPrice,
      recommendedTotalPrice: args.input.recommendedTotalPrice,
      updatedAt: new Date(),
    })
    .where(eq(estimatePricingRecommendations.id, args.recommendationId))
    .returning();

  const reviewEvent = await insertPricingReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    recommendationId: args.recommendationId,
    userId: args.userId,
    eventType: "overridden",
    reason: args.input.reason,
    beforeJson: {
      recommendedUnitPrice: existing.recommendedUnitPrice,
      recommendedTotalPrice: existing.recommendedTotalPrice,
      status: existing.status,
    },
    afterJson: {
      recommendedUnitPrice: updated.recommendedUnitPrice,
      recommendedTotalPrice: updated.recommendedTotalPrice,
      status: updated.status,
    },
  });

  return { recommendation: updated, reviewEvent };
}
```

- [ ] **Step 5: Add the match and pricing mutation routes**

```ts
import {
  selectEstimateExtractionMatch,
  rejectEstimateExtractionMatch,
} from "../estimating/match-review-service.js";
import {
  approveEstimatePricingRecommendation,
  rejectEstimatePricingRecommendation,
  overrideEstimatePricingRecommendation,
} from "../estimating/pricing-review-service.js";

router.post("/:id/estimating/matches/:matchId/select", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await selectEstimateExtractionMatch({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      matchId: req.params.matchId,
      userId: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/matches/:matchId/reject", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await rejectEstimateExtractionMatch({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      matchId: req.params.matchId,
      userId: req.user!.id,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/recommendations/:recommendationId/reject", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await rejectEstimatePricingRecommendation({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/estimating/recommendations/:recommendationId/override", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await overrideEstimatePricingRecommendation({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Run the match/pricing review tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/match-review-service.test.ts tests/modules/estimating/pricing-review-service.test.ts tests/modules/estimating/workflow-state-routes.test.ts`

Expected: PASS with match selection and pricing override route coverage green.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/estimating/match-review-service.ts \
  server/src/modules/estimating/pricing-review-service.ts \
  server/src/modules/deals/routes.ts \
  server/tests/modules/estimating/match-review-service.test.ts \
  server/tests/modules/estimating/pricing-review-service.test.ts \
  server/tests/modules/estimating/workflow-state-routes.test.ts
git commit -m "feat: add workbench match and pricing review actions"
```

## Task 4: Add Document Reprocess and Review-Ready Workbench Panels

**Files:**
- Modify: `server/src/modules/estimating/document-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `client/src/components/estimating/estimate-documents-panel.tsx`
- Modify: `client/src/components/estimating/estimate-review-log-panel.tsx`
- Create: `client/src/components/estimating/estimate-workbench-summary-strip.tsx`
- Create: `client/src/components/estimating/estimate-workbench-sidebar.tsx`
- Create: `client/src/components/estimating/estimate-workbench-detail-pane.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.tsx`
- Modify: `client/src/pages/deals/deal-estimates-tab.tsx`
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`

- [ ] **Step 1: Write the failing shell test for split-pane workbench rendering**

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimatingWorkflowShell } from "./estimating-workflow-shell";

describe("EstimatingWorkflowShell", () => {
  it("renders summary, sidebar, and detail pane for the workbench", () => {
    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        documents={[]}
        extractionRows={[]}
        matchRows={[]}
        pricingRows={[]}
        reviewEvents={[]}
        summary={{
          documents: { total: 0, queued: 0, failed: 0 },
          extractions: { total: 0, pending: 0, approved: 0, rejected: 0, unmatched: 0 },
          matches: { total: 0, suggested: 0, selected: 0, rejected: 0 },
          pricing: { total: 0, pending: 0, approved: 0, overridden: 0, rejected: 0, readyToPromote: 0 },
        }}
        promotionReadiness={{ canPromote: false, generationRunIds: [] }}
        copilotEnabled
      />
    );

    expect(html).toContain("ready to promote");
    expect(html).toContain("Documents");
    expect(html).toContain("Review Log");
  });
});
```

- [ ] **Step 2: Run the focused shell test to verify it fails**

Run: `npx vitest run src/components/estimating/estimating-workflow-shell.test.tsx`

Expected: FAIL because the shell does not accept summary and promotion props yet.

- [ ] **Step 3: Add document reprocess support on the server**

```ts
import { and, eq } from "drizzle-orm";
import { estimateSourceDocuments } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

export async function reprocessEstimateSourceDocument(args: {
  tenantDb: TenantDb;
  dealId: string;
  documentId: string;
  officeId: string | null;
}) {
  const [document] = await args.tenantDb
    .update(estimateSourceDocuments)
    .set({
      ocrStatus: "queued",
      parsedAt: null,
    })
    .where(
      and(
        eq(estimateSourceDocuments.id, args.documentId),
        eq(estimateSourceDocuments.dealId, args.dealId)
      )
    )
    .returning();

  if (!document) {
    throw new AppError(404, "Estimate source document not found");
  }

  await enqueueEstimateDocumentOcrJob(args.tenantDb, {
    documentId: document.id,
    dealId: document.dealId,
    officeId: args.officeId,
  });

  return document;
}
```

```ts
router.post("/:id/estimating/documents/:documentId/reprocess", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const document = await reprocessEstimateSourceDocument({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      documentId: req.params.documentId,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
    });

    await req.commitTransaction!();
    res.status(200).json({ document });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Replace the shell placeholders with split-pane workbench structure**

```tsx
import { useMemo, useState } from "react";
import { EstimateWorkbenchSummaryStrip } from "./estimate-workbench-summary-strip";
import { EstimateWorkbenchSidebar } from "./estimate-workbench-sidebar";
import { EstimateWorkbenchDetailPane } from "./estimate-workbench-detail-pane";
import { EstimateCatalogMatchTable } from "./estimate-catalog-match-table";
import { EstimateDocumentsPanel } from "./estimate-documents-panel";
import { EstimateExtractionReviewTable } from "./estimate-extraction-review-table";
import { EstimatePricingReviewTable } from "./estimate-pricing-review-table";
import { EstimateReviewLogPanel } from "./estimate-review-log-panel";

export function EstimatingWorkflowShell(props: EstimatingWorkflowShellProps) {
  const [activeSection, setActiveSection] = useState<"documents" | "extractions" | "matches" | "pricing" | "reviewLog">("documents");
  const [selectedRow, setSelectedRow] = useState<any>(null);

  const sectionRows = useMemo(() => {
    switch (activeSection) {
      case "documents":
        return props.documents;
      case "extractions":
        return props.extractionRows;
      case "matches":
        return props.matchRows;
      case "pricing":
        return props.pricingRows;
      case "reviewLog":
        return props.reviewEvents;
    }
  }, [activeSection, props.documents, props.extractionRows, props.matchRows, props.pricingRows, props.reviewEvents]);

  return (
    <div className="space-y-4">
      <EstimateWorkbenchSummaryStrip
        summary={props.summary}
        promotionReadiness={props.promotionReadiness}
      />
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_360px]">
        <EstimateWorkbenchSidebar
          activeSection={activeSection}
          onSectionChange={setActiveSection}
          summary={props.summary}
        />
        <div className="min-w-0 rounded-lg border">
          {activeSection === "documents" ? (
            <EstimateDocumentsPanel
              dealId={props.dealId}
              documents={props.documents}
              onSelect={setSelectedRow}
              onRefresh={props.onRefresh}
            />
          ) : null}
          {activeSection === "extractions" ? (
            <EstimateExtractionReviewTable
              rows={props.extractionRows}
              selectedId={selectedRow?.id ?? null}
              onSelect={setSelectedRow}
              onRefresh={props.onRefresh}
            />
          ) : null}
          {activeSection === "matches" ? (
            <EstimateCatalogMatchTable
              rows={props.matchRows}
              selectedId={selectedRow?.id ?? null}
              onSelect={setSelectedRow}
              onRefresh={props.onRefresh}
            />
          ) : null}
          {activeSection === "pricing" ? (
            <EstimatePricingReviewTable
              rows={props.pricingRows}
              selectedId={selectedRow?.id ?? null}
              onSelect={setSelectedRow}
              onRefresh={props.onRefresh}
            />
          ) : null}
          {activeSection === "reviewLog" ? (
            <EstimateReviewLogPanel
              events={props.reviewEvents}
              onSelect={setSelectedRow}
            />
          ) : null}
        </div>
        <EstimateWorkbenchDetailPane
          activeSection={activeSection}
          selectedRow={selectedRow}
          summary={props.summary}
          promotionReadiness={props.promotionReadiness}
          relatedRows={sectionRows}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Feed the shell from the deal estimates tab**

```tsx
<EstimatingWorkflowShell
  dealId={dealId}
  documents={workflow.documents}
  extractionRows={workflow.extractionRows}
  matchRows={workflow.matchRows}
  pricingRows={workflow.pricingRows}
  reviewEvents={workflow.reviewEvents}
  summary={workflow.summary}
  promotionReadiness={workflow.promotionReadiness}
  onRefresh={fetchEstimates}
  copilotEnabled
/>
```

- [ ] **Step 6: Run the shell test to verify it passes**

Run: `npx vitest run src/components/estimating/estimating-workflow-shell.test.tsx`

Expected: PASS with split-pane shell rendering and summary text present.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/estimating/document-service.ts \
  server/src/modules/deals/routes.ts \
  client/src/components/estimating/estimate-documents-panel.tsx \
  client/src/components/estimating/estimate-review-log-panel.tsx \
  client/src/components/estimating/estimate-workbench-summary-strip.tsx \
  client/src/components/estimating/estimate-workbench-sidebar.tsx \
  client/src/components/estimating/estimate-workbench-detail-pane.tsx \
  client/src/components/estimating/estimating-workflow-shell.tsx \
  client/src/pages/deals/deal-estimates-tab.tsx \
  client/src/components/estimating/estimating-workflow-shell.test.tsx
git commit -m "feat: add estimating workbench shell"
```

## Task 5: Make the Extraction, Match, and Pricing Tables Interactive

**Files:**
- Modify: `client/src/components/estimating/estimate-extraction-review-table.tsx`
- Modify: `client/src/components/estimating/estimate-catalog-match-table.tsx`
- Modify: `client/src/components/estimating/estimate-pricing-review-table.tsx`
- Create: `client/src/components/estimating/estimate-extraction-review-table.test.tsx`
- Create: `client/src/components/estimating/estimate-pricing-review-table.test.tsx`
- Modify: `client/src/lib/api.ts` only if a tiny typed helper is truly required

- [ ] **Step 1: Write the failing extraction-table interaction test**

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimateExtractionReviewTable } from "./estimate-extraction-review-table";

describe("EstimateExtractionReviewTable", () => {
  it("renders approve and reject actions for the selected extraction row", () => {
    const html = renderToStaticMarkup(
      <EstimateExtractionReviewTable
        rows={[
          {
            id: "ext-1",
            normalizedLabel: "Parapet Wall Flashing",
            quantity: "3",
            unit: "ft",
            divisionHint: "07",
            status: "pending",
          },
        ]}
        selectedId="ext-1"
        onSelect={() => {}}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Parapet Wall Flashing");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });
});
```

- [ ] **Step 2: Run the focused client table tests to verify they fail**

Run: `npx vitest run src/components/estimating/estimate-extraction-review-table.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx`

Expected: FAIL because the interactive props and actions do not exist yet.

- [ ] **Step 3: Implement the extraction review table**

```tsx
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function EstimateExtractionReviewTable({
  rows,
  selectedId,
  onSelect,
  onRefresh,
}: {
  rows: any[];
  selectedId: string | null;
  onSelect: (row: any) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="divide-y">
      {rows.map((row) => {
        const isSelected = row.id === selectedId;
        return (
          <div
            key={row.id}
            className={`grid grid-cols-[2fr,120px,100px,100px,220px] items-center gap-3 p-3 ${isSelected ? "bg-muted/40" : ""}`}
            onClick={() => onSelect(row)}
          >
            <div>{row.normalizedLabel}</div>
            <div>{row.quantity}</div>
            <div>{row.unit}</div>
            <div>{row.status}</div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                onClick={async (event) => {
                  event.stopPropagation();
                  await api(`/deals/${row.dealId}/estimating/extractions/${row.id}/approve`, {
                    method: "POST",
                  });
                  await onRefresh();
                }}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async (event) => {
                  event.stopPropagation();
                  await api(`/deals/${row.dealId}/estimating/extractions/${row.id}/reject`, {
                    method: "POST",
                    json: { reason: "Rejected from workbench" },
                  });
                  await onRefresh();
                }}
              >
                Reject
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Implement the match and pricing tables with row actions**

```tsx
export function EstimateCatalogMatchTable({
  rows,
  selectedId,
  onSelect,
  onRefresh,
}: {
  rows: any[];
  selectedId: string | null;
  onSelect: (row: any) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="divide-y">
      {rows.map((row) => (
        <div
          key={row.id}
          className={`grid grid-cols-[2fr,120px,220px] gap-3 p-3 ${row.id === selectedId ? "bg-muted/40" : ""}`}
          onClick={() => onSelect(row)}
        >
          <div>{row.catalogItemName ?? row.catalogItemId}</div>
          <div>{row.status}</div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={async (event) => {
                event.stopPropagation();
                await api(`/deals/${row.dealId}/estimating/matches/${row.id}/select`, {
                  method: "POST",
                });
                await onRefresh();
              }}
            >
              Select
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async (event) => {
                event.stopPropagation();
                await api(`/deals/${row.dealId}/estimating/matches/${row.id}/reject`, {
                  method: "POST",
                  json: { reason: "Rejected from workbench" },
                });
                await onRefresh();
              }}
            >
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

```tsx
export function EstimatePricingReviewTable({
  rows,
  selectedId,
  onSelect,
  onRefresh,
}: {
  rows: any[];
  selectedId: string | null;
  onSelect: (row: any) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="divide-y">
      {rows.map((row) => (
        <div
          key={row.id}
          className={`grid grid-cols-[1.5fr,120px,120px,240px] gap-3 p-3 ${row.id === selectedId ? "bg-muted/40" : ""}`}
          onClick={() => onSelect(row)}
        >
          <div>{row.priceBasis}</div>
          <div>{row.recommendedUnitPrice}</div>
          <div>{row.status}</div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={async (event) => {
                event.stopPropagation();
                await api(`/deals/${row.dealId}/estimating/recommendations/${row.id}/approve`, {
                  method: "POST",
                });
                await onRefresh();
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async (event) => {
                event.stopPropagation();
                await api(`/deals/${row.dealId}/estimating/recommendations/${row.id}/reject`, {
                  method: "POST",
                  json: { reason: "Rejected from workbench" },
                });
                await onRefresh();
              }}
            >
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run the table tests to verify they pass**

Run: `npx vitest run src/components/estimating/estimate-extraction-review-table.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`

Expected: PASS with interactive table rendering and action affordances present.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/estimating/estimate-extraction-review-table.tsx \
  client/src/components/estimating/estimate-catalog-match-table.tsx \
  client/src/components/estimating/estimate-pricing-review-table.tsx \
  client/src/components/estimating/estimate-extraction-review-table.test.tsx \
  client/src/components/estimating/estimate-pricing-review-table.test.tsx \
  client/src/components/estimating/estimating-workflow-shell.test.tsx
git commit -m "feat: add interactive estimating workbench tables"
```

## Task 6: Verify the Full Workbench Slice

**Files:**
- Verify only; no required file additions

- [ ] **Step 1: Run the full estimating server test suite**

Run: `npx vitest run tests/modules/estimating/*.test.ts tests/modules/procore/catalog-sync-service.test.ts`

Expected: PASS with all workbench and estimating service tests green.

- [ ] **Step 2: Run the workbench client tests**

Run: `npx vitest run src/components/estimating/estimating-workflow-shell.test.tsx src/components/estimating/estimate-extraction-review-table.test.tsx src/components/estimating/estimate-pricing-review-table.test.tsx`

Expected: PASS with the split-pane workbench and table interactions green.

- [ ] **Step 3: Run typecheck across affected workspaces**

Run: `npm run typecheck --workspace=shared --workspace=server --workspace=client --workspace=worker`

Expected: PASS with no new type errors.

- [ ] **Step 4: Commit the verification checkpoint if any fixups were needed**

```bash
git add server client
git commit -m "test: verify estimator workbench slice"
```
