import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { isGlobalAdmin } from "@/lib/roles";

type Role = "admin" | "director" | "sales_manager" | "rep" | "construction";

interface RequireRoleProps {
  allowedRoles: readonly Role[];
  children: ReactNode;
  fallbackTo?: string;
}

export function RequireRole({
  allowedRoles,
  children,
  fallbackTo = "/",
}: RequireRoleProps) {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to={fallbackTo} replace />;
  }

  return <>{children}</>;
}

/**
 * Gate a route on GLOBAL-admin (home/base role), matching the server's requireGlobalAdmin on the
 * user-provisioning endpoints. Use this — not RequireRole allowedRoles={["admin"]} (effective role) —
 * for admin pages whose server routes are base-role gated, so a real global admin viewing an office
 * where they hold a non-admin override isn't redirected away from their own admin page.
 */
export function RequireGlobalAdmin({ children, fallbackTo = "/" }: { children: ReactNode; fallbackTo?: string }) {
  const { user } = useAuth();
  if (!isGlobalAdmin(user)) {
    return <Navigate to={fallbackTo} replace />;
  }
  return <>{children}</>;
}
