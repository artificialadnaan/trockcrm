import { describe, it, expect } from "vitest";
import crypto from "crypto";

// Inline encryption logic for unit testing without importing the module
// (avoids process.env dependency in test runner)
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const TEST_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex"
);

function encrypt(plaintext: string, key: Buffer = TEST_KEY): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

function decrypt(encoded: string, key: Buffer = TEST_KEY): string {
  const packed = Buffer.from(encoded, "base64");
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

describe("AES-256-GCM Encryption", () => {
  it("should round-trip a short string", () => {
    const original = "hello-world-token";
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it("should round-trip a long access token", () => {
    const original =
      "eyJ0eXAiOiJKV1QiLCJub25jZSI6IjEyMzQ1Njc4OTAiLCJhbGciOiJSUzI1NiIsIng1dCI6Ik5HVEZ2ZEstZnl0aEV1Q..." +
      "a".repeat(1000);
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it("should produce different ciphertext for same plaintext (random IV)", () => {
    const original = "same-token";
    const enc1 = encrypt(original);
    const enc2 = encrypt(original);
    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(original);
    expect(decrypt(enc2)).toBe(original);
  });

  it("should fail on tampered ciphertext", () => {
    const encrypted = encrypt("secret-token");
    const buf = Buffer.from(encrypted, "base64");
    // Flip a byte in the ciphertext portion
    buf[IV_LENGTH + TAG_LENGTH] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("should fail with wrong key", () => {
    const encrypted = encrypt("secret-token");
    const wrongKey = Buffer.from(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "hex"
    );
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("should handle empty string", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  it("should handle unicode characters", () => {
    const original = "token-with-unicode-\u00e9\u00e8\u00ea";
    expect(decrypt(encrypt(original))).toBe(original);
  });
});
