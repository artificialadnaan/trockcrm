// Where TROCK Scope lives, so the deal page's AI-walk panel can send an estimator to the walkthrough's
// review screen. Correcting an extracted line item happens THERE, not here — the CRM panel is read-only —
// so this link is the whole of the "fix it" path, and its absence is a real loss of capability rather than
// a missing decoration.
//
// THE CLIENT HAS EXACTLY ONE CHANNEL FOR CONFIGURATION, and it is this one. Vite inlines `import.meta.env`
// at build time and only for the `VITE_`/`PROPOSAL_` prefixes (client/vite.config.ts); there is no runtime
// config endpoint in this app, and the API's own `TROCK_SCOPE_BASE_URL` sits beside `TROCK_SCOPE_SERVICE_TOKEN`
// in the server's environment and is exposed on no response the client reads. So the base URL arrives the
// same way the field app's origin does (`VITE_FIELD_APP_URL`, lib/field-app.ts) — a build-time variable —
// and this module is the twin of that one on purpose.
//
// NULL IS A SUPPORTED ANSWER and every caller renders without the link when it comes back. Hardcoding a
// host instead would be worse than omitting it: TROCK Scope has no stable public origin yet (the design doc
// records that it is deliberately not deployed), so a baked-in guess ships a link that 404s today and, if
// that hostname is ever handed to a different service, points an estimator at somebody else's application.
// A dead link that looks live is much harder to notice than a link that is simply not there.

/** A trailing-slash-free origin, or null for "not configured". Shared by both exports so a base URL with a
 *  trailing slash cannot produce `https://scope.example.com//walkthroughs/...` — some routers treat the
 *  empty path segment as a distinct route and 404 on it. */
function trimOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export function resolveTrockScopeBaseUrl(
  env: { VITE_TROCK_SCOPE_URL?: string | undefined } = (import.meta as any).env ?? {}
): string | null {
  return trimOrigin(env.VITE_TROCK_SCOPE_URL);
}

/**
 * The review screen for one TROCK Scope walkthrough, or null when there is nothing to link to.
 *
 * Null for TWO distinct reasons, both of which the caller handles identically (render no link) but which
 * are not the same fact: the origin is not configured for this build, or this walk has no remote
 * walkthrough yet — a walk in `processing` has `scopeWalkthroughId === null`, and a URL built from that
 * would read `/walkthroughs/null/review`.
 *
 * The id is percent-encoded even though every value we issue is a uuid. It arrives over the wire from a
 * separate service on its own release cadence, so it is not this module's fact to assume; encoding costs
 * nothing and stops an id containing `/` or `?` from silently becoming a different URL.
 */
export function buildTrockScopeReviewUrl(
  scopeWalkthroughId: string | null | undefined,
  env: { VITE_TROCK_SCOPE_URL?: string | undefined } = (import.meta as any).env ?? {}
): string | null {
  const baseUrl = resolveTrockScopeBaseUrl(env);
  if (!baseUrl) return null;
  const id = scopeWalkthroughId?.trim();
  if (!id) return null;
  return `${baseUrl}/walkthroughs/${encodeURIComponent(id)}/review`;
}
