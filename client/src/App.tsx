import { Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DevUserPicker } from "@/components/auth/dev-user-picker";
import { AppShell } from "@/components/layout/app-shell";

function Dashboard() {
  return (
    <div>
      <h2 className="text-2xl font-bold">Dashboard</h2>
      <p className="text-muted-foreground mt-1">Welcome to T Rock CRM. Features coming soon.</p>
    </div>
  );
}

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
            <Route path="/" element={<Dashboard />} />
            <Route path="/pipeline" element={<PlaceholderPage title="Pipeline" />} />
            <Route path="/contacts" element={<PlaceholderPage title="Contacts" />} />
            <Route path="/email" element={<PlaceholderPage title="Email" />} />
            <Route path="/tasks" element={<PlaceholderPage title="Tasks" />} />
            <Route path="/files" element={<PlaceholderPage title="Files" />} />
            <Route path="/reports" element={<PlaceholderPage title="Reports" />} />
            <Route path="/projects" element={<PlaceholderPage title="Projects" />} />
            <Route path="/director" element={<PlaceholderPage title="Director Dashboard" />} />
            <Route path="/admin/offices" element={<PlaceholderPage title="Offices" />} />
            <Route path="/admin/users" element={<PlaceholderPage title="Users" />} />
            <Route path="/admin/pipeline" element={<PlaceholderPage title="Pipeline Config" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
