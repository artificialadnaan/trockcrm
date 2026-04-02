import { Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DevUserPicker } from "@/components/auth/dev-user-picker";
import { AppShell } from "@/components/layout/app-shell";
import { DealListPage } from "@/pages/deals/deal-list-page";
import { DealDetailPage } from "@/pages/deals/deal-detail-page";
import { DealNewPage } from "@/pages/deals/deal-new-page";
import { DealEditPage } from "@/pages/deals/deal-edit-page";
import { PipelinePage } from "@/pages/pipeline/pipeline-page";
import { ContactListPage } from "@/pages/contacts/contact-list-page";
import { ContactDetailPage } from "@/pages/contacts/contact-detail-page";
import { ContactNewPage } from "@/pages/contacts/contact-new-page";
import { ContactEditPage } from "@/pages/contacts/contact-edit-page";
import { MergeQueuePage } from "@/pages/admin/merge-queue-page";
import { EmailInboxPage } from "@/pages/email/email-inbox-page";
import { TaskListPage } from "@/pages/tasks/task-list-page";
import { RepDashboardPage } from "@/pages/dashboard/rep-dashboard-page";
import { DirectorDashboardPage } from "@/pages/director/director-dashboard-page";
import { DirectorRepDetail } from "@/pages/director/director-rep-detail";
import { ReportsPage } from "@/pages/reports/reports-page";

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="text-muted-foreground mt-1">This page will be built in a future plan.</p>
    </div>
  );
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

  if (!user) return <DevUserPicker />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<RepDashboardPage />} />
            <Route path="/deals" element={<DealListPage />} />
            <Route path="/deals/new" element={<DealNewPage />} />
            <Route path="/deals/:id" element={<DealDetailPage />} />
            <Route path="/deals/:id/edit" element={<DealEditPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/contacts" element={<ContactListPage />} />
            <Route path="/contacts/new" element={<ContactNewPage />} />
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
            <Route path="/contacts/:id/edit" element={<ContactEditPage />} />
            <Route path="/email" element={<EmailInboxPage />} />
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="/files" element={<PlaceholderPage title="Files" />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/projects" element={<PlaceholderPage title="Projects" />} />
            <Route path="/director" element={<DirectorDashboardPage />} />
            <Route path="/director/rep/:repId" element={<DirectorRepDetail />} />
            <Route path="/admin/offices" element={<PlaceholderPage title="Offices" />} />
            <Route path="/admin/users" element={<PlaceholderPage title="Users" />} />
            <Route path="/admin/pipeline" element={<PlaceholderPage title="Pipeline Config" />} />
            <Route path="/admin/merge-queue" element={<MergeQueuePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
