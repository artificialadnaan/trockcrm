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
 * Whether an address is GLOBALLY ROUTABLE — asked as a range question, not a pattern-match.
 *
 * The question is not "is this RFC1918" but "can a phone on a cell network reach it", and those are
 * different sets. Carrier-grade NAT (`100.64.0.0/10`) is neither private nor reachable: it is what a
 * tailnet or a developer VPN hands out, so `https://100.100.1.1` is a plausible thing to paste in
 * and is unreachable from every field device. Benchmarking and documentation ranges have the same
 * property. Enumerating "private" would have kept missing these one at a time; enumerating
 * NOT-GLOBAL is the complete question.
 *
 * Checked ONLY against something `net.isIP` calls an IP. Applied to hostnames, a rule for
 * `10.0.0.5` refuses `10.example.com` — a perfectly ordinary domain.
 */
function ipv4IsGlobal(host) {
  const [a, b, c] = host.split(".").map(Number);
  if (a === 0) return false; // 0.0.0.0/8 — "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 — carrier-grade NAT, tailnets
  if (a === 169 && b === 254) return false; // link-local, what DHCP failure leaves behind
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 — benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return true;
}

function ipv6IsGlobal(host) {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return false; // loopback, unspecified
  // IPv4-mapped forms carry an IPv4 address; ask the IPv4 question about it, or `::ffff:10.0.0.5`
  // slips through every IPv6 rule below.
  //
  // BOTH SPELLINGS, because `new URL()` rewrites the readable one: `https://[::ffff:10.0.0.5]` comes
  // back as `[::ffff:a00:5]`, hex, and a dotted-quad pattern never sees it. That normalisation is
  // exactly the kind of thing a guard is asserted against rather than reasoned about.
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return ipv4IsGlobal(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipv4IsGlobal(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (/^f[cd]/.test(h)) return false; // fc00::/7 — unique-local
  if (/^fe[89ab]/.test(h)) return false; // fe80::/10 — link-local
  if (h.startsWith("2001:db8")) return false; // documentation
  return true;
}

/**
 * Names that resolve to the local machine or the local segment.
 *
 * `.localhost` is a whole special-use namespace (RFC 6761), not just the bare name: `api.localhost`
 * resolves to loopback on every resolver that honours it, so a phone pointed there calls ITSELF.
 * The optional trailing dot is the fully-qualified spelling of the same name.
 */
const PRIVATE_HOSTNAME_PATTERNS = [/(^|\.)localhost\.?$/i, /\.local\.?$/i];

function isPrivateHost(host) {
  const family = net.isIP(host);
  if (family === 4) return !ipv4IsGlobal(host);
  if (family === 6) return !ipv6IsGlobal(host);
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
  // Tested on the RAW value, not on `url.search`/`url.hash`, which normalise a BARE delimiter to
  // "". `https://host?` and `https://host#` therefore passed — and `src/config.ts` keeps the raw
  // string, so the built URL becomes `https://host?/api/auth/field-login`: pathname `/`, the entire
  // API path sitting in the query. Verified, not assumed.
  if (/[?#]/.test(raw)) {
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
