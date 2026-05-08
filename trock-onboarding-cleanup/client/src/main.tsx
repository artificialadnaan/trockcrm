import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout";
import { AdminReassignPage } from "./pages/admin-reassign-page";
import { AdminProgressDetailPage } from "./pages/admin-progress-detail-page";
import { AdminProgressPage } from "./pages/admin-progress-page";
import { CleanupDashboard } from "./pages/cleanup-dashboard";
import { CleanupSummaryReportPage } from "./pages/cleanup-summary-report-page";
import { LoginPage } from "./pages/login-page";
import { RecordEditPage } from "./pages/record-edit-page";
import { RecordListPage } from "./pages/record-list-page";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AppLayout />}>
            <Route path="/cleanup" element={<CleanupDashboard />} />
            <Route path="/cleanup/:type" element={<RecordListPage />} />
            <Route path="/cleanup/:type/:id" element={<RecordEditPage />} />
            <Route path="/admin/reassign" element={<AdminReassignPage />} />
            <Route path="/admin/progress" element={<AdminProgressPage />} />
            <Route path="/admin/progress/:userId" element={<AdminProgressDetailPage />} />
            <Route path="/admin/reports/cleanup-summary" element={<CleanupSummaryReportPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
