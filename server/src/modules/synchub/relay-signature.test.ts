import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import { verifySyncHubRelaySignature } from "./relay-signature.js";

describe("SyncHub relay signature verification", () => {
  const body = Buffer.from(JSON.stringify({ eventType: "procore.project.created" }));

  function signature(secret = "relay-secret") {
    return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  }

  it("accepts a valid HMAC-SHA256 signature", () => {
    expect(verifySyncHubRelaySignature(body, signature(), "relay-secret")).toBe("valid");
  });

  it("rejects a missing signature", () => {
    expect(verifySyncHubRelaySignature(body, undefined, "relay-secret")).toBe("missing_signature");
  });

  it("rejects a mismatched signature", () => {
    expect(verifySyncHubRelaySignature(body, signature("wrong-secret"), "relay-secret")).toBe("invalid_signature");
  });

  it("fails closed when the relay secret is unset", () => {
    expect(verifySyncHubRelaySignature(body, signature(), undefined)).toBe("missing_secret");
  });

  it("uses timing-safe comparison for equal-length signatures", () => {
    const timingSafeEqual = vi.spyOn(crypto, "timingSafeEqual");

    expect(verifySyncHubRelaySignature(body, signature(), "relay-secret")).toBe("valid");

    expect(timingSafeEqual).toHaveBeenCalled();
    timingSafeEqual.mockRestore();
  });
});
