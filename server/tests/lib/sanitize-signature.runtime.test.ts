import { describe, expect, it } from "vitest";
import { sanitizeSignatureHtml } from "../../src/lib/sanitize-signature.js";

describe("sanitizeSignatureHtml", () => {
  it("strips <script> tags and inline event handlers", () => {
    const out = sanitizeSignatureHtml('<p onclick="steal()">Jane</p><script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("Jane");
  });

  it("strips javascript: links and base64 data: images, keeps https links/images", () => {
    expect(sanitizeSignatureHtml('<a href="javascript:evil()">x</a>')).not.toContain("javascript:");
    // We host logos in R2 and reference by URL — base64/data images are not allowed.
    expect(sanitizeSignatureHtml('<img src="data:image/png;base64,AAAA">')).not.toContain("data:image");
    const img = sanitizeSignatureHtml('<img src="https://cdn.example.com/logo.png" alt="logo">');
    expect(img).toContain("https://cdn.example.com/logo.png");
  });

  it("keeps basic formatting + a mailto link", () => {
    const out = sanitizeSignatureHtml('<p><strong>Jane</strong><br><a href="mailto:j@x.com">email</a></p>');
    expect(out).toContain("<strong>");
    expect(out).toContain("<br");
    expect(out).toContain('href="mailto:j@x.com"');
  });

  it("drops <style>, <iframe>, and <form> entirely", () => {
    const out = sanitizeSignatureHtml('<style>body{x}</style><iframe src="https://e"></iframe><form></form><p>ok</p>');
    expect(out).not.toContain("<style");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<form");
    expect(out).toContain("ok");
  });

  it("returns '' for null/undefined/empty/whitespace (graceful — no append)", () => {
    expect(sanitizeSignatureHtml(null)).toBe("");
    expect(sanitizeSignatureHtml(undefined)).toBe("");
    expect(sanitizeSignatureHtml("")).toBe("");
    expect(sanitizeSignatureHtml("   ")).toBe("");
  });

  it("bounds over-limit input before parsing (no unbounded paste)", () => {
    const huge = "<p>" + "a".repeat(60_000) + "</p>";
    const out = sanitizeSignatureHtml(huge);
    expect(out.length).toBeLessThanOrEqual(50_010);
  });

  it("caps by UTF-8 BYTES, not UTF-16 code units (multibyte can't bypass the cap)", () => {
    // 30k '€' = 30k code units but 90k UTF-8 bytes — a code-unit cap (30k < 50k) would let it through.
    const out = sanitizeSignatureHtml("<p>" + "€".repeat(30_000) + "</p>");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50_010);
  });

  it("treats visually-empty markup as no signature (so it's stored null + never appended)", () => {
    expect(sanitizeSignatureHtml("<br>")).toBe("");
    expect(sanitizeSignatureHtml("<div><br></div>")).toBe("");
    expect(sanitizeSignatureHtml("<p>&nbsp;</p>")).toBe("");
    expect(sanitizeSignatureHtml("<p>   </p>")).toBe("");
  });

  it("keeps a logo-only signature (an <img> with no text counts as present)", () => {
    expect(sanitizeSignatureHtml('<img src="https://cdn/logo.png" alt="logo">')).toContain("https://cdn/logo.png");
  });
});
