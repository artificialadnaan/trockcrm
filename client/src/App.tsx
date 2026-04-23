import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { Suspense, lazy, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AuthEntryScreen } from "@/components/auth/auth-entry-screen";
import { ForcePasswordChangeScreen } from "@/components/auth/force-password-change-screen";
import { RequireRole } from "@/components/auth/require-role";
import { AppShell } from "@/components/layout/app-shell";
import { DealDetailPage } from "@/pages/deals/deal-detail-page";
import { DealNewPage } from "@/pages/deals/deal-new-page";
import { DealEditPage } from "@/pages/deals/deal-edit-page";
import { PipelinePage } from "@/pages/pipeline/pipeline-page";
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
import { EmailInboxPage } from "@/pages/email/email-inbox-page";
import { TaskListPage } from "@/pages/tasks/task-list-page";
import { FilesPage } from "@/pages/files/files-page";
import { DirectorRepDetail } from "@/pages/director/director-rep-detail";
import { ReportsPage } from "@/pages/reports/reports-page";
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
import { PhotoCapturePage } from "@/pages/photos/photo-capture-page";
import { PhotoFeedPage } from "@/pages/photos/photo-feed-page";
import { PipelineHygienePage } from "@/pages/pipeline/pipeline-hygiene-page";
import { ProjectDetailPage } from "@/pages/projects/project-detail-page";
import { Toaster } from "@/components/ui/sonner";

const HomeDashboardPage = lazy(() =>
  import("@/pages/dashboard/home-dashboard-page").then((module) => ({ default: module.HomeDashboardPage }))
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

function BoardAliasRedirect({ entity }: { entity: "leads" | "deals" }) {
  const [searchParams] = useSearchParams();
  const next = searchParams.toString();
  return <Navigate to={next ? `/${entity}?${next}` : `/${entity}`} replace />;
}

function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) return <AuthEntryScreen />;
  if (user.mustChangePassword) return <ForcePasswordChangeScreen />;
  return <>{children}</>;
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
            <Route path="/photos/capture" element={<PhotoCapturePage />} />
            <Route element={<AppShell />}>
              <Route path="/" element={<HomeDashboardPage />} />
              <Route path="/deals" element={<DealListPage />} />
              <Route path="/deals/board" element={<BoardAliasRedirect entity="deals" />} />
              <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
              <Route path="/deals/new" element={<DealNewPage />} />
              <Route path="/deals/:id" element={<DealDetailPage />} />
              <Route path="/deals/:id/edit" element={<DealEditPage />} />
              <Route path="/leads" element={<LeadListPage />} />
              <Route path="/leads/board" element={<BoardAliasRedirect entity="leads" />} />
              <Route path="/leads/stages/:stageId" element={<LeadStagePage />} />
              <Route path="/leads/new" element={<LeadNewPage />} />
              <Route path="/leads/:id/edit" element={<LeadEditPage />} />
              <Route path="/leads/:id" element={<LeadDetailPage />} />
              <Route path="/properties" element={<PropertyListPage />} />
              <Route path="/properties/:id" element={<PropertyDetailPage />} />
              <Route path="/pipeline" element={<PipelinePage />} />
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
              <Route path="/files" element={<FilesPage />} />
              <Route path="/reports" element={<ReportsPage />} />
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
                  <RequireRole allowedRoles={["admin"]}>
                    <UsersPage />
                  </RequireRole>
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
