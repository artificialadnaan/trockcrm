/**
 * A production build must know where the API is, or it is a wasted build.
 *
 * `EXPO_PUBLIC_API_BASE_URL` is baked in at bundle time. It lives in `mobile/.env`, which is
 * gitignored — deliberately, because the repo's disclosure policy forbids committing the production
 * API host (see src/config.ts) — and EAS builds on its own machines from the repository, so it
 * never sees that file. Unless the value is supplied as an EAS build environment variable, a
 * production build simply has no host.
 *
 * Nothing FAILS when that happens. The app compiles, uploads, installs and opens; `apiFetch` then
 * throws a clear message at the first call, which is the login screen. So the cost is discovered by
 * whoever installs the build, after the twenty minutes of building and submitting, and the fix is
 * another full build — the value cannot be changed after the fact.
 *
 * The Meta credentials already work this way: `withWearablesDat` is handed
 * `requireRegisteredMetaApp: IS_PRODUCTION_BUILD` and fails prebuild rather than ship a build that
 * finds no glasses. This is the same rule for the other half of what a production build needs.
 *
 * A LAN or loopback host is rejected as well as an absent one, and that is not hypothetical: the
 * checked-in developer setup points at `http://192.168.1.99:3002`, a laptop on a home network. If
 * that value ever reached a build, every phone in the field would fail to reach it — the same dead
 * app, arrived at from the other direction.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  // 172.16.0.0 – 172.31.255.255
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local$/i,
];

export function assertProductionBuildEnv(
  env: NodeJS.ProcessEnv,
  isProductionBuild: boolean
): void {
  if (!isProductionBuild) return;

  const raw = env.EXPO_PUBLIC_API_BASE_URL?.trim() ?? "";
  if (raw === "") {
    throw new Error(
      "EXPO_PUBLIC_API_BASE_URL is not set, and this is a production build. It is baked in at " +
        "bundle time, so a build without it installs and then cannot reach the CRM at all. " +
        "`mobile/.env` is gitignored and never reaches EAS — set it as an EAS build environment " +
        "variable: eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL --value <host>"
    );
  }

  let host: string;
  let protocol: string;
  try {
    const url = new URL(raw);
    host = url.hostname;
    protocol = url.protocol;
  } catch {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL is not a valid URL ("${raw}"). It must be an absolute https URL, ` +
        "for example https://<prod-api-host> (no trailing /api)."
    );
  }

  if (protocol !== "https:") {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must be https for a production build (got "${protocol}//"). ` +
        "iOS App Transport Security blocks cleartext by default, so this ships an app that cannot " +
        "call the API from a device."
    );
  }

  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL points at a private host ("${host}"), which no phone in the field ` +
        "can reach. This is the developer default leaking into a shipped build — set the production " +
        "API host as an EAS build environment variable instead."
    );
  }
}
