import {
  createPublicKey,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";
import {
  CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS,
  type CoreWeeklyReportAuthAction,
} from "./core-api-auth.js";

export const CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID_HEADER =
  "x-trock-core-workload-key-id" as const;
export const CORE_WEEKLY_REPORT_WORKLOAD_SIGNATURE_HEADER =
  "x-trock-core-workload-signature" as const;
export const CORE_WEEKLY_REPORT_WORKLOAD_CURRENT_KEY_ID_ENV =
  "TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID" as const;
export const CORE_WEEKLY_REPORT_WORKLOAD_CURRENT_PUBLIC_KEY_ENV =
  "TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY" as const;
export const CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID_ENV =
  "TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID" as const;
export const CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY_ENV =
  "TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY" as const;

const WORKLOAD_AUTH_DOMAIN = "trock.crm.core-weekly-report-workload.v1";
const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_DER_BYTES = 512;

export interface CoreWeeklyReportWorkloadKey {
  keyId: string;
  publicKey: KeyObject;
}

export interface CoreWeeklyReportWorkloadKeyring {
  current: CoreWeeklyReportWorkloadKey;
  previous: CoreWeeklyReportWorkloadKey | null;
}

export type CoreWeeklyReportWorkloadKeyReadiness =
  | { ok: true; keyring: CoreWeeklyReportWorkloadKeyring }
  | {
      ok: false;
      reason:
        | "missing_workload_current_key_id"
        | "invalid_workload_current_key_id"
        | "missing_workload_current_public_key"
        | "invalid_workload_current_public_key"
        | "incomplete_workload_previous_key"
        | "invalid_workload_previous_key_id"
        | "invalid_workload_previous_public_key"
        | "duplicate_workload_rotation_key_id"
        | "duplicate_workload_rotation_public_key";
    };

export interface CoreWeeklyReportWorkloadHeaders {
  keyId: unknown;
  signature: unknown;
}

export type CoreWeeklyReportWorkloadVerification =
  | { ok: true; keyId: string; keySlot: "current" | "previous" }
  | { ok: false };

export function isCoreWeeklyReportWorkloadKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_RE.test(value);
}

function decodeCanonicalBase64url(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    !BASE64URL_RE.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 &&
      decoded.length <= MAX_DER_BYTES &&
      decoded.toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

/** Parse one canonical DER SPKI Ed25519 key; no PEM or base64 aliases enter the keyring. */
export function parseCoreWeeklyReportWorkloadPublicKey(value: unknown): KeyObject | null {
  const der = decodeCanonicalBase64url(value);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
    const canonical = key.export({ format: "der", type: "spki" });
    return Buffer.isBuffer(canonical) && canonical.equals(der) ? key : null;
  } catch {
    return null;
  }
}

function exportedPublicDer(key: KeyObject): Buffer {
  const value = key.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(value)) throw new TypeError("Expected DER public key bytes");
  return value;
}

/** Resolve the whole current/previous public-key ring or fail closed before the route can become ready. */
export function coreWeeklyReportWorkloadKeyReadiness(env: {
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID?: string;
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY?: string;
}): CoreWeeklyReportWorkloadKeyReadiness {
  const currentKeyId = env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID;
  if (currentKeyId === undefined || currentKeyId === "") {
    return { ok: false, reason: "missing_workload_current_key_id" };
  }
  if (!isCoreWeeklyReportWorkloadKeyId(currentKeyId)) {
    return { ok: false, reason: "invalid_workload_current_key_id" };
  }
  const currentPublicValue = env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY;
  if (currentPublicValue === undefined || currentPublicValue === "") {
    return { ok: false, reason: "missing_workload_current_public_key" };
  }
  const currentPublicKey = parseCoreWeeklyReportWorkloadPublicKey(currentPublicValue);
  if (!currentPublicKey) {
    return { ok: false, reason: "invalid_workload_current_public_key" };
  }

  const previousKeyId = env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID;
  const previousPublicValue = env.TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY;
  const previousIdPresent = previousKeyId !== undefined;
  const previousKeyPresent = previousPublicValue !== undefined;
  if (previousIdPresent !== previousKeyPresent) {
    return { ok: false, reason: "incomplete_workload_previous_key" };
  }
  if (!previousIdPresent) {
    return {
      ok: true,
      keyring: {
        current: { keyId: currentKeyId, publicKey: currentPublicKey },
        previous: null,
      },
    };
  }
  if (!isCoreWeeklyReportWorkloadKeyId(previousKeyId)) {
    return { ok: false, reason: "invalid_workload_previous_key_id" };
  }
  const previousPublicKey = parseCoreWeeklyReportWorkloadPublicKey(previousPublicValue);
  if (!previousPublicKey) {
    return { ok: false, reason: "invalid_workload_previous_public_key" };
  }
  if (previousKeyId === currentKeyId) {
    return { ok: false, reason: "duplicate_workload_rotation_key_id" };
  }
  if (exportedPublicDer(previousPublicKey).equals(exportedPublicDer(currentPublicKey))) {
    return { ok: false, reason: "duplicate_workload_rotation_public_key" };
  }
  return {
    ok: true,
    keyring: {
      current: { keyId: currentKeyId, publicKey: currentPublicKey },
      previous: { keyId: previousKeyId, publicKey: previousPublicKey },
    },
  };
}

/** Exact cross-repository bytes signed by Core's Ed25519 private key. */
export function coreWeeklyReportWorkloadAuthFrame(input: {
  keyId: string;
  action: CoreWeeklyReportAuthAction;
  requestId: string;
  timestampSeconds: number;
  rawBody: Buffer;
}): Buffer {
  const requestId = input.requestId.toLowerCase();
  if (
    !isCoreWeeklyReportWorkloadKeyId(input.keyId) ||
    !UUID_RE.test(requestId) ||
    !Number.isSafeInteger(input.timestampSeconds) ||
    !/^\d{10}$/.test(String(input.timestampSeconds)) ||
    !Buffer.isBuffer(input.rawBody)
  ) {
    throw new TypeError("Invalid Core weekly-report workload authentication frame");
  }
  return Buffer.concat([
    Buffer.from(
      `${WORKLOAD_AUTH_DOMAIN}\n${input.keyId}\n${input.action}\n${requestId}\n${input.timestampSeconds}\n`,
      "utf8",
    ),
    input.rawBody,
  ]);
}

function parseWorkloadSignature(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const encoded = /^ed25519=([A-Za-z0-9_-]+)$/.exec(value)?.[1];
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    return decoded.length === 64 && decoded.toString("base64url") === encoded
      ? decoded
      : null;
  } catch {
    return null;
  }
}

/** Verify cryptographic Core workload possession separately from the exact-body HMAC proof. */
export function verifyCoreWeeklyReportWorkloadAssertion(input: {
  action: CoreWeeklyReportAuthAction;
  requestId: string;
  timestampSeconds: number;
  rawBody: Buffer;
  headers: CoreWeeklyReportWorkloadHeaders;
  keyring: CoreWeeklyReportWorkloadKeyring;
  nowMs?: number;
}): CoreWeeklyReportWorkloadVerification {
  const keyId = typeof input.headers.keyId === "string" ? input.headers.keyId : null;
  const signature = parseWorkloadSignature(input.headers.signature);
  const nowMs = input.nowMs ?? Date.now();
  if (
    !keyId ||
    !isCoreWeeklyReportWorkloadKeyId(keyId) ||
    !signature ||
    !Number.isFinite(nowMs) ||
    Math.abs(Math.floor(nowMs / 1_000) - input.timestampSeconds) >
      CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS
  ) {
    return { ok: false };
  }
  const slot = keyId === input.keyring.current.keyId
    ? "current"
    : keyId === input.keyring.previous?.keyId
      ? "previous"
      : null;
  if (!slot) return { ok: false };
  const publicKey = slot === "current"
    ? input.keyring.current.publicKey
    : input.keyring.previous!.publicKey;
  try {
    const frame = coreWeeklyReportWorkloadAuthFrame({
      keyId,
      action: input.action,
      requestId: input.requestId,
      timestampSeconds: input.timestampSeconds,
      rawBody: input.rawBody,
    });
    return verifyEd25519(null, frame, publicKey, signature)
      ? { ok: true, keyId, keySlot: slot }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
