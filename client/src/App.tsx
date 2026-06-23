import { Routes, Route, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AuthEntryScreen } from "@/components/auth/auth-entry-screen";
import { ForcePasswordChangeScreen } from "@/components/auth/force-password-change-screen";
import { RequireRole, RequireGlobalAdmin } from "@/components/auth/require-role";
import { AppShell } from "@/components/layout/app-shell";
import { DealDetailPage } from "@/pages/deals/deal-detail-page";
import { RfpReviewPage } from "@/pages/rfp-review/rfp-review-page";
import { DealNewPage } from "@/pages/deals/deal-new-page";
import { DealEditPage } from "@/pages/deals/deal-edit-page";
import { ServiceOpportunityNewPage } from "@/pages/deals/service-opportunity-new-page";
import { MyCleanupPage } from "@/pages/pipeline/my-cleanup-page";
import { ContactListPage } from "@/pages/contacts/contact-list-page";
import { ContactDetailPage } from "@/pages/contacts/contact-detail-page";
import { ContactNewPage } from "@/pages/contacts/contact-new-page";
import { ContactEditPage } from "@/pages/contacts/contact-edit-page";
import { CompanyListPage } from "@/pages/companies/company-list-page";
import { CompanyDetailPage } from "@/pages/companies/company-detail-page";
import { CompanyNewPage } from "@/pages/companies/company-new-page";
import { CompanyEditPage } from "@/pages/companies/company-edit-page";
import { LeadDetailPage } from "@/pages/leads/lead-detail-page";
import { LeadEditPage } from "@/pages/leads/lead-edit-page";
import { LeadNewPage } from "@/pages/leads/lead-new-page";
import { PropertyListPage } from "@/pages/properties/property-list-page";
import { PropertyDetailPage } from "@/pages/properties/property-detail-page";
import { MergeQueuePage } from "@/pages/admin/merge-queue-page";
import { DirectoryMergeQueuePage } from "@/pages/admin/directory-merge-queue-page";
import { LeadDueDiligenceQueuePage } from "@/pages/admin/lead-due-diligence-queue-page";
import { NotificationRecipientsPage } from "@/pages/admin/notification-recipients-page";
import { EmailInboxPage } from "@/pages/email/email-inbox-page";
import { TaskListPage } from "@/pages/tasks/task-list-page";
import { FilesPage } from "@/pages/files/files-page";
import { DirectorRepDetail } from "@/pages/director/director-rep-detail";
import { ReportsPage } from "@/pages/reports/reports-page";
import { ClosedWonRevenuePage } from "@/pages/reports/closed-won-revenue-page";
import { CustomerConcentrationPage } from "@/pages/reports/customer-concentration-page";
import { DirectorScorecardPage } from "@/pages/reports/director-scorecard-page";
import { ExecutiveTrendsPage } from "@/pages/reports/executive-trends-page";
import { ForecastAccuracyPage } from "@/pages/reports/forecast-accuracy-page";
import { LeadConversionPage } from "@/pages/reports/lead-conversion-page";
import { MarketMixPage } from "@/pages/reports/market-mix-page";
import { PipelineVelocityPage } from "@/pages/reports/pipeline-velocity-page";
import { RepActivityPage } from "@/pages/reports/rep-activity-page";
import { PlatformUsagePage } from "@/pages/reports/platform-usage-page";
import { PlatformUsageRepDetailPage } from "@/pages/reports/platform-usage-rep-detail-page";
import { PortfolioLoadPage } from "@/pages/reports/portfolio-load-page";
import { ProjectReadinessPage } from "@/pages/reports/project-readiness-page";
import { WorkflowBottlenecksPage } from "@/pages/reports/workflow-bottlenecks-page";
import { MondayShowcasePage } from "@/pages/reports/monday-showcase-page";
import { ForecastConfidencePage } from "@/pages/reports/forecast-confidence-page";
import { AtRiskPage } from "@/pages/reports/at-risk-page";
import { RegionReportPage } from "@/pages/reports/region-report-page";
import { RepPackPage } from "@/pages/reports/rep-pack-page";
import { SalesReviewPage } from "@/pages/sales-review/sales-review-page";
import { ProjectsPage } from "@/pages/projects/projects-page";
import { ProcoreSyncPage } from "@/pages/admin/procore-sync-page";
import { MigrationDashboardPage } from "@/pages/admin/migration/migration-dashboard-page";
import { MigrationDealsPage } from "@/pages/admin/migration/migration-deals-page";
import { MigrationContactsPage } from "@/pages/admin/migration/migration-contacts-page";
import { MigrationReviewPage } from "@/pages/admin/migration/migration-review-page";
import { SearchPage } from "@/pages/search/search-page";
import { OfficesPage } from "@/pages/admin/offices-page";
import { UsersPage } from "@/pages/admin/users-page";
import { PipelineConfigPage } from "@/pages/admin/pipeline-config-page";
import { AuditLogPage } from "@/pages/admin/audit-log-page";
import { CrossOfficeReportsPage } from "@/pages/admin/cross-office-reports-page";
import { AiActionQueuePage } from "@/pages/admin/ai-action-queue-page";
import { AiOpsPage } from "@/pages/admin/ai-ops-page";
import { AiPacketReviewPage } from "@/pages/admin/ai-packet-review-page";
import { AdminInterventionWorkspacePage } from "@/pages/admin/admin-intervention-workspace-page";
import { AdminInterventionAnalyticsPage } from "@/pages/admin/admin-intervention-analytics-page";
import { SalesProcessDisconnectsPage } from "@/pages/admin/sales-process-disconnects-page";
import { AdminDataScrubPage } from "@/pages/admin/admin-data-scrub-page";
import { UserGuidePage } from "@/pages/admin/help/user-guide-page";
import { AdminGuidePage } from "@/pages/admin/help/admin-guide-page";
import { CompanyCamPage } from "@/pages/admin/companycam-page";
import { PhotoAuditPage } from "@/pages/admin/photo-audit/photo-audit-page";
import { FieldUsersPage } from "@/pages/admin/field-users/field-users-page";
import { PhotoCapturePage } from "@/pages/photos/photo-capture-page";
import { PhotoFeedPage } from "@/pages/photos/photo-feed-page";
import { PipelineHygienePage } from "@/pages/pipeline/pipeline-hygiene-page";
import { ProjectDetailPage } from "@/pages/projects/project-detail-page";
import { PublicPhotoViewerPage } from "@/pages/public/photo-viewer-page";
import { DailySummaryPage } from "@/pages/public/daily-summary-page";
import { Toaster } from "@/components/ui/sonner";

const HomeDashboardPage = lazy(() =>
  import("@/pages/dashboard/home-dashboard-page").then((module) => ({ default: module.HomeDashboardPage }))
);
const ContractsSignedPage = lazy(() =>
  import("@/pages/dashboard/contracts-signed-page").then((module) => ({ default: module.ContractsSignedPage }))
);
const DealListPage = lazy(() =>
  import("@/pages/deals/deal-list-page").then((module) => ({ default: module.DealListPage }))
);
const DealStagePage = lazy(() =>
  import("@/pages/deals/deal-stage-page").then((module) => ({ default: module.DealStagePage }))
);
const LeadListPage = lazy(() =>
  import("@/pages/leads/lead-list-page").then((module) => ({ default: module.LeadListPage }))
);
const LeadStagePage = lazy(() =>
  import("@/pages/leads/lead-stage-page").then((module) => ({ default: module.LeadStagePage }))
);
const DirectorDashboardPage = lazy(() =>
  import("@/pages/director/director-dashboard-page").then((module) => ({ default: module.DirectorDashboardPage }))
);
const RepCommissionsPage = lazy(() =>
  import("@/pages/commissions/rep-commissions-page").then((module) => ({ default: module.RepCommissionsPage }))
);
const TeamCommissionsPage = lazy(() =>
  import("@/pages/commissions/team-commissions-page").then((module) => ({ default: module.TeamCommissionsPage }))
);
const GlobalCommissionsPage = lazy(() =>
  import("@/pages/admin/global-commissions-page").then((module) => ({ default: module.GlobalCommissionsPage }))
);
const SharedPrimitivesHarness = lazy(() =>
  import("@/components/__harness__/shared-primitives-harness").then((module) => ({
    default: module.SharedPrimitivesHarness,
  }))
);

const enableSharedPrimitivesHarness = import.meta.env.DEV;

function BoardAliasRedirect({ entity }: { entity: "leads" | "deals" }) {
  const [searchParams] = useSearchParams();
  const next = searchParams.toString();
  return <Navigate to={next ? `/${entity}?${next}` : `/${entity}`} replace />;
}

function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (location.pathname.startsWith("/p/")) return <>{children}</>;
  if (location.pathname.startsWith("/daily-summary/")) return <>{children}</>; // token-guarded public page

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) return <AuthEntryScreen />;
  if (user.mustChangePassword) return <ForcePasswordChangeScreen />;
  if (user.requiresOnboarding && location.pathname !== "/onboarding-required") {
    return <Navigate to="/onboarding-required" replace />;
  }
  return <>{children}</>;
}

function OnboardingRequiredPage() {
  const { user } = useAuth();
  const cleanupUrl = user?.cleanupUrl || "http://localhost:5175";
  const cleanupDestination = (() => {
    const url = new URL(cleanupUrl, window.location.origin);
    if (!url.pathname || url.pathname === "/") url.pathname = "/cleanup";
    return url.toString();
  })();

  useEffect(() => {
    if (user?.requiresOnboarding) {
      window.location.assign(cleanupDestination);
    }
  }, [cleanupDestination, user?.requiresOnboarding]);

  if (!user?.requiresOnboarding) return <Navigate to="/" replace />;

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-4 text-slate-100">
      <section className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-wide text-red-400">Onboarding required</p>
        <h1 className="mt-3 text-3xl font-black">Finish cleanup before entering the CRM</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Your migration cleanup queue has {user.onboardingPendingCount ?? 0} pending item{user.onboardingPendingCount === 1 ? "" : "s"}.
          You will be redirected to the cleanup workspace.
        </p>
        <a
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800"
          href={cleanupDestination}
        >
          Open cleanup workspace
        </a>
      </section>
    </main>
  );
}

function RouteFallback() {
  return (
    <div className="flex min-h-[12rem] items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500">
      Loading workspace...
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Suspense fallback={<RouteFallback />}>
          <>
            <Routes>
            <Route path="/p/:token" element={<PublicPhotoViewerPage />} />
            <Route path="/daily-summary/:date" element={<DailySummaryPage />} />
            <Route path="/photos/capture" element={<PhotoCapturePage />} />
            <Route path="/onboarding-required" element={<OnboardingRequiredPage />} />
            <Route element={<AppShell />}>
              <Route path="/" element={<HomeDashboardPage />} />
              <Route path="/dashboard" element={<HomeDashboardPage />} />
              <Route path="/dashboard/contracts-signed" element={<ContractsSignedPage />} />
              <Route path="/deals" element={<DealListPage />} />
              <Route path="/deals/board" element={<BoardAliasRedirect entity="deals" />} />
              <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
              <Route path="/deals/service-opportunity/new" element={<ServiceOpportunityNewPage />} />
              <Route path="/deals/new" element={<DealNewPage />} />
              <Route path="/deals/:id/photos" element={<DealDetailPage />} />
              <Route path="/deals/:id" element={<DealDetailPage />} />
              <Route path="/deals/:id/edit" element={<DealEditPage />} />
              <Route path="/rfp-review/:dealId" element={<RfpReviewPage />} />
              <Route path="/leads" element={<LeadListPage />} />
              <Route path="/leads/board" element={<BoardAliasRedirect entity="leads" />} />
              <Route path="/leads/stages/:stageId" element={<LeadStagePage />} />
              <Route path="/leads/new" element={<LeadNewPage />} />
              <Route path="/leads/:id/edit" element={<LeadEditPage />} />
              <Route path="/leads/:id" element={<LeadDetailPage />} />
              <Route path="/properties" element={<PropertyListPage />} />
              <Route path="/properties/:id" element={<PropertyDetailPage />} />
              {/* The standalone Pipeline page mirrored the Deals dashboard and was removed (product
                  decision). /pipeline redirects to the canonical Deals board, carrying the search string
                  so the primary control — `scope` (Mine/All/Watched/On Hold) — survives. Other legacy
                  Pipeline-only params do NOT map and land on the Deals defaults: the list filters there
                  live under the `dl_` namespace, the board shows DD stages by default, terminal windows
                  seed from `period`, and there is no drag-to-move. That non-equivalence is the accepted
                  cost of consolidating onto one board; a compat shim for a removed page isn't warranted.
                  Sub-routes below stay. */}
              <Route path="/pipeline" element={<BoardAliasRedirect entity="deals" />} />
              <Route path="/pipeline/my-cleanup" element={<MyCleanupPage />} />
              <Route path="/contacts" element={<ContactListPage />} />
              <Route path="/contacts/new" element={<ContactNewPage />} />
              <Route path="/contacts/:id" element={<ContactDetailPage />} />
              <Route path="/contacts/:id/edit" element={<ContactEditPage />} />
              <Route path="/companies" element={<CompanyListPage />} />
              <Route path="/companies/new" element={<CompanyNewPage />} />
              <Route path="/companies/:id" element={<CompanyDetailPage />} />
              <Route path="/companies/:id/edit" element={<CompanyEditPage />} />
              <Route path="/email" element={<EmailInboxPage />} />
              <Route path="/tasks" element={<TaskListPage />} />
              <Route path="/tasks/:taskId" element={<TaskListPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/sales/pipeline-velocity" element={<PipelineVelocityPage />} />
              <Route path="/reports/sales/closed-won-revenue" element={<ClosedWonRevenuePage />} />
              <Route path="/reports/sales/lead-conversion" element={<LeadConversionPage />} />
              <Route
                path="/reports/monday-showcase"
                element={(
                  <RequireRole allowedRoles={["admin", "director", "rep"]}>
                    <MondayShowcasePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/forecast-confidence"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <ForecastConfidencePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/region"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <RegionReportPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/at-risk"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AtRiskPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/rep-pack"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <RepPackPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/performance/director-scorecard"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <DirectorScorecardPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/performance/rep-activity"
                element={(
                  <RequireRole allowedRoles={["admin", "director", "rep"]}>
                    <RepActivityPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/performance/platform-usage"
                element={(
                  <RequireRole allowedRoles={["admin", "director", "rep"]}>
                    <PlatformUsagePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/performance/platform-usage/:repId"
                element={(
                  <RequireRole allowedRoles={["admin", "director", "rep"]}>
                    <PlatformUsageRepDetailPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/performance/forecast-accuracy"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                  <ForecastAccuracyPage />
                </RequireRole>
              )}
              />
              <Route path="/reports/analytics/market-mix" element={<MarketMixPage />} />
              <Route path="/reports/analytics/customer-concentration" element={<CustomerConcentrationPage />} />
              <Route path="/reports/analytics/executive-trends" element={<ExecutiveTrendsPage />} />
              <Route
                path="/reports/operations/workflow-bottlenecks"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <WorkflowBottlenecksPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/operations/project-readiness"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <ProjectReadinessPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/reports/operations/portfolio-load"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <PortfolioLoadPage />
                  </RequireRole>
                )}
              />
              {enableSharedPrimitivesHarness ? (
                <Route path="/__harness__/shared-primitives" element={<SharedPrimitivesHarness />} />
              ) : null}
              <Route
                path="/commissions"
                element={(
                  <RequireRole allowedRoles={["rep"]}>
                    <RepCommissionsPage />
                  </RequireRole>
                )}
              />
              <Route path="/sales-review" element={<SalesReviewPage />} />
              <Route path="/pipeline/hygiene" element={<PipelineHygienePage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route
                path="/director"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <DirectorDashboardPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/director/rep/:repId"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <DirectorRepDetail />
                  </RequireRole>
                )}
              />
              <Route
                path="/director/commissions"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <TeamCommissionsPage />
                  </RequireRole>
                )}
              />
              <Route path="/search" element={<SearchPage />} />
              <Route
                path="/admin/offices"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <OfficesPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/users"
                element={(
                  <RequireGlobalAdmin>
                    <UsersPage />
                  </RequireGlobalAdmin>
                )}
              />
              <Route
                path="/admin/pipeline"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <PipelineConfigPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/commissions"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <GlobalCommissionsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/audit"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AuditLogPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/data-scrub"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AdminDataScrubPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/cross-office-reports"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <CrossOfficeReportsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/ai-actions"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AiActionQueuePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/interventions"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AdminInterventionWorkspacePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/intervention-analytics"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AdminInterventionAnalyticsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/sales-process-disconnects"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <SalesProcessDisconnectsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/merge-queue"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <MergeQueuePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/directory-merge-queue"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <DirectoryMergeQueuePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/lead-due-diligence-queue"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <LeadDueDiligenceQueuePage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/notification-recipients"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <NotificationRecipientsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/procore"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <ProcoreSyncPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/ai-ops"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AiOpsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/ai-ops/reviews/:packetId"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <AiPacketReviewPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/companycam"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <CompanyCamPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/photo-audit"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <PhotoAuditPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/field-users"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <FieldUsersPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/migration"
                element={(
                  <RequireRole allowedRoles={["admin", "director"]}>
                    <MigrationDashboardPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/migration/review"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <MigrationReviewPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/migration/deals"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <MigrationDealsPage />
                  </RequireRole>
                )}
              />
              <Route
                path="/admin/migration/contacts"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <MigrationContactsPage />
                  </RequireRole>
                )}
              />
              <Route path="/photos/feed" element={<PhotoFeedPage />} />
              <Route path="/help/user-guide" element={<UserGuidePage />} />
              <Route
                path="/help/admin-guide"
                element={(
                  <RequireRole allowedRoles={["admin"]}>
                    <AdminGuidePage />
                  </RequireRole>
                )}
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <Toaster position="top-right" richColors />
          </>
        </Suspense>
      </AuthGate>
    </AuthProvider>
  );
}
