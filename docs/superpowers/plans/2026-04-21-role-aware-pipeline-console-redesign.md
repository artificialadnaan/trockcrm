# Role-Aware Pipeline Console Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split lead/deal/list/dashboard experience with role-aware home surfaces, canonical lead/deal boards, and dedicated paginated stage pages while preserving all existing stage-gate and conversion behavior.

**Architecture:** Build one shared pipeline workspace system with canonical `/leads` and `/deals` board routes, dedicated stage-detail routes, and role-scoped data shaping behind reusable client hooks. Keep movement logic anchored in the existing deal stage-gate and lead conversion services, and layer the rep, director, and admin dashboards on top of those canonical workspaces rather than inventing parallel pipeline implementations.

**Tech Stack:** React, TypeScript, React Router, DnD Kit, Express, Drizzle ORM, Vitest, Testing Library

---

## File Structure

### Route and page surface

- Modify: `client/src/App.tsx`
  - Add canonical board routes, stage-detail routes, and role-aware home routing.
- Create: `client/src/pages/dashboard/home-dashboard-page.tsx`
  - Resolve the role-specific home page entry point.
- Create: `client/src/pages/dashboard/admin-dashboard-page.tsx`
  - Minimal admin home stub first, then the full admin console with operational summary tiles and secondary board entry points.
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
  - Rep home becomes board-first with `Deals | Leads` segmented switching.
- Modify: `client/src/pages/director/director-dashboard-page.tsx`
  - Director home becomes a board-first operator console with secondary analytics.
- Modify: `client/src/pages/deals/deal-list-page.tsx`
  - Convert `/deals` into the canonical deals board surface.
- Modify: `client/src/pages/leads/lead-list-page.tsx`
  - Convert `/leads` into the canonical leads board surface.
- Create: `client/src/pages/deals/deal-stage-page.tsx`
  - Paginated deal stage inspection page.
- Create: `client/src/pages/leads/lead-stage-page.tsx`
  - Paginated lead stage inspection page.
- Modify: `client/src/pages/pipeline/pipeline-page.tsx`
  - Reduce to redirect/compatibility behavior or thin wrapper during migration.
- Modify: `client/src/components/layout/sidebar.tsx`
  - Retarget pipeline navigation to the canonical deals board.
- Modify: `client/src/components/layout/mobile-nav.tsx`
  - Retarget mobile pipeline navigation to the canonical deals board.

### Client hooks and helpers

- Create: `client/src/lib/pipeline-scope.ts`
  - Normalize `scope`, board tab, and role-authorized route behavior.
- Create: `client/src/lib/pipeline-stage-page.ts`
  - Shared sort/filter parsing for stage pages.
- Create: `client/src/lib/admin-dashboard-summary.ts`
  - Convert the admin summary payload into bounded operation tiles.
- Create: `client/src/hooks/use-pipeline-board-state.ts`
  - Shared board page UI state for search, selected tab, and route sync.
- Modify: `client/src/hooks/use-leads.ts`
  - Add board payload, stage-page payload, and conversion helpers without breaking lead detail.
- Modify: `client/src/hooks/use-deals.ts`
  - Add board payload, stage-page payload, and route-scoped helpers without breaking existing detail/scoping flows.
- Create: `client/src/hooks/use-admin-dashboard-summary.ts`
  - Aggregate bounded admin tile data from existing workspaces.

### Shared UI primitives

- Create: `client/src/components/pipeline/pipeline-board.tsx`
  - Shared board layout, column rendering, and stage click contract.
- Create: `client/src/components/pipeline/pipeline-board-column.tsx`
  - Shared column header, count/summary row, and droppable region.
- Create: `client/src/components/pipeline/pipeline-record-card.tsx`
  - Shared lead/deal card shell with entity-specific detail slots.
- Create: `client/src/components/pipeline/pipeline-stage-table.tsx`
  - Shared paginated stage table for leads and deals.
- Create: `client/src/components/pipeline/pipeline-stage-page-header.tsx`
  - Breadcrumb/back-link header using normalized canonical routes.
- Create: `client/src/components/pipeline/pipeline-board-switcher.tsx`
  - `Deals | Leads` segmented switcher used by rep and director home.
- Create: `client/src/components/leads/lead-conversion-dialog.tsx`
  - Existing lead conversion flow rendered from the lead board conversion boundary.
- Create: `client/src/components/dashboard/admin-operations-workspace.tsx`
  - Summary tile grid with CTA links for admin modules.
- Create: `client/src/components/dashboard/rep-dashboard-board-shell.tsx`
  - Rep board hero, tasks strip, and secondary summary modules.
- Create: `client/src/components/dashboard/director-dashboard-shell.tsx`
  - Director board hero, congestion watch, and secondary analytics bands.
- Modify: `client/src/components/leads/lead-stage-badge.tsx`
  - Align stage badge visual language with the shared workflow system.
- Modify: `client/src/components/deals/deal-stage-badge.tsx`
  - Align stage badge visual language with the shared workflow system.

### Server contracts

- Modify: `server/src/modules/leads/routes.ts`
  - Add board and stage-page endpoints with pagination and role-aware scope validation.
- Modify: `server/src/modules/leads/service.ts`
  - Add board grouping, stage-page pagination, and active-office scoping.
- Modify: `server/src/modules/deals/routes.ts`
  - Add stage-page endpoint and canonical board-scoped pipeline endpoint support.
- Modify: `server/src/modules/deals/service.ts`
  - Add board payload helpers and stage-page pagination/search/filter support.
- Modify: `server/src/modules/dashboard/service.ts`
  - Add admin summary composition and rep/director board-first summary helpers.
- Modify: `server/src/modules/dashboard/routes.ts`
  - Expose new admin dashboard summary endpoint if needed.

### Tests

- Create: `client/src/lib/pipeline-scope.test.ts`
- Create: `client/src/lib/pipeline-stage-page.test.ts`
- Create: `client/src/hooks/use-admin-dashboard-summary.test.ts`
- Create: `client/src/components/pipeline/pipeline-board.test.tsx`
- Create: `client/src/components/pipeline/pipeline-stage-table.test.tsx`
- Create: `client/src/components/dashboard/admin-operations-workspace.test.tsx`
- Create: `client/src/pages/dashboard/home-dashboard-page.test.tsx`
- Create: `client/src/pages/dashboard/admin-dashboard-page.test.tsx`
- Create: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`
- Create: `client/src/pages/director/director-dashboard-page.test.tsx`
- Create: `client/src/pages/leads/lead-stage-page.test.tsx`
- Create: `client/src/pages/deals/deal-stage-page.test.tsx`
- Create: `server/tests/modules/leads/board-service.test.ts`
- Create: `server/tests/modules/deals/stage-page-service.test.ts`

## Task 1: Route And Scope Foundation

**Files:**
- Modify: `client/src/App.tsx`
- Create: `client/src/lib/pipeline-scope.ts`
- Create: `client/src/pages/dashboard/home-dashboard-page.tsx`
- Create: `client/src/pages/dashboard/admin-dashboard-page.tsx`
- Test: `client/src/lib/pipeline-scope.test.ts`
- Test: `client/src/pages/dashboard/home-dashboard-page.test.tsx`

- [ ] **Step 1: Write the failing scope-normalization and home-routing tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizePipelineScope } from "./pipeline-scope";

describe("normalizePipelineScope", () => {
  it("redirects reps to mine scope when team is requested", () => {
    expect(normalizePipelineScope({ role: "rep", requestedScope: "team", entity: "deals" })).toEqual({
      allowedScope: "mine",
      redirectTo: "/deals?scope=mine",
    });
  });

  it("keeps directors on team scope when no scope is provided", () => {
    expect(normalizePipelineScope({ role: "director", requestedScope: null, entity: "leads" })).toEqual({
      allowedScope: "team",
      redirectTo: "/leads?scope=team",
    });
  });
});
```

```tsx
it("routes admins to the admin dashboard home surface", async () => {
  mockAuth("admin");
  render(<HomeDashboardPage />);
  expect(await screen.findByText("Operations Console")).toBeInTheDocument();
});

it("redirects rep deep links to the canonical mine scope before render", async () => {
  mockAuth("rep");
  renderWithRouter(<DealListPage />, { route: "/deals?scope=team" });
  expect(mockNavigate).toHaveBeenCalledWith("/deals?scope=mine", { replace: true });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/lib/pipeline-scope.test.ts client/src/pages/dashboard/home-dashboard-page.test.tsx
```

Expected: FAIL because `pipeline-scope.ts` and `home-dashboard-page.tsx` do not exist yet.

- [ ] **Step 3: Implement scope normalization and role-aware home entry**

```ts
const ROLE_DEFAULT_SCOPE = { rep: "mine", director: "team", admin: "all" } as const;

export function normalizePipelineScope(input: {
  role: "rep" | "director" | "admin";
  requestedScope: "mine" | "team" | "all" | null;
  entity: "leads" | "deals";
}) {
  const allowedScope = ROLE_DEFAULT_SCOPE[input.role];
  const nextScope = input.requestedScope === allowedScope ? allowedScope : allowedScope;
  return {
    allowedScope: nextScope,
    redirectTo: `/${input.entity}?scope=${nextScope}`,
  };
}
```

```tsx
export function HomeDashboardPage() {
  const { user } = useAuth();
  if (user?.role === "rep") return <RepDashboardPage />;
  if (user?.role === "admin") return <AdminDashboardPage />;
  return <DirectorDashboardPage />;
}
```

```ts
export function useNormalizedPipelineRoute(entity: "leads" | "deals") {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const normalized = normalizePipelineScope({
    role: user!.role as "rep" | "director" | "admin",
    requestedScope: (searchParams.get("scope") as "mine" | "team" | "all" | null) ?? null,
    entity,
  });
  return {
    ...normalized,
    needsRedirect: searchParams.get("scope") !== normalized.allowedScope,
  };
}

export function useNormalizedStageRoute(entity: "leads" | "deals", stageId: string) {
  const normalized = useNormalizedPipelineRoute(entity);
  const [searchParams, setSearchParams] = useSearchParams();
  return {
    stageId,
    needsRedirect: normalized.needsRedirect,
    redirectTo: `/${entity}/stages/${stageId}?${new URLSearchParams({ ...Object.fromEntries(searchParams.entries()), scope: normalized.allowedScope }).toString()}`,
    query: {
      ...normalizeStagePageQuery(Object.fromEntries(searchParams.entries())),
      scope: normalized.allowedScope,
    },
    backTo: `/${entity}?scope=${normalized.allowedScope}`,
    onPageChange: (page: number) => setSearchParams((current) => ({ ...Object.fromEntries(current.entries()), page: String(page) })),
  };
}
```

```tsx
export function AdminDashboardPage() {
  return <div>Operations Console</div>;
}
```

- [ ] **Step 4: Wire the app routes to use canonical home and board paths**

```tsx
function BoardAliasRedirect({ entity }: { entity: "leads" | "deals" }) {
  const [searchParams] = useSearchParams();
  return <Navigate to={`/${entity}?${searchParams.toString()}`} replace />;
}

<Route path="/" element={<HomeDashboardPage />} />
<Route path="/leads" element={<LeadListPage />} />
<Route path="/deals" element={<DealListPage />} />
<Route path="/pipeline" element={<PipelinePage />} />
<Route path="/leads/stages/:stageId" element={<LeadStagePage />} />
<Route path="/deals/stages/:stageId" element={<DealStagePage />} />
<Route path="/leads/board" element={<BoardAliasRedirect entity="leads" />} />
<Route path="/deals/board" element={<BoardAliasRedirect entity="deals" />} />
```

- [ ] **Step 5: Re-run the focused tests**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/lib/pipeline-scope.test.ts client/src/pages/dashboard/home-dashboard-page.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the route-and-scope foundation**

```bash
git add client/src/App.tsx client/src/lib/pipeline-scope.ts client/src/lib/pipeline-scope.test.ts client/src/pages/dashboard/home-dashboard-page.tsx client/src/pages/dashboard/admin-dashboard-page.tsx client/src/pages/dashboard/home-dashboard-page.test.tsx
git commit -m "feat: add pipeline scope normalization and home routing"
```

## Task 2: Server Contracts For Lead And Deal Workspaces

**Files:**
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/src/modules/deals/service.ts`
- Test: `server/tests/modules/leads/board-service.test.ts`
- Test: `server/tests/modules/deals/stage-page-service.test.ts`

- [ ] **Step 1: Write failing service tests for board grouping and paginated stage pages**

```ts
it("returns lead board columns grouped by active office stage with ordered cards", async () => {
  const result = await listLeadBoard(db, {
    role: "director",
    userId: "director-1",
    activeOfficeId: "office-1",
    scope: "team",
  });

  expect(result.columns[0]).toMatchObject({
    stage: { slug: "contacted" },
    count: 2,
  });
});

it("excludes records outside the active office even for admin all scope", async () => {
  const result = await listLeadBoard(db, {
    role: "admin",
    userId: "admin-1",
    activeOfficeId: "office-1",
    scope: "all",
  });

  expect(result.columns.flatMap((column) => column.cards).every((card) => card.officeId === "office-1")).toBe(true);
});
```

```ts
it("returns paginated deal rows for one stage with normalized sort", async () => {
  const result = await listDealStagePage(db, {
    role: "admin",
    userId: "admin-1",
    activeOfficeId: "office-1",
    scope: "all",
    stageId: "stage-estimating",
    page: 2,
    pageSize: 25,
    sort: "value_desc",
  });

  expect(result.pagination).toMatchObject({ page: 2, pageSize: 25 });
});
```

- [ ] **Step 2: Run the server tests to verify they fail**

Run:

```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/leads/board-service.test.ts server/tests/modules/deals/stage-page-service.test.ts
```

Expected: FAIL because the board/stage-page helpers and routes do not exist.

- [ ] **Step 3: Add lead board and lead stage-page service functions**

```ts
// server/src/modules/leads/service.ts
// pipeline_stage_config is global in this codebase; active-office scoping applies to the lead rows,
// not to the destination stage catalog.
async function getDefaultConversionDealStageId(tenantDb: TenantDb) {
  const [stage] = await tenantDb.select({ id: pipelineStageConfig.id }).from(pipelineStageConfig).where(
    and(
      eq(pipelineStageConfig.workflowFamily, "standard_deal"),
      eq(pipelineStageConfig.isActivePipeline, true)
    )
  ).orderBy(asc(pipelineStageConfig.displayOrder)).limit(1);
  return stage?.id ?? null;
}

export async function listLeadBoard(
  tenantDb: TenantDb,
  input: { role: string; userId: string; activeOfficeId: string; scope: "mine" | "team" | "all" }
) {
  const scopedRows = await fetchScopedLeadRows(tenantDb, input);
  const defaultConversionDealStageId = await getDefaultConversionDealStageId(tenantDb);
  return {
    columns: groupLeadRowsByStage(scopedRows),
    defaultConversionDealStageId,
  };
}

export async function listLeadStagePage(
  tenantDb: TenantDb,
  input: LeadStagePageInput
) {
  const query = buildLeadStagePageQuery(tenantDb, input);
  const page = await paginateLeadStageRows(query, input);
  return {
    stage: page.stage,
    scope: input.scope,
    summary: page.summary,
    pagination: page.pagination,
    rows: page.rows,
  };
}
```

- [ ] **Step 4: Add deal stage-page support without disturbing existing deal list APIs**

```ts
// server/src/modules/deals/service.ts
export async function listDealBoard(
  tenantDb: TenantDb,
  input: { role: string; userId: string; activeOfficeId: string; scope: "mine" | "team" | "all"; includeDd: boolean }
) {
  return getDealsForPipeline(tenantDb, input.role, input.userId, {
    assignedRepId: input.scope === "mine" ? input.userId : undefined,
    includeDd: input.includeDd,
    activeOfficeId: input.activeOfficeId,
  });
}

export async function listDealStagePage(
  tenantDb: TenantDb,
  input: DealStagePageInput
) {
  const baseQuery = buildScopedDealQuery(tenantDb, input);
  const page = await paginateDealStageRows(baseQuery, input);
  return {
    stage: page.stage,
    scope: input.scope,
    summary: page.summary,
    pagination: page.pagination,
    rows: page.rows,
  };
}
```

- [ ] **Step 5: Expose explicit lead and deal workspace routes with full filter ownership**

```ts
function readBoardInput(req: Request) {
  return {
    role: req.user!.role,
    userId: req.user!.id,
    activeOfficeId: req.user!.activeOfficeId,
    scope: req.query.scope as "mine" | "team" | "all",
    includeDd: req.query.includeDd === "true",
  };
}

function readStageInput(req: Request) {
  return {
    ...readBoardInput(req),
    stageId: req.params.stageId,
    page: Number(req.query.page ?? 1),
    pageSize: Number(req.query.pageSize ?? 25),
    search: req.query.search as string | undefined,
    sort: req.query.sort as string | undefined,
    assignedRepId: req.query.assignedRepId as string | undefined,
    staleOnly: req.query.staleOnly === "true",
    status: req.query.status as string | undefined,
    workflowRoute: req.query.workflowRoute as string | undefined,
    source: req.query.source as string | undefined,
  };
}

// server/src/modules/leads/routes.ts
leadRouter.get("/board", async (req, res) => {
  const board = await listLeadBoard(req.tenantDb!, readBoardInput(req));
  res.json(board);
});

leadRouter.get("/stages/:stageId", async (req, res) => {
  const stagePage = await listLeadStagePage(req.tenantDb!, readStageInput(req));
  res.json(stagePage);
});

// server/src/modules/deals/routes.ts
dealRouter.get("/pipeline", async (req, res) => {
  const board = await listDealBoard(req.tenantDb!, {
    ...readBoardInput(req),
    includeDd: req.query.includeDd === "true",
  });
  res.json(board);
});

dealRouter.get("/stages/:stageId", async (req, res) => {
  const stagePage = await listDealStagePage(req.tenantDb!, readStageInput(req));
  res.json(stagePage);
});
```

- [ ] **Step 6: Re-run the focused server tests**

Run:

```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/leads/board-service.test.ts server/tests/modules/deals/stage-page-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the workspace contracts**

```bash
git add server/src/modules/leads/routes.ts server/src/modules/leads/service.ts server/src/modules/deals/routes.ts server/src/modules/deals/service.ts server/tests/modules/leads/board-service.test.ts server/tests/modules/deals/stage-page-service.test.ts
git commit -m "feat: add pipeline board and stage page contracts"
```

## Task 3: Shared Client Hooks And Pipeline Primitives

**Files:**
- Create: `client/src/lib/pipeline-stage-page.ts`
- Create: `client/src/hooks/use-pipeline-board-state.ts`
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/hooks/use-deals.ts`
- Create: `client/src/components/pipeline/pipeline-board.tsx`
- Create: `client/src/components/pipeline/pipeline-board-column.tsx`
- Create: `client/src/components/pipeline/pipeline-record-card.tsx`
- Create: `client/src/components/pipeline/pipeline-stage-table.tsx`
- Create: `client/src/components/pipeline/pipeline-stage-page-header.tsx`
- Test: `client/src/lib/pipeline-stage-page.test.ts`
- Test: `client/src/components/pipeline/pipeline-board.test.tsx`
- Test: `client/src/components/pipeline/pipeline-stage-table.test.tsx`

- [ ] **Step 1: Write failing tests for stage sort/filter parsing and shared board interactions**

```ts
it("normalizes an invalid stage sort back to age_desc", () => {
  expect(normalizeStagePageQuery({ sort: "bad", page: "wat", search: "acme", staleOnly: "true", workflowRoute: "service" })).toEqual({
    page: 1,
    pageSize: 25,
    sort: "age_desc",
    search: "acme",
    filters: {
      assignedRepId: undefined,
      staleOnly: true,
      status: undefined,
      workflowRoute: "service",
      source: undefined,
    },
  });
});
```

```tsx
it("fires onOpenStage when a column header is clicked", async () => {
  const onOpenStage = vi.fn();
  render(<PipelineBoard entity="deal" columns={columns} onOpenStage={onOpenStage} onOpenRecord={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /estimating/i }));
  expect(onOpenStage).toHaveBeenCalledWith("stage-estimating");
});
```

- [ ] **Step 2: Run the focused client tests to verify they fail**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/lib/pipeline-stage-page.test.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx
```

Expected: FAIL because the parser and pipeline components do not exist yet.

- [ ] **Step 3: Add shared query/state helpers**

```ts
export function normalizeStagePageQuery(input: Record<string, string | undefined>) {
  return {
    page: Number.isFinite(Number(input.page)) ? Math.max(1, Number(input.page)) : 1,
    pageSize: [25, 50, 100].includes(Number(input.pageSize)) ? Number(input.pageSize) : 25,
    sort: ALLOWED_STAGE_SORTS.has(input.sort ?? "") ? input.sort! : "age_desc",
    search: input.search?.trim() ?? "",
    filters: {
      assignedRepId: input.assignedRepId,
      staleOnly: input.staleOnly === "true",
      status: input.status,
      workflowRoute: input.workflowRoute,
      source: input.source,
    },
  };
}
```

```ts
export function usePipelineBoardState(defaultEntity: "deals" | "leads") {
  const [activeEntity, setActiveEntity] = useState<"deals" | "leads">(
    () => (sessionStorage.getItem("pipeline-board-entity") as "deals" | "leads" | null) ?? defaultEntity
  );
  const [search, setSearch] = useState("");
  useEffect(() => {
    sessionStorage.setItem("pipeline-board-entity", activeEntity);
  }, [activeEntity]);
  return { activeEntity, setActiveEntity, search, setSearch };
}
```

- [ ] **Step 4: Extend lead and deal hooks with board/stage-page consumers**

```ts
export function useLeadBoard(scope: "mine" | "team" | "all") {
  const [board, setBoard] = useState<LeadBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refetch = useCallback(() => {
    setLoading(true);
    void api<LeadBoardResponse>(`/leads/board?scope=${scope}`).then((result) => {
      setBoard(result);
      setLoading(false);
    });
  }, [scope]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  async function convertLead(input: { leadId: string; dealStageId: string; workflowRoute: "estimating" | "service" }) {
    return api(`/leads/${input.leadId}/convert`, { method: "POST", json: input });
  }
  return { board, loading, convertLead, refetch };
}

export function useLeadStagePage(input: LeadStagePageQuery) {
  const [data, setData] = useState<LeadStagePageResponse | null>(null);
  useEffect(() => {
    const params = new URLSearchParams({
      scope: input.scope,
      page: String(input.page),
      pageSize: String(input.pageSize),
      sort: input.sort,
      search: input.search,
      ...(input.filters.assignedRepId ? { assignedRepId: input.filters.assignedRepId } : {}),
      ...(input.filters.staleOnly ? { staleOnly: "true" } : {}),
      ...(input.filters.status ? { status: input.filters.status } : {}),
      ...(input.filters.workflowRoute ? { workflowRoute: input.filters.workflowRoute } : {}),
      ...(input.filters.source ? { source: input.filters.source } : {}),
    });
    void api<LeadStagePageResponse>(`/leads/stages/${input.stageId}?${params.toString()}`).then(setData);
  }, [input.filters.assignedRepId, input.filters.source, input.filters.staleOnly, input.filters.status, input.filters.workflowRoute, input.page, input.pageSize, input.scope, input.search, input.sort, input.stageId]);
  return { data };
}
```

```ts
export function useDealBoard(scope: "mine" | "team" | "all", includeDd: boolean) {
  const [board, setBoard] = useState<DealBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refetch = useCallback(() => {
    setLoading(true);
    void api<DealBoardResponse>(`/deals/pipeline?scope=${scope}&includeDd=${includeDd}`).then((result) => {
      setBoard(result);
      setLoading(false);
    });
  }, [includeDd, scope]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  return { board, loading, refetch };
}

export function useDealStagePage(input: DealStagePageQuery) {
  const [data, setData] = useState<DealStagePageResponse | null>(null);
  useEffect(() => {
    const params = new URLSearchParams({
      scope: input.scope,
      page: String(input.page),
      pageSize: String(input.pageSize),
      sort: input.sort,
      search: input.search,
      ...(input.filters.assignedRepId ? { assignedRepId: input.filters.assignedRepId } : {}),
      ...(input.filters.staleOnly ? { staleOnly: "true" } : {}),
      ...(input.filters.status ? { status: input.filters.status } : {}),
      ...(input.filters.workflowRoute ? { workflowRoute: input.filters.workflowRoute } : {}),
      ...(input.filters.source ? { source: input.filters.source } : {}),
    });
    void api<DealStagePageResponse>(`/deals/stages/${input.stageId}?${params.toString()}`).then(setData);
  }, [input.filters.assignedRepId, input.filters.source, input.filters.staleOnly, input.filters.status, input.filters.workflowRoute, input.page, input.pageSize, input.scope, input.search, input.sort, input.stageId]);
  return { data };
}
```

- [ ] **Step 5: Build the shared board and stage-table primitives**

```tsx
export function PipelineBoard({ entity, columns, loading, onOpenStage, onOpenRecord, onMove }: PipelineBoardProps) {
  if (loading) return <div>Loading board…</div>;
  return (
    <DndContext onDragEnd={onMove}>
      {columns.map((column) => (
        <PipelineBoardColumn
          key={column.stage.id}
          entity={entity}
          column={column}
          onOpenStage={() => onOpenStage(column.stage.id)}
          onOpenRecord={onOpenRecord}
        />
      ))}
    </DndContext>
  );
}
```

```tsx
export function PipelineStageTable<T extends PipelineStageRow>({ rows, pagination, onPageChange }: PipelineStageTableProps<T>) {
  return (
    <>
      <Table>{/* entity-specific columns injected by parent */}</Table>
      <PaginationControls pagination={pagination} onPageChange={onPageChange} />
    </>
  );
}
```

- [ ] **Step 6: Re-run the focused client tests**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/lib/pipeline-stage-page.test.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the shared workspace layer**

```bash
git add client/src/lib/pipeline-stage-page.ts client/src/lib/pipeline-stage-page.test.ts client/src/hooks/use-pipeline-board-state.ts client/src/hooks/use-leads.ts client/src/hooks/use-deals.ts client/src/components/pipeline/pipeline-board.tsx client/src/components/pipeline/pipeline-board-column.tsx client/src/components/pipeline/pipeline-record-card.tsx client/src/components/pipeline/pipeline-stage-table.tsx client/src/components/pipeline/pipeline-stage-page-header.tsx client/src/components/pipeline/pipeline-board.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx
git commit -m "feat: add shared pipeline workspace primitives"
```

## Task 4: Deals Board Migration And Stage Page

**Files:**
- Modify: `client/src/pages/deals/deal-list-page.tsx`
- Create: `client/src/pages/deals/deal-stage-page.tsx`
- Modify: `client/src/pages/pipeline/pipeline-page.tsx`
- Modify: `client/src/components/layout/sidebar.tsx`
- Modify: `client/src/components/layout/mobile-nav.tsx`
- Test: `client/src/pages/deals/deal-stage-page.test.tsx`

- [ ] **Step 1: Write failing tests for canonical deals board behavior**

```tsx
it("renders the deals board at /deals and opens a dedicated stage page from the column header", async () => {
  mockDealBoard();
  renderWithRouter(<DealListPage />, { route: "/deals?scope=team" });
  expect(await screen.findByText("Deals Board")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /estimating/i }));
  expect(mockNavigate).toHaveBeenCalledWith("/deals/stages/stage-estimating?scope=team");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-stage-page.test.tsx
```

Expected: FAIL because the dedicated stage page does not exist and `/deals` is still list-first.

- [ ] **Step 3: Rebuild `/deals` as the canonical deals board**

```tsx
export function DealListPage() {
  const navigate = useNavigate();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("deals");
  const { board, loading, refetch: refetchBoard } = useDealBoard(scope, true);
  const [pendingMove, setPendingMove] = useState<{ dealId: string; targetStageId: string } | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const selectedDeal = board?.columns.flatMap((column) => column.cards).find((deal) => deal.id === pendingMove?.dealId) ?? null;
  if (needsRedirect) return <Navigate to={redirectTo} replace />;
  const handleDealMove = ({ activeId, targetStageId }: { activeId: string; targetStageId: string }) => {
    setPendingMove({ dealId: activeId, targetStageId });
    setStageChangeOpen(true);
  };
  return (
    <>
      <h1>Deals Board</h1>
      <PipelineBoard
        entity="deal"
        loading={loading}
        columns={board?.columns ?? []}
        onOpenStage={(stageId) => navigate(`/deals/stages/${stageId}?scope=${scope}`)}
        onOpenRecord={(dealId) => navigate(`/deals/${dealId}`)}
        onMove={handleDealMove}
      />
      {selectedDeal && pendingMove ? (
        <StageChangeDialog
          open={stageChangeOpen}
          deal={selectedDeal}
          targetStageId={pendingMove.targetStageId}
          onOpenChange={setStageChangeOpen}
          onSuccess={() => {
            setStageChangeOpen(false);
            void refetchBoard();
          }}
        />
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Add the paginated deal stage page**

```tsx
export function DealStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  const { data } = useDealStagePage({ stageId: stageId!, ...route.query });
  if (!data) return <div>Loading stage…</div>;
  return (
    <PipelineStagePageHeader backTo={route.backTo} title={data.stage.name}>
      <PipelineStageTable rows={data.rows} pagination={data.pagination} onPageChange={route.onPageChange} />
    </PipelineStagePageHeader>
  );
}
```

- [ ] **Step 5: Convert `/pipeline` into compatibility navigation**

```tsx
export function PipelinePage() {
  return <Navigate to="/deals" replace />;
}
```

- [ ] **Step 5a: Retarget sidebar and mobile navigation to the canonical deals board**

```tsx
{ to: "/deals", icon: Kanban, label: "Pipeline", roles: ["admin", "director", "rep"] }
```

```tsx
{ to: "/deals", icon: Kanban, label: "Pipeline" }
```

- [ ] **Step 6: Re-run the focused deals tests**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-stage-page.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the deals board migration**

```bash
git add client/src/pages/deals/deal-list-page.tsx client/src/pages/deals/deal-stage-page.tsx client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/pipeline/pipeline-page.tsx client/src/components/layout/sidebar.tsx client/src/components/layout/mobile-nav.tsx
git commit -m "feat: migrate deals to canonical board routes"
```

## Task 5: Leads Board Migration And Conversion Boundary

**Files:**
- Modify: `client/src/pages/leads/lead-list-page.tsx`
- Create: `client/src/pages/leads/lead-stage-page.tsx`
- Modify: `client/src/hooks/use-leads.ts`
- Create: `client/src/components/leads/lead-conversion-dialog.tsx`
- Test: `client/src/pages/leads/lead-stage-page.test.tsx`

- [ ] **Step 1: Write failing tests for lead board and conversion-boundary behavior**

```tsx
it("opens the lead conversion flow only when a card is dropped into the converted stage", async () => {
  mockLeadBoard();
  render(<LeadListPage />);
  await dragCard("lead-1", "stage-converted");
  expect(await screen.findByRole("dialog", { name: /Convert Lead/i })).toBeInTheDocument();
  expect(screen.getByDisplayValue("deal-stage-estimating-1")).toBeInTheDocument();
});
```

```tsx
it("renders a paginated lead stage page with a canonical back link", async () => {
  renderWithRouter(<LeadStagePage />, { route: "/leads/stages/stage-contacted?scope=mine" });
  expect(await screen.findByRole("link", { name: /back to leads board/i })).toHaveAttribute("href", "/leads?scope=mine");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-stage-page.test.tsx
```

Expected: FAIL because lead board drag behavior and stage pages are not implemented.

- [ ] **Step 3: Rebuild `/leads` as the canonical lead board**

```tsx
export function LeadListPage() {
  const navigate = useNavigate();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("leads");
  const { board, loading, convertLead, refetch } = useLeadBoard(scope);
  if (needsRedirect) return <Navigate to={redirectTo} replace />;
  const [conversionLeadId, setConversionLeadId] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const handleLeadBoardMove = ({ activeId, targetStageId, targetStageSlug }: { activeId: string; targetStageId: string; targetStageSlug: string }) => {
    return handleLeadDrop(
      { leadId: activeId, targetStageId, targetStageSlug },
      board?.defaultConversionDealStageId ?? null,
      { refetch, setConversionError, setConversionLeadId }
    );
  };
  return (
    <>
      <h1>Leads Board</h1>
      {conversionError ? <p role="alert">{conversionError}</p> : null}
      <PipelineBoard
        entity="lead"
        columns={board?.columns ?? []}
        loading={loading}
        onOpenStage={(stageId) => navigate(`/leads/stages/${stageId}?scope=${scope}`)}
        onOpenRecord={(leadId) => navigate(`/leads/${leadId}`)}
        onMove={handleLeadBoardMove}
      />
      <LeadConversionDialog
        leadId={conversionLeadId}
        defaultDealStageId={board?.defaultConversionDealStageId ?? null}
        defaultWorkflowRoute="estimating"
        onConfirm={async (input) => {
          await convertLead(input);
          await refetch();
          setConversionLeadId(null);
        }}
        onOpenChange={(open) => {
          if (!open) setConversionLeadId(null);
        }}
      />
    </>
  );
}
```

- [ ] **Step 4: Implement conversion-boundary behavior around the `converted` stage slug**

```ts
async function moveLeadToStage(leadId: string, targetStageId: string, refetch: () => Promise<unknown> | void) {
  const result = await api(`/leads/${leadId}`, { method: "PATCH", json: { stageId: targetStageId } });
  await refetch();
  return result;
}

function handleLeadDrop(
  input: { leadId: string; targetStageId: string; targetStageSlug: string },
  defaultConversionDealStageId: string | null,
  controls: {
    refetch: () => Promise<unknown> | void;
    setConversionError: (value: string | null) => void;
    setConversionLeadId: (value: string | null) => void;
  }
) {
  if (input.targetStageSlug !== "converted") return moveLeadToStage(input.leadId, input.targetStageId, controls.refetch);
  if (!defaultConversionDealStageId) return controls.setConversionError("No default deal stage configured");
  return controls.setConversionLeadId(input.leadId);
}

export function LeadConversionDialog(props: {
  leadId: string | null;
  defaultDealStageId: string | null;
  defaultWorkflowRoute: "estimating" | "service";
  onConfirm: (input: { leadId: string; dealStageId: string; workflowRoute: "estimating" | "service" }) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
}) {
  if (!props.leadId || !props.defaultDealStageId) return null;
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogTitle>Convert Lead</DialogTitle>
        <Label htmlFor="dealStageId">Deal Stage</Label>
        <Input id="dealStageId" value={props.defaultDealStageId} readOnly />
        <Button
          onClick={() =>
            props.onConfirm({
              leadId: props.leadId!,
              dealStageId: props.defaultDealStageId!,
              workflowRoute: props.defaultWorkflowRoute,
            })
          }
        >
          Convert
        </Button>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Add the lead stage inspection page**

```tsx
export function LeadStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("leads", stageId!);
  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  const { data } = useLeadStagePage({ stageId: route.stageId, ...route.query });
  if (!data) return <div>Loading stage…</div>;
  return (
    <PipelineStagePageHeader backTo={route.backTo} title={data.stage.name}>
      <PipelineStageTable rows={data.rows} pagination={data.pagination} onPageChange={route.onPageChange} />
    </PipelineStagePageHeader>
  );
}
```

- [ ] **Step 6: Re-run the focused lead tests**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-stage-page.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the leads board migration**

```bash
git add client/src/pages/leads/lead-list-page.tsx client/src/pages/leads/lead-stage-page.tsx client/src/pages/leads/lead-stage-page.test.tsx client/src/hooks/use-leads.ts client/src/components/leads/lead-conversion-dialog.tsx
git commit -m "feat: migrate leads to canonical board routes"
```

## Task 6: Rep Dashboard Becomes Board-First

**Files:**
- Modify: `client/src/pages/dashboard/rep-dashboard-page.tsx`
- Create: `client/src/components/dashboard/rep-dashboard-board-shell.tsx`
- Test: `client/src/pages/dashboard/rep-dashboard-page.test.tsx`

- [ ] **Step 1: Write a failing test for the rep home hierarchy**

```tsx
it("shows the rep board before secondary metrics and preserves the selected board tab for the session", async () => {
  mockRepDashboard();
  sessionStorage.setItem("pipeline-board-entity", "leads");
  render(<RepDashboardPage />);
  expect(await screen.findByText("My Board")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Leads" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Deals" }));
  expect(sessionStorage.getItem("pipeline-board-entity")).toBe("deals");
});
```

- [ ] **Step 2: Run the rep dashboard test to verify it fails**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx
```

Expected: FAIL because the page is still KPI-first and does not expose a board switcher.

- [ ] **Step 3: Replace the KPI-first layout with the shared board shell**

```tsx
export function RepDashboardPage() {
  const boardState = usePipelineBoardState("deals");
  return (
    <RepDashboardBoardShell
      activeEntity={boardState.activeEntity}
      onEntityChange={boardState.setActiveEntity}
      tasks={tasks}
      repSummary={data}
    />
  );
}
```

- [ ] **Step 4: Keep secondary tasks and personal metrics below the board hero**

```tsx
export function RepDashboardBoardShell(props: RepDashboardBoardShellProps) {
  return (
    <>
      <h1>My Board</h1>
      <section aria-label="My Board">{/* segmented switcher + PipelineBoard */}</section>
      <section aria-label="Secondary summary">{/* task list + stale follow-up + personal activity */}</section>
    </>
  );
}
```

- [ ] **Step 5: Re-run the rep dashboard test**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/dashboard/rep-dashboard-page.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the rep dashboard redesign**

```bash
git add client/src/pages/dashboard/rep-dashboard-page.tsx client/src/components/dashboard/rep-dashboard-board-shell.tsx client/src/pages/dashboard/rep-dashboard-page.test.tsx
git commit -m "feat: make rep dashboard board first"
```

## Task 7: Director Dashboard Becomes A Team Pipeline Console

**Files:**
- Modify: `client/src/pages/director/director-dashboard-page.tsx`
- Create: `client/src/components/dashboard/director-dashboard-shell.tsx`
- Test: `client/src/pages/director/director-dashboard-page.test.tsx`

- [ ] **Step 1: Write a failing test for the director console hierarchy**

```tsx
it("shows the team board switcher and stage-pressure workspace before the trend panels", async () => {
  mockDirectorDashboard();
  sessionStorage.setItem("pipeline-board-entity", "leads");
  render(<DirectorDashboardPage />);
  expect(await screen.findByText("Team Pipeline Console")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Leads" })).toHaveAttribute("aria-pressed", "true");
});
```

- [ ] **Step 2: Run the director dashboard test to verify it fails**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/director/director-dashboard-page.test.tsx
```

Expected: FAIL because the page still leads with KPI bento cards.

- [ ] **Step 3: Move the director page onto a board-first shell**

```tsx
export function DirectorDashboardPage() {
  const boardState = usePipelineBoardState("deals");
  return (
    <DirectorDashboardShell
      boardEntity={boardState.activeEntity}
      onBoardEntityChange={boardState.setActiveEntity}
      directorSummary={data}
    />
  );
}
```

- [ ] **Step 4: Preserve quick actions and trends as secondary and tertiary bands**

```tsx
export function DirectorDashboardShell(props: DirectorDashboardShellProps) {
  return (
    <>
      <h1>Team Pipeline Console</h1>
      <section aria-label="Primary workspace">{/* team board switcher + stage pressure + stale watch */}</section>
      <section aria-label="Secondary analytics">{/* rep comparison + alerts */}</section>
      <section aria-label="Trend charts">{/* pipeline + win-rate charts */}</section>
    </>
  );
}
```

- [ ] **Step 5: Re-run the director dashboard test**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/director/director-dashboard-page.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the director console redesign**

```bash
git add client/src/pages/director/director-dashboard-page.tsx client/src/components/dashboard/director-dashboard-shell.tsx client/src/pages/director/director-dashboard-page.test.tsx
git commit -m "feat: rebuild director dashboard as pipeline console"
```

## Task 8: Admin Dashboard Console And Summary Tiles

**Files:**
- Create: `client/src/pages/dashboard/admin-dashboard-page.tsx`
- Create: `client/src/components/dashboard/admin-operations-workspace.tsx`
- Create: `client/src/hooks/use-admin-dashboard-summary.ts`
- Create: `client/src/lib/admin-dashboard-summary.ts`
- Modify: `server/src/modules/dashboard/service.ts`
- Modify: `server/src/modules/dashboard/routes.ts`
- Test: `client/src/hooks/use-admin-dashboard-summary.test.ts`
- Test: `client/src/components/dashboard/admin-operations-workspace.test.tsx`
- Test: `client/src/pages/dashboard/admin-dashboard-page.test.tsx`

- [ ] **Step 1: Write failing tests for bounded admin summary tiles**

```ts
it("maps the admin dashboard payload into the required first-iteration module tiles", () => {
  expect(buildAdminOperationsTiles(summary)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "ai-actions", href: "/admin/ai-actions", secondaryLabel: "Oldest 14m" }),
      expect.objectContaining({ key: "procore", href: "/admin/procore", secondaryLabel: "Healthy" }),
    ])
  );
});
```

```tsx
it("renders the Operations Console with summary tiles before secondary board entries", async () => {
  mockAdminSummary();
  render(<AdminDashboardPage />);
  expect(await screen.findByText("Operations Console")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /AI Actions/i })).toBeInTheDocument();
  expect(screen.getByText(/Healthy|Oldest/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused admin tests to verify they fail**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/hooks/use-admin-dashboard-summary.test.ts client/src/components/dashboard/admin-operations-workspace.test.tsx client/src/pages/dashboard/admin-dashboard-page.test.tsx
```

Expected: FAIL because the summary hook and admin dashboard page do not exist.

- [ ] **Step 3: Add the server-side admin summary composition and its private readers in `server/src/modules/dashboard/service.ts`**

```ts
// server/src/modules/dashboard/service.ts
async function readAiActionSummary(tenantDb: TenantDb, activeOfficeId: string) { return { pendingCount: 0, oldestAgeLabel: "0m" }; }
async function readInterventionSummary(tenantDb: TenantDb, activeOfficeId: string) { return { openCount: 0, oldestAgeLabel: "0m" }; }
async function readDisconnectSummary(tenantDb: TenantDb, activeOfficeId: string) { return { totalCount: 0, primaryClusterLabel: "No active cluster" }; }
async function readMergeQueueSummary(tenantDb: TenantDb, activeOfficeId: string) { return { openCount: 0, oldestAgeLabel: "0m" }; }
async function readMigrationSummary(tenantDb: TenantDb, activeOfficeId: string) { return { unresolvedCount: 0, oldestAgeLabel: "0m" }; }
async function readAuditSummary(tenantDb: TenantDb, activeOfficeId: string) { return { changeCount24h: 0, lastActorLabel: "No recent changes" }; }
async function readProcoreSummary(tenantDb: TenantDb, activeOfficeId: string) { return { conflictCount: 0, healthLabel: "Healthy" }; }

export async function getAdminDashboardSummary(tenantDb: TenantDb, activeOfficeId: string) {
  return {
    aiActions: await readAiActionSummary(tenantDb, activeOfficeId),
    interventions: await readInterventionSummary(tenantDb, activeOfficeId),
    disconnects: await readDisconnectSummary(tenantDb, activeOfficeId),
    mergeQueue: await readMergeQueueSummary(tenantDb, activeOfficeId),
    migration: await readMigrationSummary(tenantDb, activeOfficeId),
    audit: await readAuditSummary(tenantDb, activeOfficeId),
    procore: await readProcoreSummary(tenantDb, activeOfficeId),
  };
}

router.get("/admin", requireRole("admin"), async (req, res) => {
  const data = await getAdminDashboardSummary(req.tenantDb!, req.user!.activeOfficeId);
  res.json({ data });
});
```

- [ ] **Step 4: Build the admin summary hook and tile workspace**

```ts
export function useAdminDashboardSummary() {
  const [data, setData] = useState<AdminDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    setError(null);
    void api<{ data: AdminDashboardSummary }>("/dashboard/admin")
      .then((result) => setData(result.data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load admin dashboard"))
      .finally(() => setLoading(false));
  }, []);
  return { data, loading, error };
}
```

```tsx
export function AdminOperationsWorkspace({ tiles }: { tiles: AdminOperationsTile[] }) {
  return (
    <section>
      {tiles.map((tile) => (
        <Card key={tile.key}>
          {tile.error ? <p>{tile.error}</p> : tile.loading ? <p>Loading…</p> : <Link to={tile.href}>{tile.title} · {tile.metric} · {tile.secondaryLabel}</Link>}
        </Card>
      ))}
    </section>
  );
}
```

```ts
type AdminOperationsTile = {
  key: string;
  title: string;
  href: string;
  metric: number;
  secondaryLabel: string;
  loading: boolean;
  error: string | null;
};

export function buildAdminOperationsTiles(summary: AdminDashboardSummary | null): AdminOperationsTile[] {
  if (!summary) {
    return [
      { key: "ai-actions", title: "AI Actions", href: "/admin/ai-actions", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
      { key: "interventions", title: "Interventions", href: "/admin/interventions", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
      { key: "disconnects", title: "Sales Process Disconnects", href: "/admin/sales-process-disconnects", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
      { key: "merge-queue", title: "Merge Queue", href: "/admin/merge-queue", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
      { key: "migration", title: "Migration Exceptions", href: "/admin/migration/review", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
      { key: "audit", title: "Audit Activity", href: "/admin/audit", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
      { key: "procore", title: "Procore / Sync Health", href: "/admin/procore", metric: 0, secondaryLabel: "Loading", loading: true, error: null },
    ];
  }
  return [
    { key: "ai-actions", title: "AI Actions", href: "/admin/ai-actions", metric: summary.aiActions.pendingCount, secondaryLabel: summary.aiActions.oldestAgeLabel, loading: false, error: null },
    { key: "interventions", title: "Interventions", href: "/admin/interventions", metric: summary.interventions.openCount, secondaryLabel: summary.interventions.oldestAgeLabel, loading: false, error: null },
    { key: "disconnects", title: "Sales Process Disconnects", href: "/admin/sales-process-disconnects", metric: summary.disconnects.totalCount, secondaryLabel: summary.disconnects.primaryClusterLabel, loading: false, error: null },
    { key: "merge-queue", title: "Merge Queue", href: "/admin/merge-queue", metric: summary.mergeQueue.openCount, secondaryLabel: summary.mergeQueue.oldestAgeLabel, loading: false, error: null },
    { key: "migration", title: "Migration Exceptions", href: "/admin/migration/review", metric: summary.migration.unresolvedCount, secondaryLabel: summary.migration.oldestAgeLabel, loading: false, error: null },
    { key: "audit", title: "Audit Activity", href: "/admin/audit", metric: summary.audit.changeCount24h, secondaryLabel: summary.audit.lastActorLabel, loading: false, error: null },
    { key: "procore", title: "Procore / Sync Health", href: "/admin/procore", metric: summary.procore.conflictCount, secondaryLabel: summary.procore.healthLabel, loading: false, error: null },
  ];
}
```

- [ ] **Step 5: Render the new admin home and secondary board entries**

```tsx
export function AdminDashboardPage() {
  const { data, loading, error } = useAdminDashboardSummary();
  return (
    <>
      <h1>Operations Console</h1>
      <AdminOperationsWorkspace
        tiles={buildAdminOperationsTiles(data).map((tile) => ({ ...tile, loading, error }))}
      />
      <section aria-label="Secondary boards">
        <Link to="/deals?scope=all">Deals Board</Link>
        <Link to="/leads?scope=all">Leads Board</Link>
      </section>
    </>
  );
}
```

- [ ] **Step 6: Re-run the focused admin tests**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/hooks/use-admin-dashboard-summary.test.ts client/src/components/dashboard/admin-operations-workspace.test.tsx client/src/pages/dashboard/admin-dashboard-page.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the admin console**

```bash
git add client/src/pages/dashboard/admin-dashboard-page.tsx client/src/components/dashboard/admin-operations-workspace.tsx client/src/hooks/use-admin-dashboard-summary.ts client/src/lib/admin-dashboard-summary.ts client/src/hooks/use-admin-dashboard-summary.test.ts client/src/components/dashboard/admin-operations-workspace.test.tsx client/src/pages/dashboard/admin-dashboard-page.test.tsx server/src/modules/dashboard/service.ts server/src/modules/dashboard/routes.ts
git commit -m "feat: add admin operations dashboard"
```

## Task 9: Workflow Visual Alignment And Final Route Verification

**Files:**
- Modify: `client/src/components/leads/lead-stage-badge.tsx`
- Modify: `client/src/components/deals/deal-stage-badge.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Test: `client/src/pages/leads/lead-detail-page.test.tsx`
- Test: `client/src/pages/deals/deal-detail-page.test.tsx`

- [ ] **Step 1: Add a failing test for aligned workflow header treatment where needed**

```tsx
it("renders the lead workflow header with the shared stage badge styling after conversion", () => {
  render(<LeadDetailPage />);
  expect(screen.getByText(/Pre-RFP activity stays visible/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused detail-page test**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx
```

Expected: FAIL if the shared workflow header treatment is not yet in place.

- [ ] **Step 3: Align the workflow badge and header primitives without re-architecting detail internals**

```tsx
const SHARED_STAGE_BADGE_CLASS = "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide";

export function LeadStageBadge(props: LeadStageBadgeProps) {
  return <Badge className={SHARED_STAGE_BADGE_CLASS}>{props.stageId}</Badge>;
}

export function DealStageBadge(props: DealStageBadgeProps) {
  return <Badge className={SHARED_STAGE_BADGE_CLASS}>{props.stageId}</Badge>;
}
```

- [ ] **Step 4: Re-run the focused detail-page test**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the cross-surface verification suite**

Run:

```bash
npx vitest run --config client/vite.config.ts client/src/lib/pipeline-scope.test.ts client/src/lib/pipeline-stage-page.test.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx client/src/hooks/use-admin-dashboard-summary.test.ts client/src/components/dashboard/admin-operations-workspace.test.tsx client/src/pages/dashboard/home-dashboard-page.test.tsx client/src/pages/dashboard/admin-dashboard-page.test.tsx client/src/pages/dashboard/rep-dashboard-page.test.tsx client/src/pages/director/director-dashboard-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx
```

Expected: PASS.

- [ ] **Step 6a: Run the server verification suite**

Run:

```bash
npx vitest run --config server/vitest.config.ts server/tests/modules/leads/board-service.test.ts server/tests/modules/deals/stage-page-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck --workspace=client
```

Expected: PASS.

- [ ] **Step 7: Commit the visual alignment and verification sweep**

```bash
git add client/src/components/leads/lead-stage-badge.tsx client/src/components/deals/deal-stage-badge.tsx client/src/pages/leads/lead-detail-page.tsx client/src/pages/deals/deal-detail-page.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx
git commit -m "feat: align workflow visuals across pipeline surfaces"
```

## Self-Review

### Spec coverage

- Canonical `/leads` and `/deals` routes, scope normalization, and compatibility redirects are covered in Tasks 1, 4, and 5.
- Shared board grammar, stage pages, and drag-only-on-board behavior are covered in Tasks 2 through 5.
- Lead conversion boundary behavior is covered in Task 5.
- Rep board-first home, director console, and admin console are covered in Tasks 6, 7, and 8.
- Stage-page sorting, filtering, pagination, breadcrumb behavior, and allowed scope handling are covered in Tasks 1 through 5.
- Workflow visual alignment is covered in Task 9.

No uncovered spec sections remain.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Each task includes explicit file paths, concrete commands, and representative code/test snippets.
- No task depends on “same as Task N” shorthand.

### Type consistency

- Route scope values stay `mine | team | all` throughout.
- Entity names stay `leads` and `deals` at the route level.
- Stage-page sort contract uses `age_desc` naming consistently.
- Admin console naming stays `AdminDashboardPage` / `useAdminDashboardSummary` / `buildAdminOperationsTiles` / `AdminOperationsWorkspace`.
