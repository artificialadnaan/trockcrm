// The API base URL is provided by the environment (an EAS build-time env var or
// a local .env) and is never hard-coded — the trockcrm repo's disclosure policy
// forbids committing the production API host. Point it at the trockcrm field API
// (no trailing /api; the client appends it). See README "Environment".
const RAW = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

if (!RAW) {
  throw new Error(
    "EXPO_PUBLIC_API_BASE_URL is not set. Define it (an EAS build env var or .env) " +
      "as the trockcrm API base URL, e.g. https://<prod-api-host> (no trailing /api).",
  );
}

// Strip any trailing slashes and a trailing "/api" so callers append "/api<path>".
export const API_BASE_URL = RAW.replace(/\/+$/, "").replace(/\/api$/, "");
