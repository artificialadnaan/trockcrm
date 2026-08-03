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
  ])("REGRESSION: rejects the private host %s", (url) => {
    expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
      /private host/
    );
  });

  it.each(["https://10.example.com", "https://172.16.example.com", "https://127.0.0.1.example.com"])(
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

  it.each(["https://api.example.com?x=y", "https://api.example.com#frag"])(
    "REGRESSION: rejects %s, where the appended /api path lands inside the query or fragment",
    (url) => {
      // `src/config.ts` strips only a trailing slash and a trailing `/api`, then `apiFetch`
      // concatenates `/api<path>`. It parses, it looks configured, and the request goes to `/`.
      expect(() => assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: url }))).toThrow(
        /query string or fragment/
      );
    }
  );

  it("rejects a value that is not a URL at all, rather than passing it through", () => {
    expect(() =>
      assertProductionBuildEnv(onBuilder({ EXPO_PUBLIC_API_BASE_URL: "api.example.com" }))
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
});
