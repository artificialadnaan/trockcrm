// Same shape as withWearablesDat.test.ts: the module is CommonJS `.js`, because Expo requires
// what app.config.ts imports as-is and cannot load a `.ts` sibling.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertProductionBuildEnv } = require("../assert-production-build-env") as {
  assertProductionBuildEnv: (env: NodeJS.ProcessEnv) => void;
};

/**
 * The build-time half of "a production build must know where it is pointed".
 *
 * `EXPO_PUBLIC_API_BASE_URL` is baked in at bundle time and lives in a gitignored `.env` that EAS
 * never sees, so without an EAS environment variable a production build has no host — and nothing
 * fails. It compiles, uploads, installs, opens, and dies at the login screen, twenty minutes of
 * building and submitting later, with no way to fix it but another build.
 */
const onBuilder = (rest: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  EAS_BUILD: "true",
  EAS_BUILD_PROFILE: "production",
  ...rest,
});

describe("assertProductionBuildEnv", () => {
  it("REGRESSION: fails a production build with no API host, instead of shipping one that cannot log in", () => {
    expect(() => assertProductionBuildEnv(onBuilder())).toThrow(/EXPO_PUBLIC_API_BASE_URL is not set/);
  });

  it("REGRESSION: runs only ON THE BUILDER, so a local production build is not aborted before it starts", () => {
    // EAS evaluates app.config.ts locally to read the slug, version and fingerprint — and a
    // secret-visibility variable is readable only on EAS's machines. Keying off the profile alone
    // would abort every `eas build --profile production` on the laptop that started it, reporting
    // a host missing that is present exactly where it is needed. That would make the documented
    // secret setup unbuildable, which is worse than the silent failure this replaces.
    expect(() => assertProductionBuildEnv({ EAS_BUILD_PROFILE: "production" })).not.toThrow();
    expect(() => assertProductionBuildEnv({ EAS_BUILD: "true" })).not.toThrow();
    expect(() =>
      assertProductionBuildEnv({ EAS_BUILD: "true", EAS_BUILD_PROFILE: "preview" })
    ).not.toThrow();
  });

  it("REGRESSION: fails on the developer LAN host, which no phone in the field can reach", () => {
    // Not hypothetical: this is the value in the checked-in developer setup.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "http://192.168.1.99:3002" }))
    ).toThrow(/https/);
  });

  it.each([
    "https://localhost:3002",
    "https://127.0.0.1:3002",
    "https://10.0.0.5",
    "https://172.16.4.4",
    "https://169.254.1.1",
    "https://mac-studio.local",
    // IPv6: `new URL()` accepts these and they are exactly as unreachable.
    "https://[::1]:3002",
    "https://[fc00::1]",
    "https://[fe80::1]",
    // Carrier-grade NAT: a tailnet or developer-VPN address. net.isIP calls it IPv4 and it is not
    // globally routable, so it is a plausible paste that no field phone can reach.
    "https://100.64.0.1",
    "https://100.100.1.1",
    // IPv4 embedded in IPv6 — slips past every IPv6 rule unless the IPv4 question is asked of it.
    "https://[::ffff:10.0.0.5]",
    // Documentation, benchmarking and test ranges are equally unreachable.
    "https://192.0.2.10",
    "https://198.51.100.10",
    "https://203.0.113.10",
    "https://198.18.0.1",
    "https://[2001:db8::1]",
    // `.localhost` is a whole special-use namespace, not just the bare name.
    "https://api.localhost",
    "https://api.localhost.",
    // IPv4-COMPATIBLE IPv6 (::/96, deprecated): normalises to `::a00:5`, carrying no `ffff` marker.
    "https://[::10.0.0.5]",
    // RFC 6761 / RFC 8375 special-use names — guaranteed not to resolve publicly.
    "https://api.test",
    "https://api.invalid",
    "https://local",
    "https://api.home.arpa",
  ])("REGRESSION: rejects the private host %s", (url) => {
    expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
      /private host/
    );
  });

  it.each([
    "https://10.example.com",
    "https://172.16.example.com",
    "https://127.0.0.1.example.com",
    "https://100.64.example.com",
    // A public IP must still be accepted — the rule is "not globally routable", not "is an IP".
    "https://8.8.8.8",
    "https://99.99.99.99",
  ])(
    "GUARD: accepts the ordinary domain %s, which only LOOKS like a private range",
    (url) => {
      // The private-range patterns are applied only to something `net.isIP` calls an IP. Matching
      // them against hostnames refuses perfectly routable domains that happen to start with digits.
      expect(() =>
        assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))
      ).not.toThrow();
    }
  );

  it("REGRESSION: rejects cleartext http, which iOS blocks by default", () => {
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "http://api.example.com" }))
    ).toThrow(/must be https/);
  });

  it.each([
    "https://api.example.com?x=y",
    "https://api.example.com#frag",
    // BARE delimiters: `url.search`/`url.hash` normalise these to "", so a component check misses
    // them — but `src/config.ts` keeps the raw string and the API path lands in the query anyway.
    "https://api.example.com?",
    "https://api.example.com#",
  ])(
    "REGRESSION: rejects %s, where the appended /api path lands inside the query or fragment",
    (url) => {
      // `src/config.ts` strips only a trailing slash and a trailing `/api`, then `apiFetch`
      // concatenates `/api<path>`. It parses, it looks configured, and the request goes to `/`.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
        /query string or fragment/
      );
    }
  );

  it.each(["https:/api.example.com", "https:api.example.com"])(
    "REGRESSION: rejects the repaired separator typo %s",
    (url) => {
      // The WHATWG parser repairs both to `https://api.example.com/`, so every later check passes —
      // but `src/config.ts` keeps the RAW string and NSURL gets an https scheme with no host.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
        /must begin with/
      );
    }
  );

  it.each([
    // EXTRA SLASHES. Both satisfy a `^https://` test and the parser repairs them to
    // `https://api.example.com/`, so every later check saw a healthy host — while `src/config.ts`
    // keeps the raw spelling and iOS receives an https URL with an EMPTY authority.
    "https:///api.example.com",
    "https:////api.example.com",
    // BACKSLASHES. The same repair by a different route: WHATWG treats `\` as `/` for special
    // schemes, so these normalise identically. A rule that only counted forward slashes would fix
    // the reported spelling and leave this one, which is the same bug wearing a different hat.
    "https://\\api.example.com",
    "https://\\\\api.example.com",
    // STRIPPED CHARACTERS. Tabs, newlines and carriage returns are removed ANYWHERE in the input
    // before parsing, so the parser sees a clean URL and the raw string still carries the junk.
    "https://\tapi.example.com",
    "https://api.example\n.com",
    "https://api.example\r.com",
    // THE REST OF THE CLASS. The check is a control-character RANGE (U+0000-U+0020 plus U+007F), and
    // only tab and newline were ever asserted — narrowing it to just those three left the whole suite
    // green. These pin the range's ends and its interior, so the bound cannot be quietly shrunk.
    // (They must sit MID-host: a trailing one is stripped by the `.trim()` that runs first, which is
    // correct behaviour and a different case.)
    "https://api\u0000.example.com",
    "https://api\u001f.example.com",
    "https://api\u007f.example.com",
    "https://api example.com",
  ])("REGRESSION: rejects %j, which the parser repairs into a host the app never sends", (url) => {
    expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
      /must begin with/
    );
  });

  it.each([
    // A LATER backslash, not a leading one. The first-character rule below caught `https://\host` and
    // walked straight past these: `new URL()` rewrites the `\` to `/` while `src/config.ts` keeps the
    // raw spelling, so the device asks for a different path than the one configured.
    "https://api.example.com\\v1",
    "https://api.example.com/foo\\bar",
  ])("REGRESSION: rejects a backslash anywhere in %j, not only at the authority", (url) => {
    expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
      /must begin with/
    );
  });

  it("REGRESSION: rejects credentials embedded in the base URL", () => {
    // `EXPO_PUBLIC_*` is baked into the BUNDLE, so a password here ships to every device and can be
    // read out of the app. It also collides with the Bearer flow the client actually uses: URL
    // credentials invoke a different authentication path entirely.
    expect(() =>
      assertProductionBuildEnv(
        onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://user:password@api.example.com" })
      )
    ).toThrow(/credential/i);
  });

  it.each(["https://[ff02::1]", "https://[ff00::1]"])(
    "REGRESSION: rejects the IPv6 multicast address %s, which cannot terminate a TCP connection",
    (url) => {
      // `ff00::/8` is multicast. The unique-local test is `^f[cd]` and link-local is `^fe[89ab]`, so
      // `ff` fell through every arm to the global default and a build was allowed against an address
      // no HTTPS server can listen on.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
        /private host/
      );
    }
  );

  it("REGRESSION: rejects the IPv6 discard-only prefix", () => {
    // `100::/64` exists to BLACKHOLE traffic — packets to it are dropped by design, so it is not
    // merely unrouted, it is guaranteed to go nowhere.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://[100::1]" }))
    ).toThrow(/private host/);
  });

  it.each(["https://[100:0:0:1::1]", "https://[100:0:1::1]", "https://[100:1::1]"])(
    "rejects %s too — outside the /64 discard prefix but still inside reserved 0100::/8",
    (url) => {
      // THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE, and was wrong in a way worth recording: it
      // called these "globally routable" and required them to be ACCEPTED. They are not routable.
      // `100::/64` is the discard prefix, but the enclosing `0100::/8` is IANA-reserved in full and
      // has never been allocated for global unicast, so a phone in the field cannot reach any of it.
      //
      // The sequence was: a `^100:` test matched sixteen bits and over-rejected; correcting it to
      // four hextets under-rejected; and this test then pinned the under-rejection in place. A test
      // that encodes the bug is worse than no test, because it makes the next reader defend it.
      //
      // Over-rejecting failed loudly on the build machine. Under-rejecting ships an app that cannot
      // reach its API, which is exactly what this guard exists to prevent.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
        /private host/
      );
    }
  );

  it.each(["https://[200::1]", "https://[2600:1f18::1]"])(
    "still ACCEPTS %s, so the /8 rejection did not become another over-rejection",
    (url) => {
      // The boundary that matters: `0100::/8` is the top octet 0x01 alone. `200::` and a real
      // globally-allocated `2600::/12` address sit outside it and must still build.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).not.toThrow();
    }
  );

  it.each(["https://[100::1]", "https://[100::1:2:3:4]", "https://[100:0:0:0:1:2:3:4]"])(
    "still rejects %s, the discard prefix itself",
    (url) => {
      // The narrowing must not become a hole. Note the third spelling normalises to `100::1:2:3:4`,
      // so the two forms are the same address written differently — which is exactly why this is
      // decided by expanding the address rather than by matching its text.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
        /private host/
      );
    }
  );

  it("GUARD: accepts global unicast that merely starts with the same digits", () => {
    // The hextet boundary again: a bare "100" prefix test would swallow `1000::/16` and `100a::`,
    // which are ordinary global addresses.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://[1000::1]" }))
    ).not.toThrow();
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://[100a::1]" }))
    ).not.toThrow();
  });

  it.each([
    "https://api..example.com",
    "https://-api.example.com",
    "https://api-.example.com",
  ])("REGRESSION: rejects the malformed DNS name %s, which can have no host record", (url) => {
    // The URL parser is far more permissive than DNS. An empty label is unrepresentable in the wire
    // format, and a leading or trailing hyphen is illegal — so these are not unlikely names, they are
    // impossible ones, and the build shipped unable to resolve its own API.
    //
    // These used to expect /private host/, because "impossible name" was folded into isPrivateHost.
    // They are now their own error: a typo is not a LAN leak, and telling someone their build points
    // at "the developer default" when they actually mistyped the host sends them hunting for an
    // address they never set.
    expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
      /not a resolvable hostname/
    );
  });

  it("GUARD: accepts ordinary names with hyphens and a fully-qualified trailing dot", () => {
    // The syntax rule must not become a hole in the other direction: an internal hyphen is legal, and
    // a single trailing dot is just the fully-qualified spelling.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api-prod.trock-gc.com" }))
    ).not.toThrow();
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api.trockgc.com." }))
    ).not.toThrow();
  });

  it("GUARD: still accepts an IPv6 literal spelled with leading zeros", () => {
    // The counterweight to the rule above, and the reason it is written as "what will the parser
    // rewrite" rather than "does the raw authority equal the parsed host": comparing them would
    // reject `[2606:0050::1]` — a perfectly valid global address the parser merely compresses to
    // `[2606:50::1]` — and block a legitimate build for a spelling preference.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://[2606:0050::1]" }))
    ).not.toThrow();
  });

  it.each(["https://[2001:db80::1]", "https://[2001:db8f::1]"])(
    "GUARD: accepts %s, which is global unicast and not the documentation range",
    (url) => {
      // `2001:db8::/32` is the documentation prefix, and a textual `startsWith("2001:db8")` also
      // swallows the sixteen distinct hextets `db80`–`db8f`. Those are ordinary global addresses, so
      // the guard was refusing to build against a host that works.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).not.toThrow();
    }
  );

  it("still rejects the actual documentation range", () => {
    // The boundary fix must not become a hole: `2001:db8::/32` itself is still unroutable.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://[2001:db8::1]" }))
    ).toThrow();
  });

  it("REGRESSION: rejects port 0, which is reserved and can host nothing", () => {
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api.example.com:0" }))
    ).toThrow(/port 0/);
  });

  it("rejects a bare hostname with no scheme", () => {
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "api.example.com" }))
    ).toThrow(/must begin with/);
  });

  it("rejects a value that carries the scheme but parses to nothing", () => {
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://[not-an-address" }))
    ).toThrow(/not a valid URL/);
  });

  it("GUARD: accepts a public https host, with or without a trailing path", () => {
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api.example.com" }))
    ).not.toThrow();
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api.example.com/" }))
    ).not.toThrow();
  });

  it("GUARD: accepts an underscore in a label, which is a legal DNS label and does resolve", () => {
    // Folding "impossible name" into isPrivateHost also rejected this, and reported it as a LAN
    // leak. Refusing a host that would have worked is the expensive direction for a build gate.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api_prod.example.com" }))
    ).not.toThrow();
  });

  it("names a malformed host as a TYPO, not as a private host", () => {
    // The two need different messages: "points at a private host — the developer default leaking
    // into a shipped build" sends whoever hits a typo looking for a LAN address they never set.
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://api..example.com" }))
    ).toThrow(/not a resolvable hostname/);
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "https://-api.example.com" }))
    ).toThrow(/not a resolvable hostname/);
  });
});

/**
 * THE WIRING, which is a separate question from whether the assertion works.
 *
 * Every test above imports the module directly, so all of them pass with the call in
 * `app.config.ts` DELETED — verified by mutation: commenting out `assertProductionBuildEnv(
 * process.env)` left the whole 1284-test mobile suite green. One line is the entire reason this
 * feature exists, and nothing exercised it.
 *
 * These require `app.config.ts` itself, so the assertion has to actually be reached through the file
 * that Expo loads. Note this is only meaningful because the `mobile` CI job (premerge-build-gate.yml)
 * runs this suite — the native half of this app is not compiled by anything, but this part is.
 */
describe("app.config.ts wiring", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  const loadConfigModule = () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../app.config");
    });
  };

  it("REGRESSION: app.config.ts CALLS the assertion — deleting that one line must fail this test", () => {
    process.env.EAS_BUILD = "true";
    process.env.EAS_BUILD_PROFILE = "production";
    // A LAN host rather than an absent one, deliberately. `mobile`'s own `test` script exports
    // EXPO_PUBLIC_API_BASE_URL=https://api.test.local, so "unset" is not a state this suite can
    // reliably reach — and an assertion that depends on unsetting it would be testing the harness.
    // A private host is unambiguous either way, and it is the case that actually leaks.
    process.env.EXPO_PUBLIC_API_BASE_URL = "https://192.168.1.99:3002";

    expect(loadConfigModule).toThrow(/points at a private host/);
  });

  it("REGRESSION: and reading the config off the builder still loads cleanly", () => {
    // The dev path. If this ever throws, the guard has escaped its scope and bricked local work —
    // the failure mode that matters more than the one it prevents.
    delete process.env.EAS_BUILD;
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;

    expect(loadConfigModule).not.toThrow();
  });
});
