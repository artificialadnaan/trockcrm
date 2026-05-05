export const CRM_ONLY_TENANT_ROUTE_MOUNTS = [
  "/deals",
  "/pipeline",
  "/contacts",
  "/leads",
  "/email",
  "/call-recordings",
  "/tasks",
  "/users",
  "/activities",
  "/notifications",
  "/reports",
  "/commissions",
  "/sales-review",
  "/dashboard",
  "/procore",
  "/search",
  "/companies",
  "/properties",
  "/companycam",
  "/ai",
] as const;

export const FIELD_ACCESSIBLE_ROUTE_MOUNTS = [
  "/api/field",
] as const;

export const PUBLIC_ROUTE_MOUNTS = [
  "/api/auth",
  "/api/health",
  "/api/docs",
  "/api/webhooks/procore",
  "/api/bid-board-sync",
  "/api/public/photo-viewer",
  "/api/integrations/synchub",
] as const;
