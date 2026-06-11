// The API base URL is provided by the environment (an EAS build-time env var or
// a local .env) and is never hard-coded — the trockcrm repo's disclosure policy
// forbids committing the production API host. Point it at the trockcrm field API
// (no trailing /api; the client appends it). See README "Environment".
//
// We resolve at import but do NOT throw here: an import-time throw would crash the
// app before the login screen can render (and would break pure-logic test imports
// — see api/__tests__/client.test.ts). Instead apiFetch throws a clear error at
// call time if the host is missing.
const RAW = process.env.EXPO_PUBLIC_API_BASE_URL?.trim() ?? "";

// Strip any trailing slashes and a trailing "/api" so callers append "/api<path>".
export const API_BASE_URL = RAW.replace(/\/+$/, "").replace(/\/api$/, "");

export const API_BASE_URL_MISSING_MESSAGE =
  "EXPO_PUBLIC_API_BASE_URL is not set. Define it (an EAS build env var or .env) " +
  "as the trockcrm API base URL, e.g. https://<prod-api-host> (no trailing /api).";
