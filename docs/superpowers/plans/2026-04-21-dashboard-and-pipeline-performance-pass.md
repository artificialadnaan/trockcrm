# Dashboard And Pipeline Performance Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard and pipeline routes render meaningful content quickly by splitting heavy payloads into fast-path summary contracts, preview-oriented board contracts, and deferred secondary panels while preserving all existing functionality.

**Architecture:** The pass splits the work into four layers: server summary endpoints, server board-preview and stage-page endpoints, client data hooks, and route/page rewrites that render in layers instead of blocking whole pages. The client keeps the current shell and workflows, but replaces page-level loading gates with section-level loaders and uses paginated stage pages as the exhaustive detail surface.

**Tech Stack:** React, React Router, TypeScript, Vitest, Express, Drizzle ORM, Node

---

## File Structure

### Client files to create

- `client/src/pages/dashboard/admin-dashboard-page.tsx`
  - admin home surface with layered loading
- `client/src/pages/dashboard/home-dashboard-page.tsx`
  - role-aware dashboard entry page
- `client/src/pages/deals/deal-stage-page.tsx`
  - dedicated paginated deal-stage page
- `client/src/pages/leads/lead-stage-page.tsx`
  - dedicated paginated lead-stage page
- `client/src/components/pipeline/pipeline-board.tsx`
  - shared preview-board shell for leads and deals
- `client/src/components/pipeline/pipeline-stage-table.tsx`
  - shared paginated stage-page table
- `client/src/components/dashboard/dashboard-section-shell.tsx`
  - stable section skeleton wrapper
- `client/src/hooks/use-admin-dashboard-summary.ts`
  - fast-path admin summary hook
- `client/src/hooks/use-board-preview.ts`
  - shared deals/leads board-preview loader
- `client/src/hooks/use-pipeline-stage-page.ts`
  - shared paginated stage-page loader
- `client/src/lib/pipeline-stage-page.ts`
  - search, sort, and path helpers for stage pages
- `client/src/pages/dashboard/admin-dashboard-page.test.tsx`
- `client/src/pages/dashboard/home-dashboard-page.test.tsx`
- `client/src/pages/dashboard/rep-dashboard-page.test.tsx`
- `client/src/pages/director/director-dashboard-page.test.tsx`
- `client/src/pages/deals/deal-stage-page.test.tsx`
- `client/src/pages/leads/lead-stage-page.test.tsx`
- `client/src/components/pipeline/pipeline-board.test.tsx`
- `client/src/components/pipeline/pipeline-stage-table.test.tsx`
- `client/src/hooks/use-admin-dashboard-summary.test.ts`
- `client/src/lib/pipeline-stage-page.test.ts`

### Client files to modify

- `client/src/App.tsx`
- `client/src/pages/dashboard/rep-dashboard-page.tsx`
- `client/src/pages/director/director-dashboard-page.tsx`
- `client/src/pages/deals/deal-list-page.tsx`
- `client/src/pages/leads/lead-list-page.tsx`
- `client/src/hooks/use-dashboard.ts`
- `client/src/hooks/use-director-dashboard.ts`
- `client/src/hooks/use-deals.ts`
- `client/src/hooks/use-leads.ts`
- `client/src/pages/pipeline/pipeline-page.tsx`

### Server files to create

- `server/tests/modules/dashboard/routes-summary.test.ts`
- `server/tests/modules/deals/board-preview-service.test.ts`
- `server/tests/modules/leads/board-preview-service.test.ts`
- `server/tests/modules/deals/stage-page-service.test.ts`
- `server/tests/modules/leads/stage-page-service.test.ts`

### Server files to modify

- `server/src/modules/dashboard/service.ts`
- `server/src/modules/dashboard/routes.ts`
- `server/src/modules/deals/service.ts`
- `server/src/modules/deals/routes.ts`
- `server/src/modules/leads/service.ts`
- `server/src/modules/leads/routes.ts`
- `server/tests/modules/dashboard/service.test.ts`

## Task 1: Split Fast-Path Dashboard Summary Contracts

**Files:**
- Modify: `server/src/modules/dashboard/service.ts`
- Modify: `server/src/modules/dashboard/routes.ts`
- Modify: `server/tests/modules/dashboard/service.test.ts`
- Create: `server/tests/modules/dashboard/routes-summary.test.ts`

- [ ] **Step 1: Write the failing summary-endpoint tests**

```ts
describe("dashboard summary routes", () => {
  it("returns a lightweight director summary without trend tables", async () => {
    const res = await request(app)
      .get("/api/dashboard/director/summary")
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totals: expect.any(Object),
      board: expect.any(Object),
      repPreview: expect.any(Array),
    });
    expect(res.body.data.winRateTrend).toBeUndefined();
    expect(res.body.data.activityByRep).toBeUndefined();
  });

  it("returns a lightweight admin summary for the home dashboard", async () => {
    const res = await request(app)
      .get("/api/dashboard/admin/summary")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      needsAttention: expect.any(Object),
      systemHealth: expect.any(Object),
      workspaceChanges: expect.any(Object),
      teamSnapshot: expect.any(Object),
    });
  });
});
```

- [ ] **Step 2: Run the new server tests to verify they fail**

Run: `npx vitest run --config server/vitest.config.ts server/tests/modules/dashboard/routes-summary.test.ts server/tests/modules/dashboard/service.test.ts`

Expected: FAIL with missing route handlers and missing summary service exports.

- [ ] **Step 3: Implement summary-specific service functions and routes**

```ts
export async function getDirectorDashboardSummary(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
) {
  const [repCards, pipeline, staleDeals, staleLeads, ddVsPipeline] = await Promise.all([
    buildRepPerformanceCards(tenantDb, resolveRange(options)),
    getPipelineSummary(tenantDb, { includeDd: false, ...resolveRange(options) }),
    getStaleDeals(tenantDb),
    getStaleLeadWatchlist(tenantDb),
    getDdVsPipeline(tenantDb),
  ]);

  return {
    totals: ddVsPipeline,
    board: pipeline,
    repPreview: repCards.slice(0, 8),
    staleSummary: {
      staleDeals: staleDeals.length,
      staleLeads: staleLeads.length,
    },
  };
}

router.get("/director/summary", requireDirector, async (req, res, next) => {
  try {
    const data = await getDirectorDashboardSummary(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Add the admin summary route with bounded operational counts**

```ts
router.get("/admin/summary", requireAdmin, async (req, res, next) => {
  try {
    const data = await getAdminDashboardSummary(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Re-run the server summary tests**

Run: `npx vitest run --config server/vitest.config.ts server/tests/modules/dashboard/routes-summary.test.ts server/tests/modules/dashboard/service.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the summary contract split**

```bash
git add server/src/modules/dashboard/service.ts \
  server/src/modules/dashboard/routes.ts \
  server/tests/modules/dashboard/service.test.ts \
  server/tests/modules/dashboard/routes-summary.test.ts
git commit -m "feat: add fast-path dashboard summary endpoints"
```

## Task 2: Add Deal And Lead Board Preview Contracts Plus Paginated Stage Pages

**Files:**
- Modify: `server/src/modules/deals/service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Create: `server/tests/modules/deals/board-preview-service.test.ts`
- Create: `server/tests/modules/leads/board-preview-service.test.ts`
- Create: `server/tests/modules/deals/stage-page-service.test.ts`
- Create: `server/tests/modules/leads/stage-page-service.test.ts`

- [ ] **Step 1: Write failing tests for preview-limited boards and stage pagination**

```ts
describe("getDealsBoardPreview", () => {
  it("returns counts and only the first preview cards per stage", async () => {
    const result = await getDealsBoardPreview(db, "director", directorId, {
      includeDd: true,
      previewLimit: 8,
    });

    expect(result.columns[0]).toMatchObject({
      count: expect.any(Number),
      previewCards: expect.any(Array),
    });
    expect(result.columns[0].previewCards.length).toBeLessThanOrEqual(8);
  });
});

describe("getDealStagePage", () => {
  it("returns paginated stage rows and total pages", async () => {
    const result = await getDealStagePage(db, "stage-id", "director", directorId, {
      page: 2,
      limit: 25,
    });

    expect(result.pagination).toMatchObject({
      page: 2,
      limit: 25,
      totalPages: expect.any(Number),
    });
  });
});
```

- [ ] **Step 2: Run the board-preview and stage-page tests to verify they fail**

Run: `npx vitest run --config server/vitest.config.ts server/tests/modules/deals/board-preview-service.test.ts server/tests/modules/leads/board-preview-service.test.ts server/tests/modules/deals/stage-page-service.test.ts server/tests/modules/leads/stage-page-service.test.ts`

Expected: FAIL with missing service exports and route support.

- [ ] **Step 3: Implement preview-oriented board services for deals and leads**

```ts
export async function getDealsBoardPreview(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters: { assignedRepId?: string; includeDd?: boolean; previewLimit?: number } = {}
) {
  const previewLimit = filters.previewLimit ?? 8;
  const rows = await loadDealBoardRows(tenantDb, userRole, userId, filters);

  return {
    columns: buildBoardColumns(rows, previewLimit),
    terminalStages: buildTerminalSummaries(rows),
  };
}

export async function getLeadsBoardPreview(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters: { assignedRepId?: string; previewLimit?: number } = {}
) {
  const previewLimit = filters.previewLimit ?? 8;
  const rows = await loadLeadBoardRows(tenantDb, userRole, userId, filters);

  return {
    columns: buildLeadBoardColumns(rows, previewLimit),
  };
}
```

- [ ] **Step 4: Implement paginated stage-page services and routes**

```ts
router.get("/stages/:stageId", async (req, res, next) => {
  try {
    const data = await getDealStagePage(req.tenantDb!, req.params.stageId, req.user!.role, req.user!.id, {
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 25),
      search: req.query.search as string | undefined,
      sort: req.query.sort as string | undefined,
    });
    await req.commitTransaction!();
    res.json(data);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Re-run the new server tests**

Run: `npx vitest run --config server/vitest.config.ts server/tests/modules/deals/board-preview-service.test.ts server/tests/modules/leads/board-preview-service.test.ts server/tests/modules/deals/stage-page-service.test.ts server/tests/modules/leads/stage-page-service.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the preview and stage-page server contracts**

```bash
git add server/src/modules/deals/service.ts \
  server/src/modules/deals/routes.ts \
  server/src/modules/leads/service.ts \
  server/src/modules/leads/routes.ts \
  server/tests/modules/deals/board-preview-service.test.ts \
  server/tests/modules/leads/board-preview-service.test.ts \
  server/tests/modules/deals/stage-page-service.test.ts \
  server/tests/modules/leads/stage-page-service.test.ts
git commit -m "feat: add board preview and stage page contracts"
```

## Task 3: Add Client Hooks For Layered Loading And Shared Pipeline Data

**Files:**
- Create: `client/src/hooks/use-admin-dashboard-summary.ts`
- Create: `client/src/hooks/use-board-preview.ts`
- Create: `client/src/hooks/use-pipeline-stage-page.ts`
- Create: `client/src/lib/pipeline-stage-page.ts`
- Create: `client/src/hooks/use-admin-dashboard-summary.test.ts`
- Create: `client/src/lib/pipeline-stage-page.test.ts`
- Modify: `client/src/hooks/use-dashboard.ts`
- Modify: `client/src/hooks/use-director-dashboard.ts`
- Modify: `client/src/hooks/use-deals.ts`
- Modify: `client/src/hooks/use-leads.ts`

- [ ] **Step 1: Write failing client tests for the new query builders and summary hooks**

```ts
describe("buildPipelineStagePageSearch", () => {
  it("omits default pagination from the query string", () => {
    expect(buildPipelineStagePageSearch({ page: 1, limit: 25 })).toBe("");
  });

  it("includes search and sort when present", () => {
    expect(buildPipelineStagePageSearch({ page: 2, limit: 50, search: "roof", sort: "updated_desc" }))
      .toBe("?page=2&limit=50&search=roof&sort=updated_desc");
  });
});

describe("useAdminDashboardSummary", () => {
  it("loads the fast-path admin summary endpoint", async () => {
    server.use(http.get("/api/dashboard/admin/summary", () => HttpResponse.json({ data: fakeSummary })));
    const { result } = renderHook(() => useAdminDashboardSummary());
    await waitFor(() => expect(result.current.data).toEqual(fakeSummary));
  });
});
```

- [ ] **Step 2: Run the targeted client tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/hooks/use-admin-dashboard-summary.test.ts client/src/lib/pipeline-stage-page.test.ts`

Expected: FAIL with missing hooks and helpers.

- [ ] **Step 3: Implement the new shared client data hooks**

```ts
export function useBoardPreview(entity: "deals" | "leads", params: URLSearchParams) {
  const [data, setData] = useState<BoardPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<BoardPreviewResponse>(`/${entity}/board-preview${params.toString() ? `?${params}` : ""}`)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entity, params.toString()]);

  return { data, loading };
}
```

- [ ] **Step 4: Rewire the existing dashboard and board hooks to use summary-first contracts**

```ts
export function useDirectorDashboardSummary(dateRange?: { from: string; to: string }) {
  return useDashboardRequest<DirectorDashboardSummary>("/dashboard/director/summary", dateRange);
}

export function useDealBoardPreview(scope: PipelineScope, includeDd: boolean) {
  return useBoardPreview("deals", buildBoardPreviewParams({ scope, includeDd }));
}
```

- [ ] **Step 5: Re-run the targeted client tests**

Run: `npx vitest run --config client/vite.config.ts client/src/hooks/use-admin-dashboard-summary.test.ts client/src/lib/pipeline-stage-page.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the client data-layer changes**

```bash
git add client/src/hooks/use-admin-dashboard-summary.ts \
  client/src/hooks/use-board-preview.ts \
  client/src/hooks/use-pipeline-stage-page.ts \
  client/src/lib/pipeline-stage-page.ts \
  client/src/hooks/use-admin-dashboard-summary.test.ts \
  client/src/lib/pipeline-stage-page.test.ts \
  client/src/hooks/use-dashboard.ts \
  client/src/hooks/use-director-dashboard.ts \
  client/src/hooks/use-deals.ts \
  client/src/hooks/use-leads.ts
git commit -m "feat: add layered dashboard and pipeline hooks"
```

## Task 4: Split Home Routing And Add Lazy-Loaded Dashboard Entry Points

**Files:**
- Modify: `client/src/App.tsx`
- Create: `client/src/pages/dashboard/home-dashboard-page.tsx`
- Create: `client/src/pages/dashboard/admin-dashboard-page.tsx`
- Create: `client/src/pages/dashboard/home-dashboard-page.test.tsx`
- Create: `client/src/pages/dashboard/admin-dashboard-page.test.tsx`

- [ ] **Step 1: Write failing route tests for role-aware home routing**

```tsx
describe("HomeDashboardPage", () => {
  it("routes reps to the rep dashboard content", () => {
    renderWithRole("rep", <HomeDashboardPage />);
    expect(screen.getByText(/my board/i)).toBeInTheDocument();
  });

  it("routes admins to the admin dashboard content", () => {
    renderWithRole("admin", <HomeDashboardPage />);
    expect(screen.getByText(/needs attention/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/dashboard/home-dashboard-page.test.tsx client/src/pages/dashboard/admin-dashboard-page.test.tsx`

Expected: FAIL because the route entry page and admin dashboard do not exist.

- [ ] **Step 3: Implement the role-aware home entry page and lazy route imports**

```tsx
const RepDashboardPage = lazy(() => import("@/pages/dashboard/rep-dashboard-page").then((m) => ({ default: m.RepDashboardPage })));
const DirectorDashboardPage = lazy(() => import("@/pages/director/director-dashboard-page").then((m) => ({ default: m.DirectorDashboardPage })));
const AdminDashboardPage = lazy(() => import("@/pages/dashboard/admin-dashboard-page").then((m) => ({ default: m.AdminDashboardPage })));

function HomeDashboardPage() {
  const { user } = useAuth();
  if (user?.role === "rep") return <RepDashboardPage />;
  if (user?.role === "admin") return <AdminDashboardPage />;
  return <DirectorDashboardPage />;
}
```

- [ ] **Step 4: Add the admin dashboard shell with fast-path tiles and deferred panels**

```tsx
export function AdminDashboardPage() {
  const summary = useAdminDashboardSummary();

  return (
    <div className="space-y-6">
      <AdminKpiBand summary={summary.data} loading={summary.loading} />
      <AdminOperationsWorkspace summary={summary.data} loading={summary.loading} />
      <DeferredRecentActivity />
    </div>
  );
}
```

- [ ] **Step 5: Re-run the route tests**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/dashboard/home-dashboard-page.test.tsx client/src/pages/dashboard/admin-dashboard-page.test.tsx`

Expected: PASS

- [ ] **Step 6: Commit the route and home-page split**

```bash
git add client/src/App.tsx \
  client/src/pages/dashboard/home-dashboard-page.tsx \
  client/src/pages/dashboard/admin-dashboard-page.tsx \
  client/src/pages/dashboard/home-dashboard-page.test.tsx \
  client/src/pages/dashboard/admin-dashboard-page.test.tsx
git commit -m "feat: split role-aware home dashboards"
```

## Task 5: Rebuild Rep And Director Dashboards Around Layered Loading

**Files:**
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Modify: `client/src/pages/director/director-dashboard-page.tsx`
- Create: `client/src/components/dashboard/dashboard-section-shell.tsx`
- Create: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`
- Create: `client/src/pages/director/director-dashboard-page.test.tsx`

- [ ] **Step 1: Write failing page tests for section-level loading instead of page blocking**

```tsx
it("renders the rep dashboard shell before all secondary panels resolve", async () => {
  render(<RepDashboardPage />);
  expect(screen.getByRole("heading", { name: /my board/i })).toBeInTheDocument();
  expect(screen.getByTestId("dashboard-section-shell")).toBeInTheDocument();
});

it("renders the director KPI band and board shell before trends resolve", async () => {
  render(<DirectorDashboardPage />);
  expect(screen.getByRole("heading", { name: /director dashboard/i })).toBeInTheDocument();
  expect(screen.getByTestId("dashboard-section-shell")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the dashboard page tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx client/src/pages/director/director-dashboard-page.test.tsx`

Expected: FAIL because the current pages still gate on top-level `loading`.

- [ ] **Step 3: Implement stable section shells and summary-first rendering**

```tsx
export function DashboardSectionShell({ title, loading, children }: DashboardSectionShellProps) {
  return (
    <section data-testid="dashboard-section-shell" className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {loading ? <div className="h-32 rounded-xl bg-muted animate-pulse" /> : children}
    </section>
  );
}
```

- [ ] **Step 4: Refactor rep and director pages so Layer 2 renders first and charts/watchlists defer**

```tsx
const summary = useDirectorDashboardSummary(dateRange);
const trends = useDirectorDashboardSecondary(dateRange);

return (
  <div className="space-y-6">
    <DirectorKpiBand data={summary.data} loading={summary.loading} />
    <DashboardSectionShell title="Team Board" loading={board.loading}>
      <PipelineBoard {...boardProps} />
    </DashboardSectionShell>
    <DashboardSectionShell title="Performance Trends" loading={trends.loading}>
      <WinRateTrendChart data={trends.data?.winRateTrend ?? []} />
    </DashboardSectionShell>
  </div>
);
```

- [ ] **Step 5: Re-run the dashboard page tests**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx client/src/pages/director/director-dashboard-page.test.tsx`

Expected: PASS

- [ ] **Step 6: Commit the layered dashboard pages**

```bash
git add client/src/pages/dashboard/rep-dashboard-page.tsx \
  client/src/pages/director/director-dashboard-page.tsx \
  client/src/components/dashboard/dashboard-section-shell.tsx
git commit -m "feat: layer rep and director dashboard loading"
```

## Task 6: Unify Deals And Leads Around Shared Board And Stage Pages

**Files:**
- Create: `client/src/components/pipeline/pipeline-board.tsx`
- Create: `client/src/components/pipeline/pipeline-stage-table.tsx`
- Create: `client/src/components/pipeline/pipeline-board.test.tsx`
- Create: `client/src/components/pipeline/pipeline-stage-table.test.tsx`
- Create: `client/src/pages/deals/deal-stage-page.tsx`
- Create: `client/src/pages/leads/lead-stage-page.tsx`
- Create: `client/src/pages/deals/deal-stage-page.test.tsx`
- Create: `client/src/pages/leads/lead-stage-page.test.tsx`
- Modify: `client/src/pages/deals/deal-list-page.tsx`
- Modify: `client/src/pages/leads/lead-list-page.tsx`
- Modify: `client/src/pages/pipeline/pipeline-page.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Write failing shared-board and stage-page tests**

```tsx
describe("PipelineBoard", () => {
  it("shows preview cards and a view-all action when stage counts exceed previews", () => {
    render(<PipelineBoard entity="deals" columns={fixtureColumns} loading={false} />);
    expect(screen.getByText(/view all 23/i)).toBeInTheDocument();
  });
});

describe("DealStagePage", () => {
  it("renders paginated stage rows with a back-to-board link", async () => {
    renderRoute("/deals/stages/stage-a");
    expect(await screen.findByRole("link", { name: /back to deals/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the board and stage-page tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx`

Expected: FAIL because the shared board and stage-page routes do not exist.

- [ ] **Step 3: Implement the shared board shell with preview cards only**

```tsx
export function PipelineBoard({ entity, columns, loading, onStageOpen }: PipelineBoardProps) {
  return (
    <div className="flex gap-4 overflow-x-auto">
      {columns.map((column) => (
        <article key={column.stage.id} className="w-80 shrink-0">
          <button type="button" onClick={() => onStageOpen(column.stage.id)} className="w-full text-left">
            <div className="flex items-center justify-between">
              <span>{column.stage.name}</span>
              <span>{column.count}</span>
            </div>
            {column.totalValue != null ? <p>{formatCurrencyCompact(column.totalValue)}</p> : null}
          </button>
          <div className="space-y-2">
            {column.previewCards.map((card) => (
              <PipelinePreviewCard key={card.id} entity={entity} card={card} />
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement canonical stage pages and migrate `/pipeline` to redirect to `/deals`**

```tsx
<Route path="/pipeline" element={<Navigate to="/deals" replace />} />
<Route path="/deals/stages/:stageId" element={<DealStagePage />} />
<Route path="/leads/stages/:stageId" element={<LeadStagePage />} />
```

- [ ] **Step 5: Re-run the shared-board and stage-page tests**

Run: `npx vitest run --config client/vite.config.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx`

Expected: PASS

- [ ] **Step 6: Commit the shared board and stage-page UI**

```bash
git add client/src/components/pipeline/pipeline-board.tsx \
  client/src/components/pipeline/pipeline-stage-table.tsx \
  client/src/components/pipeline/pipeline-board.test.tsx \
  client/src/components/pipeline/pipeline-stage-table.test.tsx \
  client/src/pages/deals/deal-stage-page.tsx \
  client/src/pages/leads/lead-stage-page.tsx \
  client/src/pages/deals/deal-list-page.tsx \
  client/src/pages/leads/lead-list-page.tsx \
  client/src/pages/pipeline/pipeline-page.tsx \
  client/src/pages/deals/deal-stage-page.test.tsx \
  client/src/pages/leads/lead-stage-page.test.tsx \
  client/src/App.tsx
git commit -m "feat: unify deal and lead board workspaces"
```

## Task 7: Final Verification And Production-Readiness Sweep

**Files:**
- Modify: any touched files that need integration fixes after the full run

- [ ] **Step 1: Run the targeted client suite**

Run:

```bash
npx vitest run --config client/vite.config.ts \
  client/src/hooks/use-admin-dashboard-summary.test.ts \
  client/src/lib/pipeline-stage-page.test.ts \
  client/src/pages/dashboard/home-dashboard-page.test.tsx \
  client/src/pages/dashboard/admin-dashboard-page.test.tsx \
  client/src/pages/dashboard/rep-dashboard-page.test.tsx \
  client/src/pages/director/director-dashboard-page.test.tsx \
  client/src/components/pipeline/pipeline-board.test.tsx \
  client/src/components/pipeline/pipeline-stage-table.test.tsx \
  client/src/pages/deals/deal-stage-page.test.tsx \
  client/src/pages/leads/lead-stage-page.test.tsx
```

Expected: PASS

- [ ] **Step 2: Run the targeted server suite**

Run:

```bash
npx vitest run --config server/vitest.config.ts \
  server/tests/modules/dashboard/service.test.ts \
  server/tests/modules/dashboard/routes-summary.test.ts \
  server/tests/modules/deals/board-preview-service.test.ts \
  server/tests/modules/leads/board-preview-service.test.ts \
  server/tests/modules/deals/stage-page-service.test.ts \
  server/tests/modules/leads/stage-page-service.test.ts
```

Expected: PASS

- [ ] **Step 3: Run typechecks**

Run:

```bash
npm run typecheck --workspace=client
npm run typecheck --workspace=server
```

Expected: PASS

- [ ] **Step 4: Run a browser smoke pass on the critical routes**

Run:

```bash
bash /Users/adnaaniqbal/.codex/skills/playwright/scripts/playwright_cli.sh open
```

Verify:

- `/` loads as rep, admin, and director with meaningful first content visible quickly
- `/director` renders the Layer 2 workspace before trend panels
- `/deals` renders preview-limited columns and stage click-through
- `/leads` renders the matching preview-limited board
- `/deals/stages/:stageId` and `/leads/stages/:stageId` paginate and link back correctly
- drag-and-drop still works on boards only

- [ ] **Step 5: Commit any final integration fixes**

```bash
git add client/src server/src
git commit -m "fix: polish dashboard and pipeline performance pass"
```
