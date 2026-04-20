import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";

type Role = "admin" | "director" | "rep";

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
