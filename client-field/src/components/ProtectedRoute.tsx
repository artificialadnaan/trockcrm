import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { UserRole } from "@trock-crm/shared/types";
import { useAuth } from "@/lib/auth";

const FIELD_APP_ALLOWED_ROLES = new Set<UserRole>([
  "admin",
  "director",
  "rep",
  "construction",
  "field_contractor",
]);

export function ProtectedRoute() {
  const { user, loading, logout } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="p-6 text-center text-muted-foreground">Loading...</div>;
  }

  if (!user) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  if (!FIELD_APP_ALLOWED_ROLES.has(user.role)) {
    void logout();
    return <Navigate to="/" replace state={{ authError: "Field app access required" }} />;
  }

  return <Outlet />;
}
