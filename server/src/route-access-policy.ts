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
  "/usage",
  "/field-responders",
  "/weekly-reports",
  // Marketing & advertising expense requests. CRM-only: submitting one is an internal-staff action, and the
  // queue exposes every requester's name, budget code and spend.
  //
  // APPENDED, never inserted. app.ts indexes this array POSITIONALLY, so putting an entry in the middle
  // silently re-points every mount after it at the wrong router.
  "/marketing-expense-requests",
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
  // The mail provider's delivery webhook. Public at the tenant-middleware layer and authenticated by the
  // provider's Standard Webhooks signature over the raw body (RESEND_WEBHOOK_SECRET); the office comes
  // from public.weekly_report_send_deliveries, not from a session, because the request carries no context.
  "/api/webhooks/resend",
  "/api/bid-board-sync",
  "/api/public/photo-viewer",
  "/api/public/daily-summary",
  "/api/public/signature-logo",
  // The client-facing weekly report viewer. NOT under /api: it serves HTML to a person, not JSON to a
  // client app, and the link goes in an email — `/wr/<token>` survives being copied out of one where
  // `/api/public/weekly-reports/<token>` does not. Unauthenticated by design; the token is the credential.
  "/wr",
  "/api/integrations/synchub",
  // Internal RFP relay routes are public at the tenant middleware layer but
  // authenticate each request with HMAC using SYNCHUB_SHARED_SECRET and the
  // x-rfp-request-signature header.
  "/api/internal",
] as const;
