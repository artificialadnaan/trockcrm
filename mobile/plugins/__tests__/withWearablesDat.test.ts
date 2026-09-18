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

/**
 * The Swift Package requirement.
 *
 * `upToNextMajorVersion` from 0.8.0 reads as `>= 0.8.0 < 1.0.0`. Under SemVer a 0.x MINOR bump is
 * the breaking axis, so that range silently accepts every future 0.y. Meta published 0.9.0, SPM
 * resolved it on the next cloud build with no change on our side, and the Swift stopped compiling:
 * `value of type 'DeviceSession' has no member 'addStream'` — WearablesBridge and WalkthroughRecorder
 * both target the 0.8.0 API.
 *
 * Nothing in the repo could catch that: the failure is in a cloud Xcode build, after SPM resolution,
 * against a dependency no local test resolves. This assertion is the only cheap guard, so it exists.
 */
const {
  SPM_REQUIREMENT_KIND,
  DEFAULT_VERSION,
} = require("../withWearablesDat") as {
  SPM_REQUIREMENT_KIND: string;
  DEFAULT_VERSION: string;
};

describe("Meta Wearables SDK version pin", () => {
  it("admits 0.8.x patches but NOT the next minor, which is the breaking axis at 0.x", () => {
    expect(SPM_REQUIREMENT_KIND).toBe("upToNextMinorVersion");
  });

  it("still targets the SDK version the Swift bridge is written against", () => {
    // Bumping this alone does not migrate the API. 0.9.0 removed DeviceSession.addStream, which both
    // native files call — moving to it is a source change, not a version change.
    expect(DEFAULT_VERSION).toBe("0.8.0");
  });
});
