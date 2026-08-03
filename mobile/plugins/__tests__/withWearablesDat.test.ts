/**
 * The production guard on the Meta app id.
 *
 * MetaAppID "0" is the SDK's Developer Mode sentinel: the app talks to MockDeviceKit instead of
 * real glasses. Shipping it is a total, silent failure — no device is ever eligible, every
 * walkthrough dies at pairing, and nothing in the running app can point at the missing build
 * variable. The only place that can catch it is prebuild, and the only way to prove the catch works
 * without cutting a real production build is here.
 */
const {
  resolveMetaAppId,
  DEVELOPER_MODE_APP_ID,
} = require("../withWearablesDat") as {
  resolveMetaAppId: (opts: { metaAppId?: unknown; requireRegisteredMetaApp?: boolean }) => string;
  DEVELOPER_MODE_APP_ID: string;
};

describe("resolveMetaAppId", () => {
  it("defaults to Developer Mode when nothing is set and nothing demands otherwise", () => {
    expect(resolveMetaAppId({ metaAppId: undefined, requireRegisteredMetaApp: false })).toBe(
      DEVELOPER_MODE_APP_ID
    );
    expect(resolveMetaAppId({ metaAppId: null, requireRegisteredMetaApp: false })).toBe(
      DEVELOPER_MODE_APP_ID
    );
  });

  it("passes a real app id through, production or not", () => {
    expect(resolveMetaAppId({ metaAppId: "123456789", requireRegisteredMetaApp: false })).toBe(
      "123456789"
    );
    expect(resolveMetaAppId({ metaAppId: "123456789", requireRegisteredMetaApp: true })).toBe(
      "123456789"
    );
  });

  it("fails a production build when META_APP_ID is unset", () => {
    expect(() => resolveMetaAppId({ metaAppId: undefined, requireRegisteredMetaApp: true })).toThrow(
      /META_APP_ID is required for a production build/
    );
  });

  // An unset variable and an env file with `META_APP_ID=` are the same mistake, and dotenv reports
  // the second as an empty string rather than undefined.
  it("treats an empty or whitespace value as unset", () => {
    expect(resolveMetaAppId({ metaAppId: "   ", requireRegisteredMetaApp: false })).toBe(
      DEVELOPER_MODE_APP_ID
    );
    expect(() => resolveMetaAppId({ metaAppId: "", requireRegisteredMetaApp: true })).toThrow(
      /META_APP_ID is required/
    );
  });

  // Spelling the sentinel out is a mistake, not consent: it ships exactly the same broken app as
  // leaving the variable unset, so the guard cannot accept it as an override.
  it("rejects an explicit Developer Mode sentinel in production", () => {
    expect(() =>
      resolveMetaAppId({ metaAppId: DEVELOPER_MODE_APP_ID, requireRegisteredMetaApp: true })
    ).toThrow(/Developer Mode sentinel/);
  });

  // The guard must be opt-IN from a signal the caller computes; defaulting it on would break every
  // local `expo prebuild`, and defaulting it to a truthy-ish value would break the guard itself.
  it("only guards when production is asserted explicitly", () => {
    expect(resolveMetaAppId({ metaAppId: undefined })).toBe(DEVELOPER_MODE_APP_ID);
  });
});
