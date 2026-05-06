import crypto from "crypto";

export type SyncHubRelaySignatureResult =
  | "valid"
  | "missing_secret"
  | "missing_signature"
  | "invalid_signature";

export const SYNCHUB_RELAY_SIGNATURE_HEADER = "x-synchub-signature";

export function verifySyncHubRelaySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined
): SyncHubRelaySignatureResult {
  if (!secret) return "missing_secret";
  if (!signatureHeader) return "missing_signature";

  const provided = signatureHeader.replace(/^sha256=/, "");
  if (!/^[a-f0-9]{64}$/i.test(provided)) return "invalid_signature";

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    const expectedBuffer = Buffer.from(expected, "hex");
    const providedBuffer = Buffer.from(provided, "hex");
    if (expectedBuffer.length !== providedBuffer.length) return "invalid_signature";
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer) ? "valid" : "invalid_signature";
  } catch {
    return "invalid_signature";
  }
}
