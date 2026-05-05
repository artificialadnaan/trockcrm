import { Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { FieldLayout } from "@/components/FieldLayout";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AcceptInvitePage } from "@/pages/AcceptInvitePage";
import { HomePage } from "@/pages/HomePage";
import { LoginPage } from "@/pages/LoginPage";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<FieldLayout />}>
            <Route path="/home" element={<HomePage />} />
          </Route>
        </Route>
      </Routes>
      <Toaster position="top-center" richColors />
    </AuthProvider>
  );
}
