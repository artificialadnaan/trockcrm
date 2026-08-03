const net = require("net");

/**
 * A production build must know where the API is, or it is a wasted build.
 *
 * `EXPO_PUBLIC_API_BASE_URL` is baked in at bundle time. It lives in `mobile/.env`, which is
 * gitignored — deliberately, because the repo's disclosure policy forbids committing the production
 * API host (see src/config.ts) — and EAS builds on its own machines from the repository, so it
 * never sees that file. Unless the value is supplied as an EAS environment variable, a production
 * build simply has no host.
 *
 * Nothing FAILS when that happens. The app compiles, uploads, installs and opens; `apiFetch` then
 * throws a clear message at the first call, which is the login screen. So the cost is discovered by
 * whoever installs the build, after the twenty minutes of building and submitting, and the fix is
 * another full build — the value cannot be changed after the fact.
 *
 * The Meta credentials already work this way: `withWearablesDat` is handed
 * `requireRegisteredMetaApp` and fails prebuild rather than ship a build that finds no glasses.
 * This is the same rule for the other half of what a production build needs.
 *
 * ONLY ON THE BUILDER, and that qualification is load-bearing rather than cautious. EAS evaluates
 * this config LOCALLY before it uploads anything — to read the slug, the version and the
 * fingerprint — and a variable stored with secret visibility is readable only on EAS's own
 * machines. Keying this off the build profile alone would abort every
 * `eas build --profile production` on the developer's laptop, reporting a host missing that is
 * present exactly where it is needed, and would make the documented secret setup unbuildable —
 * worse than the silent failure it replaces. `EAS_BUILD` is set only by the builder, so the check
 * runs there, where the secrets exist and where failing still costs nothing but a build.
 *
 * CommonJS, and a `.js`, to match `withWearablesDat.js`. `app.config.ts` is transpiled by Expo's
 * config loader, but the modules it imports are required by Node as-is — so a `.ts` sibling cannot
 * be loaded at all, and importing one makes `expo config` exit non-zero with no output, which is
 * exactly as much explanation as a failing build would have given.
 */

/**
 * Private IP ranges, checked ONLY against something that is actually an IP.
 *
 * Applying these to hostnames is how `10.example.com` — a perfectly ordinary domain — gets refused
 * by a rule meant for `10.0.0.5`. `net.isIP` is what separates the two, so the patterns below never
 * see a name.
 *
 * Both families, because `new URL()` accepts either and an IPv6 loopback is exactly as unreachable
 * as an IPv4 one. Link-local is included on both sides — `169.254.0.0/16` and `fe80::/10` — because
 * a self-assigned address is what a machine ends up with when DHCP fails, reachable from nothing but
 * the same wire.
 */
const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // loopback
  /^0\./, // unspecified / "this network"
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918, 172.16–172.31
  /^169\.254\./, // link-local
];

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/, // loopback
  /^::$/, // unspecified
  /^[fF][cCdD]/, // unique-local, fc00::/7
  /^[fF][eE][89abAB]/, // link-local, fe80::/10
];

/** Names that resolve only on the local machine or the local segment. */
const PRIVATE_HOSTNAME_PATTERNS = [/^localhost$/i, /\.local$/i];

function isPrivateHost(host) {
  const family = net.isIP(host);
  if (family === 4) return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host));
  if (family === 6) return PRIVATE_IPV6_PATTERNS.some((pattern) => pattern.test(host));
  return PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(host));
}

function assertProductionBuildEnv(env) {
  // Not merely "the production profile" — see the header. Local config evaluation cannot see a
  // secret-visibility variable, so asserting there would break the very setup this recommends.
  if (env.EAS_BUILD !== "true" || env.EAS_BUILD_PROFILE !== "production") return;

  const raw = env.EXPO_PUBLIC_API_BASE_URL?.trim() ?? "";
  if (raw === "") {
    throw new Error(
      "EXPO_PUBLIC_API_BASE_URL is not set, and this is a production build. It is baked in at " +
        "bundle time, so a build without it installs and then cannot reach the CRM at all. " +
        "`mobile/.env` is gitignored and never reaches EAS — set it as an EAS environment " +
        "variable: eas env:create --scope project --name EXPO_PUBLIC_API_BASE_URL --value <host>"
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL is not a valid URL ("${raw}"). It must be an absolute https URL, ` +
        "for example https://<prod-api-host> (no trailing /api)."
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must be https for a production build (got "${url.protocol}//"). ` +
        "iOS App Transport Security blocks cleartext by default, so this ships an app that cannot " +
        "call the API from a device."
    );
  }

  // A QUERY OR FRAGMENT IS NOT A BASE URL. `src/config.ts` strips only trailing slashes and a
  // trailing `/api`, and `apiFetch` then concatenates `/api<path>` onto what is left — so
  // `https://host?x=y` becomes `https://host?x=y/api/...`, where the API path is part of the query
  // and the request goes to `/`. It parses, it looks configured, and the build still cannot log in.
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must not carry a query string or fragment (got "${raw}"). The ` +
        "client appends `/api<path>` to this value, so anything after the host ends up inside the " +
        "query or fragment and the request never reaches the API."
    );
  }

  // IPv6 hostnames come back bracketed from `new URL()`.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(host)) {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL points at a private host ("${host}"), which no phone in the field ` +
        "can reach. This is the developer default leaking into a shipped build — set the production " +
        "API host as an EAS environment variable instead."
    );
  }
}

module.exports.assertProductionBuildEnv = assertProductionBuildEnv;
module.exports.isPrivateHost = isPrivateHost;
