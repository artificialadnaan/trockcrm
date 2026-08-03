import fs from "fs";
import path from "path";

/**
 * A production submit must name at least one TestFlight group.
 *
 * `eas submit` uploads the build to App Store Connect and STOPS. Without a group the binary sits in
 * ASC processed and undistributed — no tester is notified, no device gets it, and every dashboard
 * says the submit succeeded, because it did. The build is fine; nobody has it.
 *
 * That is not a hypothetical: this app shipped with `submit.production.ios` carrying only
 * `appleTeamId` and `ascAppId`, so the whole glasses-walkthrough feature was merged, deployed and
 * server-verified while the app half could not reach a single estimator.
 *
 * A GUARD RATHER THAN A COMMENT, because nothing in CI compiles or runs `mobile/` — this app is
 * checked only by whoever runs the suite locally, so a config regression here has no other net to
 * fall into. The group NAME is deliberately not asserted: it has to match a group that exists in
 * App Store Connect, which is a fact about the Apple account rather than about this repo, and
 * pinning a specific string here would just move the silent failure somewhere this file cannot see.
 * What is pinned is that submitting is a decision someone made, not a field nobody filled in.
 */
const easConfigPath = path.join(__dirname, "..", "..", "eas.json");

type EasConfig = {
  submit?: { production?: { ios?: { groups?: unknown } } };
};

describe("eas.json production submit", () => {
  const eas = JSON.parse(fs.readFileSync(easConfigPath, "utf8")) as EasConfig;

  it("names at least one TestFlight group, so a submitted build actually reaches testers", () => {
    const groups = eas.submit?.production?.ios?.groups;

    expect(Array.isArray(groups)).toBe(true);
    expect(groups as unknown[]).not.toHaveLength(0);
  });

  it("has no blank group names, which App Store Connect rejects at submit time", () => {
    const groups = (eas.submit?.production?.ios?.groups ?? []) as unknown[];

    for (const group of groups) {
      expect(typeof group).toBe("string");
      expect((group as string).trim()).not.toBe("");
    }
  });
});
