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
  // Existing files routes stay unchanged in PR 6a; PR 6b introduces field-specific
  // photo endpoints and tightens the files surface around that allow-list.
  "/api/files",
] as const;

export const PUBLIC_ROUTE_MOUNTS = [
  "/api/auth",
  "/api/health",
  "/api/docs",
  "/api/webhooks/procore",
  "/api/bid-board-sync",
  "/api/integrations/synchub",
] as const;
