# Intervention Manager Narrative Brief and Inference Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-authored `Manager Brief` to `/admin/intervention-analytics` that summarizes what changed, where managers should focus now, and which patterns are emerging, without adding a new page, tab, or sidebar destination.

**Architecture:** Extend the existing intervention analytics pipeline to compute a compact `managerBrief` block from current manager-console inputs and short prior-window comparisons. Render that brief as the first anchored section in the existing long-form manager console. Keep the brief deterministic-grounded and resilient: if brief generation fails, only that section degrades while the rest of analytics remains available.

**Tech Stack:** Express, existing intervention analytics service pipeline, TypeScript, React, React Router, Vitest, existing manager-console layout primitives.

---

## File Map

### Existing files to modify

- `server/src/modules/ai-copilot/intervention-types.ts`
  - Add `InterventionManagerBrief` and wire it into `InterventionAnalyticsDashboard`.
- `server/src/modules/ai-copilot/intervention-service.ts`
  - Add brief-generation helpers and include `managerBrief` in the analytics dashboard payload.
- `server/tests/modules/ai-copilot/intervention-analytics-service.test.ts`
  - Add deterministic coverage for brief generation, allowlisted links, and local failure fallback.
- `client/src/hooks/use-ai-ops.ts`
  - Widen the analytics dashboard client contract with `managerBrief`.
- `client/src/pages/admin/admin-intervention-analytics-page.tsx`
  - Render the `Manager Brief` section above `Queue Health`, preserve existing anchors, and keep failures local.
- `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
  - Add section-order assertions, brief rendering checks, and fallback-state coverage.
- `client/src/components/ai/intervention-manager-console-nav.tsx`
  - Add the new `Manager Brief` anchor to the existing jump row.

### New files to create

- `client/src/components/ai/intervention-manager-brief.tsx`
  - Compact presentation component for headline, `whatChanged`, `focusNow`, `emergingPatterns`, and grounding note.
- `client/src/components/ai/intervention-manager-brief.test.tsx`
  - Focused rendering and link/fallback coverage for the brief component.

---

## Task 1: Add Failing Server Tests for the Manager Brief Contract

**Files:**
- Modify: `server/tests/modules/ai-copilot/intervention-analytics-service.test.ts`
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`

- [ ] **Step 1: Add failing expectations for `managerBrief` on the analytics dashboard**

Add a server test that seeds enough intervention analytics data to exercise:

- a worsening overdue or escalated-open condition
- a concrete focus item
- an emerging pattern
- allowlisted queue links only

Minimal assertions:

```ts
expect(dashboard.managerBrief.headline).toBeTruthy();
expect(dashboard.managerBrief.summaryWindowLabel).toContain("prior 7 days");
expect(dashboard.managerBrief.whatChanged.length).toBeGreaterThan(0);
expect(dashboard.managerBrief.focusNow.length).toBeGreaterThan(0);
expect(dashboard.managerBrief.emergingPatterns.length).toBeGreaterThan(0);
```

Also assert that every non-null `queueLink` is from the supported allowlist:

```ts
for (const item of [
  ...dashboard.managerBrief.whatChanged,
  ...dashboard.managerBrief.focusNow,
  ...dashboard.managerBrief.emergingPatterns,
]) {
  if (!item.queueLink) continue;
  expect(item.queueLink.startsWith("/admin/interventions?")).toBe(true);
}
```

- [ ] **Step 2: Add a failure-is-local test**

Add a server-level regression that simulates brief generation failure and asserts:

- `dashboard.managerBrief` falls back to an empty/local-error shape
- summary / hotspots / outcomes / slaRules still return as normal

Use a direct helper stub or narrow failure injection rather than breaking the whole analytics pipeline.

- [ ] **Step 3: Run the focused server analytics test to verify it fails**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-analytics-service.test.ts
```

Expected: FAIL because `managerBrief` does not exist yet.

---

## Task 2: Add Server Types and Deterministic Brief Generation

**Files:**
- Modify: `server/src/modules/ai-copilot/intervention-types.ts`
- Modify: `server/src/modules/ai-copilot/intervention-service.ts`
- Test: `server/tests/modules/ai-copilot/intervention-analytics-service.test.ts`

- [ ] **Step 1: Add the manager brief types**

Add types such as:

```ts
export interface InterventionManagerBriefItem {
  key: string;
  text: string;
  queueLink: string | null;
}

export interface InterventionManagerBrief {
  headline: string;
  summaryWindowLabel: string;
  whatChanged: Array<InterventionManagerBriefItem & { tone: "improved" | "worsened" | "watch" }>;
  focusNow: Array<InterventionManagerBriefItem & { priority: "high" | "medium" }>;
  emergingPatterns: Array<{
    key: string;
    title: string;
    summary: string;
    confidence: "high" | "medium";
    queueLink: string | null;
  }>;
  groundingNote: string;
  error: string | null;
}
```

Wire `managerBrief` into `InterventionAnalyticsDashboard`.

- [ ] **Step 2: Implement brief-building helpers in the analytics service**

Inside `intervention-service.ts`, add focused helpers:

- `buildManagerBrief(...)`
- `buildManagerBriefWhatChanged(...)`
- `buildManagerBriefFocusNow(...)`
- `buildManagerBriefPatterns(...)`
- `sanitizeManagerBriefQueueLink(...)`

Use existing analytics inputs only:

- summary counts
- hotspots
- breach queue
- manager alert family counts where already available in analytics inputs or derivable in the same pass
- outcome-effectiveness metrics
- automation recommendations when present

Use trailing 7-day vs prior 7-day comparison where the underlying metric already supports it or can be computed cheaply in the same analytics pass.

- [ ] **Step 3: Enforce the queue-link allowlist**

Add one helper that accepts only the v1-supported destinations:

- `/admin/interventions?view=overdue`
- `/admin/interventions?view=escalated`
- `/admin/interventions?view=snooze-breached`
- `/admin/interventions?view=repeat`
- `/admin/interventions?view=generated-task-pending`
- `/admin/interventions?view=all`
- `/admin/interventions?view=all&assigneeId=...`
- `/admin/interventions?view=all&disconnectType=...`
- `/admin/interventions?view=all&stageKey=...`
- `/admin/interventions?view=all&companyId=...`
- `/admin/interventions?view=all&repId=...`
- `/admin/intervention-analytics#queue-health`
- `/admin/intervention-analytics#manager-alerts`
- `/admin/intervention-analytics#outcome-effectiveness`
- `/admin/intervention-analytics#policy-recommendations`

Any unsupported drill-in becomes `null`.

- [ ] **Step 4: Make brief failure local**

Wrap brief generation so any thrown error produces a local fallback:

```ts
managerBrief = {
  headline: "No strong manager brief is available yet.",
  summaryWindowLabel: "Compared with the prior 7 days",
  whatChanged: [],
  focusNow: [],
  emergingPatterns: [],
  groundingNote: "Manager brief unavailable. Continue monitoring queue health and outcome trends.",
  error: "Failed to build manager brief",
};
```

Do not let the analytics route fail because the brief failed.

- [ ] **Step 5: Re-run the focused server test**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-analytics-service.test.ts
```

Expected: PASS.

---

## Task 3: Add Failing Client Tests for the New Manager Brief Section

**Files:**
- Modify: `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
- Create: `client/src/components/ai/intervention-manager-brief.test.tsx`
- Modify: `client/src/components/ai/intervention-manager-console-nav.tsx`

- [ ] **Step 1: Add failing page assertions for the new top section**

In `admin-intervention-analytics-page.test.tsx`, assert:

```tsx
expect(html).toContain('href="#manager-brief"');
expect(html).toContain('id="manager-brief"');
expect(html.indexOf("Manager Brief")).toBeLessThan(html.indexOf("Queue Health"));
```

Also assert the existing sections still remain:

```tsx
expect(html).toContain("Manager Alerts");
expect(html).toContain("Outcome Effectiveness");
expect(html).toContain("Policy Recommendations");
```

- [ ] **Step 2: Add a focused component test for the brief**

Create `intervention-manager-brief.test.tsx` with cases for:

- normal rendering of headline / what changed / focus now / pattern cards
- null-link items rendering as non-clickable text
- local error/fallback banner rendering while other content remains simple and compact

- [ ] **Step 3: Run the focused client tests to verify they fail**

Run:

```bash
npx vitest run client/src/components/ai/intervention-manager-brief.test.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: FAIL because the section and component do not exist yet.

---

## Task 4: Implement the Manager Brief Component and Wire It Into the Manager Console

**Files:**
- Create: `client/src/components/ai/intervention-manager-brief.tsx`
- Modify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Modify: `client/src/hooks/use-ai-ops.ts`
- Modify: `client/src/components/ai/intervention-manager-console-nav.tsx`
- Tests: client brief/page tests

- [ ] **Step 1: Add the client contract**

Mirror the server `managerBrief` shape in `use-ai-ops.ts` and add it to `InterventionAnalyticsDashboard`.

- [ ] **Step 2: Add the new jump-row anchor**

Update `intervention-manager-console-nav.tsx` to prepend:

```ts
{ id: "manager-brief", label: "Manager brief" }
```

Do not create tabs or any new top-level nav structure.

- [ ] **Step 3: Implement the brief component**

Create a compact component that renders:

- headline
- summary window label
- `whatChanged`
- `focusNow`
- `emergingPatterns`
- grounding note
- local error/fallback state

Rules:

- short bullets only
- at most 3 pattern cards
- render links only when `queueLink` is non-null
- no extra accordions or nested cards

- [ ] **Step 4: Insert the section at the top of `/admin/intervention-analytics`**

In `admin-intervention-analytics-page.tsx`:

- add `InterventionManagerConsoleSection id="manager-brief"`
- render it above `Queue Health`
- if `data.managerBrief.error` exists, keep the error local to this section
- preserve the rest of the page and existing links untouched

- [ ] **Step 5: Re-run the focused client tests**

Run:

```bash
npx vitest run client/src/components/ai/intervention-manager-brief.test.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: PASS.

---

## Task 5: Run Full Verification and Cleanup

**Files:**
- All touched files in this slice

- [ ] **Step 1: Run the targeted server and client tests**

Run:

```bash
npx vitest run server/tests/modules/ai-copilot/intervention-analytics-service.test.ts
npx vitest run client/src/components/ai/intervention-manager-brief.test.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run workspace typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit the final implementation**

```bash
git add server/src/modules/ai-copilot/intervention-types.ts \
        server/src/modules/ai-copilot/intervention-service.ts \
        server/tests/modules/ai-copilot/intervention-analytics-service.test.ts \
        client/src/hooks/use-ai-ops.ts \
        client/src/components/ai/intervention-manager-console-nav.tsx \
        client/src/components/ai/intervention-manager-brief.tsx \
        client/src/components/ai/intervention-manager-brief.test.tsx \
        client/src/pages/admin/admin-intervention-analytics-page.tsx \
        client/src/pages/admin/admin-intervention-analytics-page.test.tsx
git commit -m "feat: add intervention manager narrative brief"
```

---

## Verification Checklist

- [ ] `managerBrief` is included in the analytics payload
- [ ] all brief links use only the allowlisted route/filter contract
- [ ] unsupported drill-ins become `queueLink: null`
- [ ] brief failure degrades locally without breaking the rest of analytics
- [ ] `/admin/intervention-analytics` renders `Manager Brief` above `Queue Health`
- [ ] jump row includes `#manager-brief`
- [ ] no new page, tab, or sidebar item is added
- [ ] `npx vitest` targeted runs pass
- [ ] `npm run typecheck` passes
- [ ] `git diff --check` passes
