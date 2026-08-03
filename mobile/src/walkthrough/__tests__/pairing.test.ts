import { describePairing, type PairingInput } from "../pairing";

const ready: PairingInput = {
  bridgeAvailable: true,
  configured: true,
  registrationState: "registered",
  deviceCount: 1,
  deviceName: "RB Meta 014K",
  linkState: "connected",
  cameraPermission: "granted",
};

describe("describePairing", () => {
  it("is ready when a device is registered and linked", () => {
    const p = describePairing(ready);
    expect(p.status).toBe("ready");
    expect(p.canStartWalk).toBe(true);
    expect(p.detail).toContain("RB Meta 014K");
  });

  // A build without the native module cannot be fixed by pairing — it needs a rebuild, which is
  // a completely different instruction from "connect your glasses".
  it("reports a missing bridge as needing a rebuild, not a pairing problem", () => {
    const p = describePairing({ ...ready, bridgeAvailable: false });
    expect(p.status).toBe("unavailable");
    expect(p.canStartWalk).toBe(false);
    expect(p.detail).toMatch(/rebuild/i);
  });

  it("asks the user to pair when nothing is registered", () => {
    const p = describePairing({
      ...ready,
      registrationState: "available",
      deviceCount: 0,
      deviceName: null,
      linkState: null,
    });
    expect(p.status).toBe("unpaired");
    expect(p.canStartWalk).toBe(false);
  });

  // Registered but not linked is the confusing one: the glasses are known to the SDK but not
  // reachable right now. Telling the user to "pair" would be wrong — they already did.
  it("distinguishes registered-but-disconnected from unpaired", () => {
    const p = describePairing({ ...ready, linkState: "disconnected" });
    expect(p.status).toBe("disconnected");
    expect(p.canStartWalk).toBe(false);
    expect(p.detail).not.toMatch(/pair/i);
  });

  it("blocks a walk when the SDK was never configured", () => {
    const p = describePairing({ ...ready, configured: false });
    expect(p.status).toBe("unconfigured");
    expect(p.canStartWalk).toBe(false);
  });

  // A registered, connected device is still not enough: Meta's camera authorization is a SEPARATE
  // grant from pairing, and the recorder cannot start a stream without it. A release build with no
  // dev diagnostic screen has no other way to discover this — it must show up here.
  it("blocks a walk on a fully-paired device when camera access was denied", () => {
    const p = describePairing({ ...ready, cameraPermission: "denied" });
    expect(p.status).toBe("cameraBlocked");
    expect(p.canStartWalk).toBe(false);
    expect(p.detail).toContain("RB Meta 014K");
  });

  // Never default-assume access: a null (unread) or unexpected value must be treated the same as
  // an explicit denial, not waved through to "ready".
  it("treats an unread or unrecognized camera permission value as not granted", () => {
    expect(describePairing({ ...ready, cameraPermission: null }).status).toBe("cameraBlocked");
    expect(describePairing({ ...ready, cameraPermission: "error: timed out" }).status).toBe(
      "cameraBlocked",
    );
  });

  // Order matters: an unpaired/disconnected device should never be reported as a camera-permission
  // problem — that would send the user down the wrong fix entirely.
  it("checks link state before camera permission, not after", () => {
    const p = describePairing({ ...ready, linkState: "disconnected", cameraPermission: "denied" });
    expect(p.status).toBe("disconnected");
  });
});
