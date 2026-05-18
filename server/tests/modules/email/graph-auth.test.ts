import { afterEach, describe, expect, it } from "vitest";
import { getConsentUrl } from "../../../src/modules/email/graph-auth.js";

describe("graph auth consent URL", () => {
  afterEach(() => {
    delete process.env.AZURE_CLIENT_ID;
    delete process.env.AZURE_TENANT_ID;
  });

  it("requests only delegated user mailbox scopes and never admin consent", () => {
    process.env.AZURE_CLIENT_ID = "client-id-123";
    process.env.AZURE_TENANT_ID = "common";

    const url = new URL(getConsentUrl("https://api.example.com/api/auth/graph/callback", "state-token"));
    const scopes = url.searchParams.get("scope")?.split(" ").sort();

    expect(scopes).toEqual([
      "Mail.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "User.Read",
      "offline_access",
    ].sort());
    expect(scopes?.some((scope) => scope.endsWith(".All") || scope.endsWith(".Shared"))).toBe(false);
    expect(url.searchParams.get("prompt")).not.toBe("admin_consent");
  });
});
