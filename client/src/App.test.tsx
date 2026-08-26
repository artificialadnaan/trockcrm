import { describe, expect, it } from "vitest";
import appSource from "./App.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("App route guards", () => {
  const source = normalize(appSource);

  it("wraps shared director routes with admin and director access", () => {
    expect(source).toContain('path="/director" element={( <RequireRole allowedRoles={["admin", "director"]}> <DirectorDashboardPage />');
    expect(source).toContain('path="/director/rep/:repId" element={( <RequireRole allowedRoles={["admin", "director"]}> <DirectorRepDetail />');
  });

  it("wraps admin-only routes with the appropriate admin guard (RequireGlobalAdmin for users, RequireRole for the rest)", () => {
    expect(source).toContain('path="/admin/users" element={( <RequireGlobalAdmin> <UsersPage />');
    expect(source).toContain('path="/admin/offices" element={( <RequireRole allowedRoles={["admin"]}> <OfficesPage />');
    expect(source).toContain('path="/help/admin-guide" element={( <RequireRole allowedRoles={["admin"]}> <AdminGuidePage />');
  });

  it("keeps the personal commissions route rep-only but renders the disabled notice", () => {
    // Commissions are temporarily disabled for reps: the route stays behind the rep-only
    // guard but renders CommissionsDisabledPage instead of RepCommissionsPage. Re-enable by
    // swapping the element back to <RepCommissionsPage /> in App.tsx (and here).
    expect(source).toContain('path="/commissions" element={( <RequireRole allowedRoles={["rep"]}> <CommissionsDisabledPage />');
  });

  it("opens migration tooling to directors and admins", () => {
    expect(source).toContain('path="/admin/migration" element={( <RequireRole allowedRoles={["admin", "director"]}> <MigrationDashboardPage />');
  });

  it("mounts /deals directly; /pipeline redirects to /deals (the mirror page was removed)", () => {
    expect(source).not.toContain("function DealsToPipelineRedirect");
    expect(source).not.toContain('path="/deals" element={<DealsToPipelineRedirect />}');
    expect(source).toContain('path="/deals" element={<DealListPage />}');
    // The standalone Pipeline page mirrored Deals and was removed; /pipeline now redirects to /deals
    // via the query-preserving alias redirect (bookmarked ?scope=...&... params survive the hop).
    expect(source).not.toContain("<PipelinePage />");
    expect(source).toContain('path="/pipeline" element={<BoardAliasRedirect entity="deals" />}');
  });

  it("exposes team and global commissions routes with role guards", () => {
    expect(source).toContain('path="/director/commissions" element={( <RequireRole allowedRoles={["admin", "director"]}> <TeamCommissionsPage />');
    expect(source).toContain('path="/admin/commissions" element={( <RequireRole allowedRoles={["admin"]}> <GlobalCommissionsPage />');
  });

  it("wraps Operations report routes with admin and director access", () => {
    expect(source).toContain('path="/reports/operations/workflow-bottlenecks" element={( <RequireRole allowedRoles={["admin", "director"]}> <WorkflowBottlenecksPage />');
    expect(source).toContain('path="/reports/operations/project-readiness" element={( <RequireRole allowedRoles={["admin", "director"]}> <ProjectReadinessPage />');
    expect(source).toContain('path="/reports/operations/portfolio-load" element={( <RequireRole allowedRoles={["admin", "director"]}> <PortfolioLoadPage />');
    expect(source).toContain('path="/reports/operations/estimator-pipeline" element={( <RequireRole allowedRoles={["admin", "director"]}> <EstimatorPipelinePage />');
  });

  it("preserves report route guards while export remains page-local", () => {
    expect(source).toContain('path="/reports/monday-showcase" element={( <RequireRole allowedRoles={["admin", "director", "rep"]}> <MondayShowcasePage />');
    expect(source).toContain('path="/reports/performance/director-scorecard" element={( <RequireRole allowedRoles={["admin", "director"]}> <DirectorScorecardPage />');
    expect(source).toContain('path="/reports/performance/rep-activity" element={( <RequireRole allowedRoles={["admin", "director", "rep"]}> <RepActivityPage />');
    expect(source).toContain('path="/reports/performance/forecast-accuracy" element={( <RequireRole allowedRoles={["admin", "director"]}> <ForecastAccuracyPage />');
    expect(source).toContain('path="/reports/analytics/market-mix" element={<MarketMixPage />}');
    expect(source).toContain('path="/reports/analytics/customer-concentration" element={<CustomerConcentrationPage />}');
    expect(source).toContain('path="/reports/analytics/executive-trends" element={<ExecutiveTrendsPage />}');
  });

  it("mounts the self-service reset page as a public route that the auth gate lets through", () => {
    expect(source).toContain('path="/reset-password" element={<ResetPasswordPage />}');
    // AuthGate short-circuits to the login screen for every unauthenticated path before the Routes
    // are ever reached, so the emailed reset link needs an explicit bypass or it lands on "Welcome back".
    expect(source).toContain('if (location.pathname === "/reset-password") return <>{children}</>;');
  });

  // The new-assignment modal's mount POINT is the whole design, and both halves of it are load-bearing:
  //
  //   INSIDE AuthGate, in its final return. AuthGate short-circuits to `children` for /p/,
  //   /daily-summary/, /scorecards/:id/corrective-action and /reset-password before it ever looks at
  //   the user, so mounting here is what makes the modal a structural no-op on those pages. Those are
  //   deliberately unauthenticated surfaces — a signed-in person opening a client photo link must not
  //   get an interrupting task dialog over one — and a path check inside the component would be a
  //   second list to keep in sync with AuthGate's.
  //
  //   OUTSIDE <Suspense>. The boundary wraps <Routes>, and the post-login landing route is lazy(), so
  //   a modal declared inside it cannot render until the dashboard chunk resolves — which is exactly
  //   the moment it is supposed to be on screen. <Toaster/> sits inside that boundary; it is the
  //   precedent for "route-independent global", not for the boundary.
  it("mounts the new-assignment modal inside AuthGate and OUTSIDE the Suspense boundary", () => {
    // The final return of AuthGate — after every public-path short-circuit and after the !user,
    // mustChangePassword and requiresOnboarding takeovers.
    expect(source).toContain("return ( <> {children} <TaskAssignmentModal /> </> );");

    // ...and NOT beside <Toaster/>, which is inside the boundary.
    expect(source).not.toContain("<Toaster position=\"top-right\" richColors /> <TaskAssignmentModal />");
    expect(source).not.toContain("<TaskAssignmentModal /> <Toaster");
  });

  it("keeps the four public routes short-circuiting BEFORE the modal can mount", () => {
    // If any of these moved below the final return, the modal would render over a tokenized page.
    const gate = source.slice(source.indexOf("function AuthGate"), source.indexOf("function OnboardingRequiredPage"));
    const modalAt = gate.indexOf("<TaskAssignmentModal />");
    expect(modalAt).toBeGreaterThan(-1);
    for (const publicPath of [
      'location.pathname.startsWith("/p/")',
      'location.pathname.startsWith("/daily-summary/")',
      "/^\\/scorecards\\/[^/]+\\/corrective-action$/.test(location.pathname)",
      'location.pathname === "/reset-password"',
    ]) {
      expect(gate.indexOf(publicPath), publicPath).toBeGreaterThan(-1);
      expect(gate.indexOf(publicPath), publicPath).toBeLessThan(modalAt);
    }
  });

  it("does not lazy-load the modal — a lazy() modal cannot fire before its own chunk resolves", () => {
    expect(source).toContain('import { TaskAssignmentModal } from "@/components/tasks/task-assignment-modal";');
    expect(source).not.toContain("const TaskAssignmentModal = lazy(");
  });

  it("opens the Reports by Region route to all authenticated users (no role guard)", () => {
    // Region is now available to every CRM role (server /api/reports/region dropped requireDirector too),
    // so it is mounted like the open analytics reports — with no RequireRole wrapper.
    expect(source).toContain('path="/reports/region" element={<RegionReportPage />}');
    expect(source).not.toContain('<RequireRole allowedRoles={["admin", "director"]}> <RegionReportPage />');
  });
});
