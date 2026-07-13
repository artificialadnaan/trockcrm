/**
 * True only when GET /api/session returned the demo service's exact JSON ({ authenticated: true }).
 *
 * The /ai-demo route ships in the SHARED client bundle, so on the CRM service an unknown
 * /api/session request falls through to the SPA shell (HTML, status 200). Trusting the status alone
 * would falsely mark the viewer authenticated and skip the DEMO_PASSWORD gate — so we require the
 * exact JSON payload that requireDemoSession emits.
 */
export async function isDemoSessionResponse(r: {
  ok: boolean;
  json: () => Promise<unknown>;
}): Promise<boolean> {
  if (!r.ok) return false;
  const data = (await r.json().catch(() => null)) as { authenticated?: unknown } | null;
  return data?.authenticated === true;
}
