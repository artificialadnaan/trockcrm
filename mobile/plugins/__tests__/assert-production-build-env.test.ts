// Same shape as withWearablesDat.test.ts: the module is CommonJS `.js`, because Expo requires
// what app.config.ts imports as-is and cannot load a `.ts` sibling.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertProductionBuildEnv } = require("../assert-production-build-env") as {
  assertProductionBuildEnv: (env: NodeJS.ProcessEnv, isProductionBuild: boolean) => void;
};

/**
 * The build-time half of "a production build must know where it is pointed".
 *
 * `EXPO_PUBLIC_API_BASE_URL` is baked in at bundle time and lives in a gitignored `.env` that EAS
 * never sees, so without an EAS build variable a production build has no host — and nothing fails.
 * It compiles, uploads, installs, opens, and dies at the login screen, twenty minutes of building
 * and submitting later, with no way to fix it but another build.
 */
const PROD = true;
const NOT_PROD = false;

describe("assertProductionBuildEnv", () => {
  it("REGRESSION: fails a production build with no API host, instead of shipping one that cannot log in", () => {
    expect(() => assertProductionBuildEnv({}, PROD)).toThrow(/EXPO_PUBLIC_API_BASE_URL is not set/);
  });

  it("REGRESSION: fails on the developer LAN host, which no phone in the field can reach", () => {
    // Not hypothetical: this is the value in the checked-in developer setup.
    expect(() =>
      assertProductionBuildEnv({ EXPO_PUBLIC_API_BASE_URL: "http://192.168.1.99:3002" }, PROD)
    ).toThrow(/https/);
  });

  it.each([
    "https://localhost:3002",
    "https://127.0.0.1:3002",
    "https://10.0.0.5",
    "https://172.16.4.4",
    "https://mac-studio.local",
  ])("REGRESSION: rejects the private host %s", (url) => {
    expect(() => assertProductionBuildEnv({ EXPO_PUBLIC_API_BASE_URL: url }, PROD)).toThrow(
      /private host/
    );
  });

  it("REGRESSION: rejects cleartext http, which iOS blocks by default", () => {
    expect(() =>
      assertProductionBuildEnv({ EXPO_PUBLIC_API_BASE_URL: "http://api.example.com" }, PROD)
    ).toThrow(/must be https/);
  });

  it("rejects a value that is not a URL at all, rather than passing it through", () => {
    expect(() =>
      assertProductionBuildEnv({ EXPO_PUBLIC_API_BASE_URL: "api.example.com" }, PROD)
    ).toThrow(/not a valid URL/);
  });

  it("GUARD: accepts a public https host", () => {
    expect(() =>
      assertProductionBuildEnv({ EXPO_PUBLIC_API_BASE_URL: "https://api.example.com" }, PROD)
    ).not.toThrow();
  });

  it("GUARD: leaves NON-production builds alone, so a dev client still points at a laptop", () => {
    // The whole developer setup is a LAN host and a dev client. Applying the rule to every profile
    // would break local work in the name of protecting a build nobody is making.
    expect(() =>
      assertProductionBuildEnv({ EXPO_PUBLIC_API_BASE_URL: "http://192.168.1.99:3002" }, NOT_PROD)
    ).not.toThrow();
    expect(() => assertProductionBuildEnv({}, NOT_PROD)).not.toThrow();
  });
});
