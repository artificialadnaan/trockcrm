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
  // Anything still leading with `::` has 96 zero bits in front of it — that is `::/96`, the
  // deprecated IPv4-COMPATIBLE space, and it is not routable. It needs its own arm because the
  // mapped patterns above require the `ffff` marker: `https://[::10.0.0.5]` normalises to `::a00:5`,
  // which carries no marker, matches no dotted pattern, and would otherwise be called global.
  if (h.startsWith("::")) return false;
  if (/^f[cd]/.test(h)) return false; // fc00::/7 — unique-local
  if (/^fe[89ab]/.test(h)) return false; // fe80::/10 — link-local
  // 2001:db8::/32 — documentation. ON THE HEXTET BOUNDARY, not as a text prefix: `startsWith` also
  // swallowed `2001:db80` through `2001:db8f`, sixteen distinct hextets of ordinary global unicast,
  // so the guard refused to build against a host that works. The trailing colon is what pins the
  // boundary — `new URL()` normalises to lowercase with leading zeros removed, so the /32 always ends
  // in `2001:db8:` (or `2001:db8::` when the rest is zero, which this also matches).
  if (/^2001:db8:/.test(h)) return false;
  // ff00::/8 — MULTICAST, and it fell through every arm above to the global default: the unique-local
  // test is `^f[cd]` and link-local is `^fe[89ab]`, so `ff02::1` matched neither. Multicast has no
  // TCP semantics at all — nothing can listen on it — so an https URL pointed there is unusable by
  // construction rather than merely unreachable from the field.
  if (/^ff/.test(h)) return false;
  // 100::/64 — the DISCARD-ONLY prefix. Packets to it are dropped by design (it exists to blackhole
  // traffic), so it is not merely unrouted, it is guaranteed to go nowhere. Matched on the hextet
  // boundary for the same reason the documentation range is: a bare "100" prefix test would also
  // swallow 1000::/16 and 100a::, which are ordinary global unicast.
  if (/^100:/.test(h)) return false;
  return true;
}

/**
 * Names that resolve to the local machine or the local segment.
 *
 * `.localhost` is a whole special-use namespace (RFC 6761), not just the bare name: `api.localhost`
 * resolves to loopback on every resolver that honours it, so a phone pointed there calls ITSELF.
 * The optional trailing dot is the fully-qualified spelling of the same name.
 */
const PRIVATE_HOSTNAME_PATTERNS = [
  // RFC 6761 / RFC 8375 special-use names, plus mDNS. Each is guaranteed NOT to resolve publicly,
  // so a build pointed at one is unreachable by definition rather than by accident. `local` and
  // `localhost` are matched as whole names as well as suffixes — the bare mDNS root is a valid
  // hostname that resolves nowhere useful.
  /(^|\.)localhost\.?$/i,
  /(^|\.)local\.?$/i,
  /(^|\.)test\.?$/i,
  /(^|\.)invalid\.?$/i,
  /(^|\.)example\.?$/i,
  /(^|\.)home\.arpa\.?$/i,
];

/**
 * Whether a name could be a real public DNS host — SYNTAX only, no lookup.
 *
 * The WHATWG parser is far more permissive than DNS: it happily accepts `api..example.com`,
 * `-api.example.com` and `api-.example.com`, `net.isIP` returns 0 for all of them, and the
 * special-use suffix list above matches none — so they reached the guard's "looks fine" default and
 * shipped a build that cannot resolve its own API.
 *
 * The rules are the ones DNS actually imposes: labels are 1-63 characters of letters, digits and
 * hyphens, and a hyphen may not start or end a label. An EMPTY label is what `api..example.com` has,
 * and it is unrepresentable in the wire format rather than merely unusual. A single trailing dot is
 * the fully-qualified spelling and is allowed, matching the suffix patterns above.
 *
 * Deliberately NOT a reachability check. Resolving here would make the outcome of a build depend on
 * the builder's DNS, which is exactly the kind of non-determinism a build gate must not have; a
 * syntactically impossible name is decidable without asking anybody.
 */
function isSyntacticallyResolvableHostname(host) {
  const withoutRootDot = host.endsWith(".") ? host.slice(0, -1) : host;
  if (withoutRootDot === "" || withoutRootDot.length > 253) return false;
  return withoutRootDot
    .split(".")
    .every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isPrivateHost(host) {
  const family = net.isIP(host);
  if (family === 4) return !ipv4IsGlobal(host);
  if (family === 6) return !ipv6IsGlobal(host);
  // A name that cannot exist is treated as unreachable, which is what the caller's message says.
  if (!isSyntacticallyResolvableHostname(host)) return true;
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

  // THE RAW SPELLING, checked before parsing, because the WHATWG parser REPAIRS separator typos.
  // `https:/api.example.com` and `https:api.example.com` both parse to `https://api.example.com/`,
  // so every check below would pass — but `src/config.ts` keeps the raw string, and the request
  // React Native hands to NSURL is `https:/api.example.com/api/...`: an https scheme with no
  // network host. It parses here and reaches nothing there.
  // Cleartext first, because it is by far the likeliest mistake and deserves the specific reason.
  if (/^http:\/\//i.test(raw)) {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must be https for a production build (got "${raw}"). iOS App ` +
        "Transport Security blocks cleartext by default, so this ships an app that cannot call the " +
        "API from a device."
    );
  }
  // ONE RULE FOR EVERY REPAIR, rather than a list of spellings. The WHATWG parser rewrites the input
  // in three separate ways before it ever reports a host, and each of them makes a broken value look
  // healthy here while `src/config.ts` keeps the raw string that iOS actually gets:
  //
  //   * EXTRA SLASHES — `https:///host` and `https:////host` both satisfy a plain `^https://` test
  //     and are repaired to `https://host/`. NSURL sees an https scheme with an EMPTY authority.
  //   * BACKSLASHES, ANYWHERE — `\` is equivalent to `/` for special schemes. `https://\host` is the
  //     obvious spelling, but `https://host\v1` and `https://host/foo\bar` begin with a clean
  //     authority and are rewritten just the same, so the PATH the parser reports is not the path
  //     `src/config.ts` builds a request from. Rejected wherever it appears, not just at the front.
  //   * STRIPPED CHARACTERS — tab, newline and carriage return are removed from ANYWHERE in the input,
  //     and leading/trailing C0 controls and spaces are trimmed, before parsing begins.
  //
  // So the question asked is "will the parser rewrite this?", not "does this look like a URL": the
  // value must contain no character the parser strips, and the authority must begin immediately after
  // exactly two forward slashes.
  //
  // Deliberately NOT "the raw authority must equal `url.host`", which is the other obvious way to say
  // this. That comparison also rejects `https://[2606:0050::1]` — a valid global address the parser
  // merely compresses to `[2606:50::1]` — and blocking a real build over a spelling is a worse failure
  // than the one being prevented.
  if (/[ - ]/.test(raw) || raw.includes("\\") || !/^https:\/\/[^/]/i.test(raw)) {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must begin with "https://" followed immediately by the host, and may ` +
        `contain no whitespace or control characters (got ${JSON.stringify(raw)}). Values like ` +
        `"https:/host", "https:///host", "https://\\\\host" or a host with a stray tab still PARSE — ` +
        "the URL standard repairs them — but the raw string is what the app builds requests from, and " +
        "what reaches the device is an https URL with no usable authority."
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

  // CREDENTIALS IN THE URL. `EXPO_PUBLIC_*` is baked into the BUNDLE, so a password here ships to
  // every device and can be read straight out of the app — and it is not even doing what it looks
  // like: the client authenticates with a Bearer token, so URL credentials invoke a different
  // authentication path that collides with it. Refused rather than stripped, because silently
  // discarding half of what somebody configured is how a build ends up not doing what its config says.
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "EXPO_PUBLIC_API_BASE_URL must not contain credentials. This value is baked into the app " +
        "bundle and can be read out of a shipped build, and the client authenticates with a Bearer " +
        "token rather than URL credentials. Use https://<host> with no user:password@ prefix."
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

  // Port 0 is reserved and can host nothing. It parses, and every other check passes.
  if (url.port === "0") {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL specifies port 0 ("${raw}"), which is reserved and cannot host a ` +
        "service. Leave the port off to use 443."
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
