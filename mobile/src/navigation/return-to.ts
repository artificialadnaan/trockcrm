/**
 * Post-login return-to routing.
 *
 * When an unauthenticated (or expired-session) user follows a deep link — most importantly the
 * corrective-action notification's `trockcam://scorecards/corrective-action/<id>` link — the authenticated
 * `(app)` layout bounces them to `/login`. Without capturing where they were headed, a successful login
 * always lands on the projects list and the CTA is lost. These pure helpers carry the intended destination
 * across the login round-trip via a single `returnTo` query param on `/login`.
 *
 * Both cold-start (app not running → OS opens the link → the `(app)` layout mounts, sees no token, redirects)
 * and warm (app running, session just expired) paths funnel through the same `(app)` layout redirect, so
 * capturing the destination there covers both.
 */

import type { Href } from "expo-router";

export const DEFAULT_POST_LOGIN_HREF = "/(app)/projects" as const;

/** Route path from `usePathname()` (group segments already stripped). */
export type LinkParams = Record<string, string | string[] | undefined>;

// Path prefixes we must never bounce back to — they are the auth/boot surfaces themselves, so returning to
// them would loop or be meaningless.
const NON_RETURNABLE = ["/login", "/accept-invite"];

function normalizePathname(pathname: string | undefined | null): string | null {
  if (!pathname) return null;
  const trimmed = pathname.trim();
  // Only in-app absolute paths are valid destinations — never an external URL or a scheme-relative one.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  // The bare boot route carries no intent worth preserving.
  if (trimmed === "/" || trimmed === "/index") return null;
  for (const prefix of NON_RETURNABLE) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix}/`)) return null;
  }
  return trimmed;
}

/**
 * Serialize a query string from route params, EXCLUDING the dynamic path segments already baked into
 * `pathname`. Only genuine query params (e.g. the corrective-action link's `token`) are carried; the id
 * segment lives in the path itself. Skips any `returnTo` to avoid nesting one capture inside another.
 */
function serializeQuery(params: LinkParams | undefined, pathSegments: Set<string>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (key === "returnTo") continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === "") continue;
    // A param whose value is already present as a path segment is a dynamic-route segment
    // (expo-router surfaces both `id` and its value); it's in `pathname`, so don't duplicate it.
    if (pathSegments.has(value)) continue;
    search.append(key, value);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Build the `returnTo` value to attach to `/login` from the destination the user was blocked from reaching.
 * Returns `null` when there is no meaningful destination to preserve (bare boot, an auth screen, or an
 * off-app path) — the caller then redirects to `/login` with no param and login falls back to projects.
 */
export function buildLoginReturnTo(pathname: string | undefined | null, params?: LinkParams): string | null {
  const path = normalizePathname(pathname);
  if (!path) return null;
  const pathSegments = new Set(path.split("/").filter(Boolean));
  return `${path}${serializeQuery(params, pathSegments)}`;
}

/**
 * Resolve the destination to navigate to after a successful login. Accepts the raw `returnTo` login param
 * and returns a safe in-app href, falling back to the projects list when there is no valid pending
 * destination. Re-validates the incoming value (it round-trips through a URL param and could be tampered
 * with or empty) so login can never be steered off-app or back into a `/login` loop.
 */
export function resolvePostLoginHref(returnTo: string | string[] | undefined): Href {
  const raw = Array.isArray(returnTo) ? returnTo[0] : returnTo;
  if (!raw) return DEFAULT_POST_LOGIN_HREF;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed percent-encoding means we can't trust it — fall back.
    return DEFAULT_POST_LOGIN_HREF;
  }
  const [pathPart] = decoded.split("?");
  if (!normalizePathname(pathPart)) return DEFAULT_POST_LOGIN_HREF;
  // `decoded` is a re-validated absolute in-app path (see normalizePathname: starts with a single "/", not an
  // auth/boot screen, not external). Typed routes model Href as a union of route literals, which a runtime
  // string can't satisfy statically — this single cast at the trusted boundary is the standard expo-router
  // pattern for a dynamically-built, validated href.
  return decoded as Href;
}
