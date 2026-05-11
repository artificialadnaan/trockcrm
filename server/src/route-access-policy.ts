export const CRM_ONLY_TENANT_ROUTE_MOUNTS = [
  "/deals",
  "/pipeline",
  "/contacts",
  "/leads",
  "/projects",
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
  "/api/webhooks/synchub",
  "/api/bid-board-sync",
  "/api/public/photo-viewer",
  "/api/integrations/synchub",
  // Internal RFP relay routes are public at the tenant middleware layer but
  // authenticate each request with HMAC using SYNCHUB_SHARED_SECRET and the
  // x-rfp-request-signature header.
  "/api/internal",
] as const;
