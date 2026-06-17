import { describe, expect, it } from "vitest";
import { composeBodyWithSignature } from "../../../src/modules/email/signature-compose.js";

// The outbound inject: this is what sendEmail applies to user-composed mail (compose + reply/forward
// + dev mock) before the Graph payload + the stored row, so the signature ships in-payload.
describe("composeBodyWithSignature (user-composed inject)", () => {
  it("appends the sanitized signature below the body, keeping the logo <img>", () => {
    const out = composeBodyWithSignature("<p>Hello</p>", '<p>Jane Rep</p><img src="https://cdn/logo.png" alt="T Rock">');
    expect(out.startsWith("<p>Hello</p>")).toBe(true);
    expect(out).toContain("trock-email-signature");
    expect(out).toContain("Jane Rep");
    expect(out).toContain("https://cdn/logo.png");
  });

  it("re-sanitizes at append time (defense-in-depth — script/handlers never reach outbound mail)", () => {
    const out = composeBodyWithSignature("<p>Hi</p>", '<p onclick="x()">S</p><script>evil()</script>');
    expect(out).toContain("S");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("evil()");
  });

  it("is a no-op when the signature is empty/null/whitespace (graceful)", () => {
    expect(composeBodyWithSignature("<p>Hi</p>", null)).toBe("<p>Hi</p>");
    expect(composeBodyWithSignature("<p>Hi</p>", undefined)).toBe("<p>Hi</p>");
    expect(composeBodyWithSignature("<p>Hi</p>", "")).toBe("<p>Hi</p>");
    expect(composeBodyWithSignature("<p>Hi</p>", "   ")).toBe("<p>Hi</p>");
  });
});
