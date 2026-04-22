# Intervention Platform Consolidation and Manager Console Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the intervention admin experience so `/admin/intervention-analytics` is the canonical manager console, `/admin/interventions` stays the execution surface, and `/admin/sales-process-disconnects` becomes a slimmer signals page without losing existing capability.

**Architecture:** This is a frontend-first information-architecture cleanup. Recompose the existing analytics and disconnect modules into clearer page sections, move the current `sales-process-disconnects` local filters into URL state, and tighten cross-links so duplicated manager-console framing disappears without changing deterministic backend behavior.

**Tech Stack:** React, React Router, TypeScript, Vitest, existing admin/AI UI components

---

## File Map

### Existing files to modify

- `client/src/pages/admin/admin-intervention-analytics-page.tsx`
  - Reorganize into anchored manager-console sections, add jump-row, absorb/remove the standalone `Manager Readout`, and preserve existing manager-alert resilience.
  - Preserve passthrough source params (`type`, `cluster`, `trend`) on the link back to `sales-process-disconnects` when they are present in the current URL.
- `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
  - Verify anchors, section ordering, jump-row links, manager-alert persistence, and that the old standalone readout no longer survives as a fifth block.
- `client/src/pages/admin/sales-process-disconnects-page.tsx`
  - Move `type`, `cluster`, and `trend` filters into URL-backed state, slim manager-console framing, strengthen links to analytics/workspace, and preserve all current source-side controls.
- `client/src/pages/admin/admin-intervention-workspace-page.tsx`
  - Tighten execution-surface wording and link labels so the page clearly points out to the manager console and upstream signals page.
  - Preserve passthrough source params (`type`, `cluster`, `trend`) on the link back to `sales-process-disconnects` when they are present in the current URL.

### New files to create

- `client/src/components/ai/intervention-manager-console-nav.tsx`
  - Compact jump-row for the four canonical analytics anchors.
- `client/src/components/ai/intervention-manager-console-section.tsx`
  - Lightweight section shell with stable `id`, title, description, and content slotting.
- `client/src/pages/admin/sales-process-disconnects-page.test.tsx`
  - New regression coverage for URL-backed `type`, `cluster`, and `trend` filters and stronger downstream links.
- `client/src/pages/admin/admin-intervention-workspace-page.test.tsx`
  - New regression coverage for execution-surface navigation labels and outbound links.

### Existing reusable components likely to remain unchanged or only lightly integrated

- `client/src/components/ai/intervention-analytics-summary-strip.tsx`
- `client/src/components/ai/intervention-analytics-outcomes.tsx`
- `client/src/components/ai/intervention-analytics-hotspots.tsx`
- `client/src/components/ai/intervention-analytics-breach-queue.tsx`
- `client/src/components/ai/intervention-analytics-sla-rules.tsx`
- `client/src/components/ai/intervention-effectiveness-summary.tsx`

---

### Task 0: Sync This Worktree To The Current Intervention Platform Baseline

**Files:**
- Verify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Verify: `client/src/components/ai/*`

- [ ] **Step 1: Confirm the worktree contains the merged manager-console baseline**

Run:

```bash
rg -n "InterventionAutomationRecommendations|Automation Tuning Recommendations|Manager Alerts" client/src/pages/admin/admin-intervention-analytics-page.tsx client/src/components/ai
```

Expected:

- the branch already contains the merged manager-alerts and policy-recommendation modules

If the policy-recommendations module is missing in this worktree, stop and sync/rebase this branch onto the latest main line that already contains:

- manager alerts
- outcome effectiveness
- automation tuning recommendations

This cleanup plan assumes those previously shipped capabilities are present before consolidation starts.

- [ ] **Step 2: Re-run the same grep after syncing**

Run:

```bash
rg -n "Automation Tuning Recommendations|Manager Alerts" client/src/pages/admin/admin-intervention-analytics-page.tsx client/src/components/ai
```

Expected: PASS with all three capabilities present in the working branch.

- [ ] **Step 3: Commit only if the sync itself produces a new local commit**

```bash
git status --short
```

Expected: either clean or only expected sync changes. Do not proceed to Task 1 until the branch contains the shipped intervention manager-console modules.

---

### Task 1: Add Manager Console Layout Primitives

**Files:**
- Create: `client/src/components/ai/intervention-manager-console-nav.tsx`
- Create: `client/src/components/ai/intervention-manager-console-section.tsx`
- Test: `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`

- [ ] **Step 1: Write the failing analytics-page assertions for the canonical anchors and jump-row**

Add assertions in `client/src/pages/admin/admin-intervention-analytics-page.test.tsx` for these exact links:

```tsx
expect(html).toContain('href=\"#queue-health\"');
expect(html).toContain('href=\"#manager-alerts\"');
expect(html).toContain('href=\"#outcome-effectiveness\"');
expect(html).toContain('href=\"#policy-recommendations\"');
```

Also add expectations that the rendered page includes these section ids:

```tsx
expect(html).toContain('id=\"queue-health\"');
expect(html).toContain('id=\"manager-alerts\"');
expect(html).toContain('id=\"outcome-effectiveness\"');
expect(html).toContain('id=\"policy-recommendations\"');
```

- [ ] **Step 2: Run the focused analytics-page test to verify it fails**

Run:

```bash
npx vitest run client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: FAIL because the jump-row and stable section ids do not exist yet.

- [ ] **Step 3: Add the manager-console nav component**

Create `client/src/components/ai/intervention-manager-console-nav.tsx`:

```tsx
const ITEMS = [
  { href: "#queue-health", label: "Queue Health" },
  { href: "#manager-alerts", label: "Manager Alerts" },
  { href: "#outcome-effectiveness", label: "Outcome Effectiveness" },
  { href: "#policy-recommendations", label: "Policy Recommendations" },
] as const;

export function InterventionManagerConsoleNav() {
  return (
    <nav aria-label="Manager console sections" className="rounded-xl border border-border/80 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap gap-2">
        {ITEMS.map((item) => (
          <a key={item.href} href={item.href} className="rounded-full border border-border px-3 py-1 text-xs font-semibold uppercase tracking-widest text-gray-700">
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Add the section shell component**

Create `client/src/components/ai/intervention-manager-console-section.tsx`:

```tsx
import type { ReactNode } from "react";

export function InterventionManagerConsoleSection(props: {
  id: "queue-health" | "manager-alerts" | "outcome-effectiveness" | "policy-recommendations";
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { id, title, description, children } = props;

  return (
    <section id={id} className="space-y-4 scroll-mt-24">
      <div className="space-y-1">
        <h2 className="text-xl font-black tracking-tight text-gray-900">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}
```

- [ ] **Step 5: Run the focused analytics-page test again**

Run:

```bash
npx vitest run client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: still FAIL, but now only because the analytics page has not yet adopted the new components.

- [ ] **Step 6: Commit the layout-primitives scaffold**

```bash
git add client/src/components/ai/intervention-manager-console-nav.tsx client/src/components/ai/intervention-manager-console-section.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx
git commit -m "feat: add intervention manager console layout primitives"
```

### Task 2: Recompose `/admin/intervention-analytics` Into the Canonical Manager Console

**Files:**
- Modify: `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- Test: `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`

- [ ] **Step 1: Extend the analytics-page test with section ownership assertions**

Add assertions that:

```tsx
expect(html).toContain("Queue Health");
expect(html).toContain("Manager Alerts");
expect(html).toContain("Outcome Effectiveness");
expect(html).toContain("Policy Recommendations");
expect(html).not.toContain("Manager Readout");
```

Also assert that the existing content still appears under the new composition:

```tsx
expect(html).toContain("Resolution Effectiveness");
expect(html).toContain("Automation Tuning Recommendations");
expect(html).toContain("Breach Queue");
```

- [ ] **Step 2: Run the analytics-page test to verify the new assertions fail**

Run:

```bash
npx vitest run client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: FAIL because the page still renders the old standalone `Manager Readout` block and has no four-section shell.

- [ ] **Step 3: Recompose the analytics page around the section shell and jump-row**

Modify `client/src/pages/admin/admin-intervention-analytics-page.tsx` to:

- import the two new components
- render `InterventionManagerConsoleNav` below the page header
- wrap the page content in four `InterventionManagerConsoleSection` blocks
- keep `ManagerAlertsPanel` inside the `manager-alerts` section
- place summary strip, outcomes, SLA rules, hotspots, and breach queue inside `queue-health`
- place `InterventionEffectivenessSummary` inside `outcome-effectiveness`
- place the synced policy-recommendations module from Task 0 inside `policy-recommendations`
- remove the standalone `Manager Readout` card as a fifth module, folding any necessary introductory copy into the `Queue Health` section description
- preserve any passthrough `type`, `cluster`, and `trend` params already present in the page URL when building the link back to `/admin/sales-process-disconnects`

Minimal target shape:

```tsx
<InterventionManagerConsoleNav />

<InterventionManagerConsoleSection id="queue-health" title="Queue Health" description="Current intervention load, SLA pressure, and breach visibility.">
  <InterventionAnalyticsSummaryStrip ... />
  ...
</InterventionManagerConsoleSection>
```

- [ ] **Step 4: Preserve resilience while restructuring**

Keep this behavior intact:

- `ManagerAlertsPanel` still renders even when `data` is missing
- broader analytics failure still shows the existing page-level unavailable message
- recommendation-section local error behavior remains section-local and still renders a local warning without hiding the rest of the manager console

Do not couple `ManagerAlertsPanel` to the main analytics payload during the refactor.

Also add/keep an assertion in `client/src/pages/admin/admin-intervention-analytics-page.test.tsx` that a recommendation error banner can render while:

```tsx
expect(html).toContain("Automation tuning recommendations are temporarily unavailable.");
expect(html).toContain("Manager Alerts");
expect(html).toContain("Resolution Effectiveness");
expect(html).toContain("Breach Queue");
```

Also add an assertion that when the page is rendered with passthrough params in the current URL, the rendered `Process Disconnects` link includes them:

```tsx
expect(html).toContain('/admin/sales-process-disconnects?type=missing_next_task&cluster=follow_through_gap&trend=companies');
```

Implement the passthrough by reading the current search params on the analytics page and rebuilding only the supported source params for the back-link:

```tsx
const sourceBackParams = new URLSearchParams();
const type = searchParams.get("type");
const cluster = searchParams.get("cluster");
const trend = searchParams.get("trend");
if (type) sourceBackParams.set("type", type);
if (cluster) sourceBackParams.set("cluster", cluster);
if (trend) sourceBackParams.set("trend", trend);
```

Do not forward these params into analytics data loading. They exist only so the back-link to `/admin/sales-process-disconnects` can reconstruct the source-state URL.

Add a note in the implementation that this uses `useSearchParams` on `admin-intervention-analytics-page.tsx` strictly for back-link construction, not for changing analytics data fetch semantics.

- [ ] **Step 5: Run the analytics-page test again**

Run:

```bash
npx vitest run client/src/pages/admin/admin-intervention-analytics-page.test.tsx --config client/vite.config.ts
```

Expected: PASS with the new anchors, section titles, and no standalone `Manager Readout`.

- [ ] **Step 6: Commit the analytics-page consolidation**

```bash
git add client/src/pages/admin/admin-intervention-analytics-page.tsx client/src/pages/admin/admin-intervention-analytics-page.test.tsx client/src/components/ai/intervention-manager-console-nav.tsx client/src/components/ai/intervention-manager-console-section.tsx
git commit -m "feat: consolidate intervention analytics into manager console"
```

### Task 3: Make `/admin/sales-process-disconnects` URL-Backed and Slim the Manager Framing

**Files:**
- Modify: `client/src/pages/admin/sales-process-disconnects-page.tsx`
- Create: `client/src/pages/admin/sales-process-disconnects-page.test.tsx`

- [ ] **Step 1: Write the failing disconnects-page tests for URL-backed filter state**

Create `client/src/pages/admin/sales-process-disconnects-page.test.tsx` with expectations that the page:

- hydrates `type`, `cluster`, and `trend` from the URL
- preserves those params in links to analytics/workspace when appropriate
- still renders source-side controls like `Queue Digest`, `Queue Escalation Scan`, and `Queue Admin Tasks`
- keeps the source-side signals modules that remain in scope after consolidation

Mock the dashboard hook explicitly so the test is executable in this codebase:

```tsx
const mocks = vi.hoisted(() => ({
  useSalesProcessDisconnectDashboard: vi.fn(),
}));

vi.mock("@/hooks/use-ai-ops", () => ({
  useSalesProcessDisconnectDashboard: mocks.useSalesProcessDisconnectDashboard,
  queueAiDisconnectAdminTasks: vi.fn(),
  queueAiDisconnectDigest: vi.fn(),
  queueAiDisconnectEscalationScan: vi.fn(),
  trackSalesProcessDisconnectInteraction: vi.fn(),
}));
```

Use a fixture that includes:

- `summary`
- `clusters`
- `trends`
- `narrative`
- `automation`
- `rows`
- `outcomes`
- `actionSummary`
- `playbooks`

Include a focused test shape like:

```tsx
const html = renderToStaticMarkup(
  <MemoryRouter initialEntries={["/admin/sales-process-disconnects?type=missing_next_task&cluster=follow_through_gap&trend=companies"]}>
    <SalesProcessDisconnectsPage />
  </MemoryRouter>
);
```

Then assert:

```tsx
expect(html).toContain("Sales Process Disconnects");
expect(html).toContain("View Intervention Analytics");
expect(html).toContain("Open Intervention Workspace");
expect(html).toContain("Weekly Management Narrative");
expect(html).toContain("Automation Status");
expect(html).not.toContain("Intervention Outcomes");
expect(html).not.toContain("Action Scoreboard");
expect(html).not.toContain("Intervention Playbooks");
```

- [ ] **Step 2: Run the new disconnects-page test to verify it fails**

Run:

```bash
npx vitest run client/src/pages/admin/sales-process-disconnects-page.test.tsx --config client/vite.config.ts
```

Expected: FAIL because the page currently uses local state only and ignores URL params.

- [ ] **Step 3: Move disconnect filter state into `useSearchParams`**

Modify `client/src/pages/admin/sales-process-disconnects-page.tsx` to:

- import `useSearchParams`
- initialize `typeFilter`, `clusterFilter`, and `trendDimension` from:

```tsx
const [searchParams, setSearchParams] = useSearchParams();
const typeFilter = searchParams.get("type") ?? "all";
const clusterFilter = searchParams.get("cluster") ?? "all";
const trendDimension = (searchParams.get("trend") as "reps" | "stages" | "companies" | null) ?? "reps";
```

- replace direct `useState` setters with helper functions that write back to the URL
- keep analytics logic and tracking behavior unchanged

Also ensure the two downstream links preserve the current source filter context:

```tsx
const sourceParams = new URLSearchParams();
if (typeFilter !== "all") sourceParams.set("type", typeFilter);
if (clusterFilter !== "all") sourceParams.set("cluster", clusterFilter);
if (trendDimension !== "reps") sourceParams.set("trend", trendDimension);
```

Use those params when building links back into:

- `/admin/intervention-analytics`
- `/admin/interventions`

The destination pages do not need to understand those params in this slice; the requirement is that a user navigating back to the signals page can recover the same source-state URL.

Because `/admin/interventions` currently rewrites search params through `setSearchParams`, include a companion change in Task 4 so the workspace preserves passthrough source params when serializing its own query contract. Keep those passthrough params only on the link back to `/admin/sales-process-disconnects`; do not let them leak into queue-filter API inputs.

- [ ] **Step 4: Slim the manager-console framing on the disconnects page**

In `client/src/pages/admin/sales-process-disconnects-page.tsx`:

- keep disconnect summary, clusters, trends, narrative, automation status, and row inventory
- update copy so the page reads as a signals page, not the central manager console
- make the links to `/admin/intervention-analytics` and `/admin/interventions` more prominent and grouped as the primary downstream routes
- do not delete digest, escalation, or admin-task queue controls

Apply the consolidation module-by-module:

- keep `Weekly Management Narrative`, but relabel/describe it as source-side narrative rather than central manager-console readout
- keep `Automation Status`, but describe it as source-side disconnect automation validation
- keep `Root Cause Clusters` and trend sections as source-side disconnect analysis
- remove the standalone `Intervention Outcomes`, `Action Scoreboard`, and `Intervention Playbooks` blocks from this page
- replace their duplicated manager-dashboard role with stronger drill-in links into `/admin/intervention-analytics#outcome-effectiveness` and `/admin/intervention-analytics#policy-recommendations` where needed
- remove or rewrite any copy that implies this page is the main intervention-management dashboard
- do not introduce manager-alert summaries, intervention queue-health summaries, or outcome-effectiveness summaries here

Concretely:

- adjust the page intro copy to emphasize “signals”, “source context”, or “upstream process issues”
- avoid phrases like “central management” or “manager-first dashboard” if present during cleanup
- keep the deterministic actions as source-side controls

- [ ] **Step 5: Run the new disconnects-page test again**

Run:

```bash
npx vitest run client/src/pages/admin/sales-process-disconnects-page.test.tsx --config client/vite.config.ts
```

Expected: PASS with URL-backed filters and preserved source-side controls.

Also verify the rendered analytics/workspace links include the current `type`, `cluster`, and `trend` params in their `href`.

- [ ] **Step 6: Commit the disconnects-page consolidation**

```bash
git add client/src/pages/admin/sales-process-disconnects-page.tsx client/src/pages/admin/sales-process-disconnects-page.test.tsx
git commit -m "feat: slim disconnects page into signals surface"
```

### Task 4: Tighten `/admin/interventions` as the Execution Surface

**Files:**
- Modify: `client/src/pages/admin/admin-intervention-workspace-page.tsx`
- Create: `client/src/pages/admin/admin-intervention-workspace-page.test.tsx`

- [ ] **Step 1: Write the failing workspace-page test for execution-surface links**

Create `client/src/pages/admin/admin-intervention-workspace-page.test.tsx` with assertions that the page:

- renders the execution-focused title and copy
- includes outbound links to:
  - `/admin/intervention-analytics`
  - `/admin/sales-process-disconnects`
- does not add manager-console summary duplication
- preserves passthrough `type`, `cluster`, and `trend` params on the disconnects link when they are present in the current URL

Example assertions:

```tsx
expect(html).toContain("Admin Intervention Workspace");
expect(html).toContain("View Analytics");
expect(html).toContain("View Disconnect Dashboard");
expect(html).toContain('/admin/sales-process-disconnects?type=missing_next_task&cluster=follow_through_gap&trend=companies');
```

- [ ] **Step 2: Run the new workspace-page test to verify the current state**

Run:

```bash
npx vitest run client/src/pages/admin/admin-intervention-workspace-page.test.tsx --config client/vite.config.ts
```

Expected: likely FAIL because no dedicated test exists yet and the current copy may need tightening.

- [ ] **Step 3: Refine workspace copy and link labels only as needed**

Modify `client/src/pages/admin/admin-intervention-workspace-page.tsx` to make the page read unmistakably as the action surface:

- keep the queue, batch toolbar, detail panel, and saved views untouched
- if needed, adjust the subtitle to emphasize “execution”, “act on cases”, or “direct intervention handling”
- keep outward links visible and clearly subordinate to the workspace itself
- preserve passthrough `type`, `cluster`, and `trend` params already present in the workspace URL when rendering the back-link to `sales-process-disconnects`

Implement this with a separate source-back-link helper, not by adding `type`, `cluster`, or `trend` to `useAdminInterventions(...)`. The workspace may still serialize only its supported queue params for its own route state, but the disconnects back-link must be built from the current raw `searchParams` snapshot before unsupported source params are discarded.

The same rule applies to `/admin/intervention-analytics`: build the disconnects back-link from the current raw search params, but do not let `type`, `cluster`, or `trend` leak into analytics fetching or route-owned manager-console state.

Do not add new analytics cards or manager-summary modules here.

- [ ] **Step 4: Run the workspace-page test again**

Run:

```bash
npx vitest run client/src/pages/admin/admin-intervention-workspace-page.test.tsx --config client/vite.config.ts
```

Expected: PASS with the execution-surface framing and outbound links preserved.

Also verify the rendered disconnects link still includes:

```tsx
/admin/sales-process-disconnects?type=missing_next_task&cluster=follow_through_gap&trend=companies
```

- [ ] **Step 5: Commit the workspace cleanup**

```bash
git add client/src/pages/admin/admin-intervention-workspace-page.tsx client/src/pages/admin/admin-intervention-workspace-page.test.tsx
git commit -m "feat: clarify intervention workspace execution surface"
```

### Task 5: Full Frontend Verification and Regression Sweep

**Files:**
- Verify only:
  - `client/src/pages/admin/admin-intervention-analytics-page.tsx`
  - `client/src/pages/admin/admin-intervention-analytics-page.test.tsx`
  - `client/src/pages/admin/sales-process-disconnects-page.tsx`
  - `client/src/pages/admin/sales-process-disconnects-page.test.tsx`
  - `client/src/pages/admin/admin-intervention-workspace-page.tsx`
  - `client/src/pages/admin/admin-intervention-workspace-page.test.tsx`
  - `client/src/components/ai/intervention-manager-console-nav.tsx`
  - `client/src/components/ai/intervention-manager-console-section.tsx`

- [ ] **Step 1: Run the focused admin-page/client suite**

Run:

```bash
npx vitest run \
  client/src/pages/admin/admin-intervention-analytics-page.test.tsx \
  client/src/pages/admin/sales-process-disconnects-page.test.tsx \
  client/src/pages/admin/admin-intervention-workspace-page.test.tsx \
  --config client/vite.config.ts
```

Expected: PASS

- [ ] **Step 2: Run focused existing analytics component regressions**

Run:

```bash
npx vitest run \
  client/src/components/ai/intervention-effectiveness-summary.test.tsx \
  client/src/components/ai/intervention-effectiveness-reason-table.test.tsx \
  --config client/vite.config.ts
```

Expected: PASS

- [ ] **Step 3: Run workspace typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no output

- [ ] **Step 5: Commit the verified consolidation slice**

```bash
git add client/src/pages/admin/admin-intervention-analytics-page.tsx \
  client/src/pages/admin/admin-intervention-analytics-page.test.tsx \
  client/src/pages/admin/sales-process-disconnects-page.tsx \
  client/src/pages/admin/sales-process-disconnects-page.test.tsx \
  client/src/pages/admin/admin-intervention-workspace-page.tsx \
  client/src/pages/admin/admin-intervention-workspace-page.test.tsx \
  client/src/components/ai/intervention-manager-console-nav.tsx \
  client/src/components/ai/intervention-manager-console-section.tsx
git commit -m "feat: consolidate intervention admin surfaces"
```

---

## Self-Review

### Spec coverage

- canonical manager console with four sections: Task 2
- exact anchors and jump-row mapping: Tasks 1-2
- manager alerts remain independently visible: Task 2
- `Manager Readout` absorbed/removed: Task 2
- disconnects page becomes slimmer signals surface: Task 3
- disconnect filter state preserved via URL params `type`, `cluster`, `trend`: Task 3
- workspace remains execution-focused: Task 4
- regression coverage and verification: Task 5

No spec gaps remain.

### Placeholder scan

- no `TBD`, `TODO`, or vague “implement later” instructions
- all code-touching tasks include exact file paths and concrete code/commands

### Type consistency

- analytics anchors use the exact ids from the spec
- disconnect URL params use the exact keys from the spec:
  - `type`
  - `cluster`
  - `trend`

No naming drift remains in the plan.
