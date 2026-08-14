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

  it("opens the Reports by Region route to all authenticated users (no role guard)", () => {
    // Region is now available to every CRM role (server /api/reports/region dropped requireDirector too),
    // so it is mounted like the open analytics reports — with no RequireRole wrapper.
    expect(source).toContain('path="/reports/region" element={<RegionReportPage />}');
    expect(source).not.toContain('<RequireRole allowedRoles={["admin", "director"]}> <RegionReportPage />');
  });
});
