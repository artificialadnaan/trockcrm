import { describe, it, expect } from "vitest";
import {
  isRenderableSignatureDataUrl,
  signatureDataUrlBase64Body,
  typedSignatureFallback,
} from "../field-scorecard-signature.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("isRenderableSignatureDataUrl", () => {
  it("accepts png, jpeg and jpg data urls, case-insensitively", () => {
    expect(isRenderableSignatureDataUrl(PNG)).toBe(true);
    expect(isRenderableSignatureDataUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isRenderableSignatureDataUrl("data:image/jpg;base64,/9j/4AAQ")).toBe(true);
    expect(isRenderableSignatureDataUrl("DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=")).toBe(true);
  });

  it("rejects a typed name, empty input and non-image data payloads", () => {
    expect(isRenderableSignatureDataUrl("Adnaan Iqbal")).toBe(false);
    expect(isRenderableSignatureDataUrl("")).toBe(false);
    expect(isRenderableSignatureDataUrl(null)).toBe(false);
    expect(isRenderableSignatureDataUrl(undefined)).toBe(false);
    // Not an allowed image type — must never reach an <img src> or doc.image().
    expect(isRenderableSignatureDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isRenderableSignatureDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    // Right prefix, illegal base64 alphabet.
    expect(isRenderableSignatureDataUrl("data:image/png;base64,not base64!!")).toBe(false);
    // Right prefix, empty payload.
    expect(isRenderableSignatureDataUrl("data:image/png;base64,")).toBe(false);
  });
});

describe("signatureDataUrlBase64Body", () => {
  it("returns the base64 body of a renderable signature", () => {
    expect(signatureDataUrlBase64Body(PNG)).toBe(PNG.split(",")[1]);
  });

  it("returns null for anything not renderable", () => {
    expect(signatureDataUrlBase64Body("Adnaan Iqbal")).toBeNull();
    expect(signatureDataUrlBase64Body("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(signatureDataUrlBase64Body(null)).toBeNull();
    expect(signatureDataUrlBase64Body(undefined)).toBeNull();
  });
});

describe("typedSignatureFallback", () => {
  it("returns a legacy typed name", () => {
    expect(typedSignatureFallback("Adnaan Iqbal")).toBe("Adnaan Iqbal");
  });

  it("returns null for any data url, including an unrenderable one", () => {
    expect(typedSignatureFallback(PNG)).toBeNull();
    expect(typedSignatureFallback("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  it("treats an uppercase data url as a data url, not as a typed name", () => {
    // The renderable regex is case-insensitive; a case-SENSITIVE check here would disagree with it and
    // print an unrenderable uppercase payload verbatim — the exact bug this module exists to prevent.
    expect(typedSignatureFallback("DATA:TEXT/HTML;BASE64,PHNjcmlwdD4=")).toBeNull();
    expect(typedSignatureFallback("DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(typedSignatureFallback("")).toBeNull();
    expect(typedSignatureFallback(null)).toBeNull();
    expect(typedSignatureFallback(undefined)).toBeNull();
  });
});
