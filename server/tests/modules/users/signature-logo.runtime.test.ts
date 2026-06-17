import { describe, expect, it, vi, beforeEach } from "vitest";

const headObject = vi.fn();
const deleteObject = vi.fn();
vi.mock("../../../src/lib/r2-client.js", () => ({
  headObject: (...args: unknown[]) => headObject(...args),
  deleteObject: (...args: unknown[]) => deleteObject(...args),
}));

const { enforceSignatureLogoSize, assertOwnedSignatureLogoKey, SIGNATURE_LOGO_MAX_BYTES } = await import(
  "../../../src/modules/users/signature-logo.js"
);

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// The real guard: the presigned PUT can't bound size + the client check is bypassable, so the server
// reads the uploaded object's actual size and deletes it if oversized before it can ever be served.
describe("enforceSignatureLogoSize (server-side size guard)", () => {
  beforeEach(() => {
    headObject.mockReset();
    deleteObject.mockReset();
  });

  it("accepts an object at/within the cap and does not delete it", async () => {
    headObject.mockResolvedValue({ contentLength: SIGNATURE_LOGO_MAX_BYTES });
    await expect(enforceSignatureLogoSize(`signature-logos/${USER}/ok.png`)).resolves.toBeUndefined();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("DELETES and rejects (413) an oversized object — it never becomes servable", async () => {
    headObject.mockResolvedValue({ contentLength: SIGNATURE_LOGO_MAX_BYTES + 1 });
    const key = `signature-logos/${USER}/too-big.png`;
    await expect(enforceSignatureLogoSize(key)).rejects.toMatchObject({ statusCode: 413 });
    expect(deleteObject).toHaveBeenCalledWith(key);
  });

  it("rejects (400) when the uploaded object is not found", async () => {
    headObject.mockResolvedValue(null);
    await expect(enforceSignatureLogoSize(`signature-logos/${USER}/missing.png`)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("DELETES and rejects (400) a zero-byte (empty) upload", async () => {
    headObject.mockResolvedValue({ contentLength: 0 });
    const key = `signature-logos/${USER}/empty.png`;
    await expect(enforceSignatureLogoSize(key)).rejects.toMatchObject({ statusCode: 400 });
    expect(deleteObject).toHaveBeenCalledWith(key);
  });
});

describe("assertOwnedSignatureLogoKey (confirm only touches the caller's own key)", () => {
  it("accepts the user's own signature-logos key", () => {
    expect(() => assertOwnedSignatureLogoKey(`signature-logos/${USER}/abc.png`, USER)).not.toThrow();
  });

  it("rejects another user's key, foreign prefixes, traversal, sub-paths, and empty assets", () => {
    for (const bad of [
      `signature-logos/${OTHER}/abc.png`,
      `other-prefix/${USER}/abc.png`,
      `signature-logos/${USER}/../${OTHER}/abc.png`,
      `signature-logos/${USER}/sub/abc.png`,
      `signature-logos/${USER}/`,
      "",
    ]) {
      expect(() => assertOwnedSignatureLogoKey(bad, USER)).toThrow();
    }
  });
});
