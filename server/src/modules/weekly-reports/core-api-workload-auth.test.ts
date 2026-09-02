import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  coreWeeklyReportWorkloadAuthFrame,
  coreWeeklyReportWorkloadKeyReadiness,
  verifyCoreWeeklyReportWorkloadAssertion,
} from "./core-api-workload-auth.js";

const CURRENT_KEY_ID = "core-weekly-2026-08";
const PREVIOUS_KEY_ID = "core-weekly-2026-07";
const CURRENT_PRIVATE =
  "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
const CURRENT_PUBLIC =
  "MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const PREVIOUS_PRIVATE =
  "MC4CAQAwBQYDK2VwBCIEIEzNCJso_5banbbDRuwRTg9bijGfNaumJNqM9u1PuKb7";
const PREVIOUS_PUBLIC =
  "MCowBQYDK2VwAyEAPUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIMESTAMP = 1_787_855_445;
const NOW_MS = TIMESTAMP * 1_000;
const BODY = Buffer.from('{"officeSlug":"dallas","projectNumber":"24-001"}', "utf8");

const KEYRING_RESULT = coreWeeklyReportWorkloadKeyReadiness({
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID: CURRENT_KEY_ID,
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: CURRENT_PUBLIC,
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID: PREVIOUS_KEY_ID,
  TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY: PREVIOUS_PUBLIC,
});
if (!KEYRING_RESULT.ok) throw new Error("test workload keyring must be valid");
const KEYRING = KEYRING_RESULT.keyring;

function privateKey(value = CURRENT_PRIVATE) {
  return createPrivateKey({
    key: Buffer.from(value, "base64url"),
    format: "der",
    type: "pkcs8",
  });
}

function signature(input: {
  keyId?: string;
  action?: "resolve-deal" | "list-reports" | "report-detail";
  requestId?: string;
  timestampSeconds?: number;
  rawBody?: Buffer;
  privateKeyValue?: string;
} = {}): string {
  const frame = coreWeeklyReportWorkloadAuthFrame({
    keyId: input.keyId ?? CURRENT_KEY_ID,
    action: input.action ?? "resolve-deal",
    requestId: input.requestId ?? REQUEST_ID,
    timestampSeconds: input.timestampSeconds ?? TIMESTAMP,
    rawBody: input.rawBody ?? BODY,
  });
  return `ed25519=${signEd25519(null, frame, privateKey(input.privateKeyValue)).toString("base64url")}`;
}

function verify(overrides: Partial<Parameters<typeof verifyCoreWeeklyReportWorkloadAssertion>[0]> = {}) {
  return verifyCoreWeeklyReportWorkloadAssertion({
    action: "resolve-deal",
    requestId: REQUEST_ID,
    timestampSeconds: TIMESTAMP,
    rawBody: BODY,
    headers: { keyId: CURRENT_KEY_ID, signature: signature() },
    keyring: KEYRING,
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe("Core weekly-report Ed25519 workload verification", () => {
  it("matches the Core signer's canonical cross-repository vector", () => {
    expect(coreWeeklyReportWorkloadAuthFrame({
      keyId: CURRENT_KEY_ID,
      action: "resolve-deal",
      requestId: REQUEST_ID.toUpperCase(),
      timestampSeconds: TIMESTAMP,
      rawBody: BODY,
    }).toString("hex")).toBe(
      "74726f636b2e63726d2e636f72652d7765656b6c792d7265706f72742d776f726b6c6f61642e76310a636f72652d7765656b6c792d323032362d30380a7265736f6c76652d6465616c0a61616161616161612d616161612d346161612d386161612d6161616161616161616161610a313738373835353434350a7b226f6666696365536c7567223a2264616c6c6173222c2270726f6a6563744e756d626572223a2232342d303031227d",
    );
    expect(signature()).toBe(
      "ed25519=h1ZRNHm0mDsM6wUEK5xhYK-G_JgBRPhHaNUflz7IO28JxHqxhqdeEyFvxswqxm-Aunp60L0NHkhzLKmu5xJQBg",
    );
    expect(verify()).toEqual({ ok: true, keyId: CURRENT_KEY_ID, keySlot: "current" });
  });

  it("accepts the previous public key only under its signed previous key id", () => {
    expect(verify({
      headers: {
        keyId: PREVIOUS_KEY_ID,
        signature: signature({
          keyId: PREVIOUS_KEY_ID,
          privateKeyValue: PREVIOUS_PRIVATE,
        }),
      },
    })).toEqual({ ok: true, keyId: PREVIOUS_KEY_ID, keySlot: "previous" });
    expect(verify({
      headers: {
        keyId: CURRENT_KEY_ID,
        signature: signature({ privateKeyValue: PREVIOUS_PRIVATE }),
      },
    })).toEqual({ ok: false });
  });

  it("binds action, request id, timestamp, exact body, and key id", () => {
    expect(verify({ action: "list-reports" })).toEqual({ ok: false });
    expect(verify({ requestId: OTHER_REQUEST_ID })).toEqual({ ok: false });
    expect(verify({ timestampSeconds: TIMESTAMP + 1 })).toEqual({ ok: false });
    expect(verify({ rawBody: Buffer.from("{ }") })).toEqual({ ok: false });
    expect(verify({ headers: { keyId: "core-weekly-unknown", signature: signature() } })).toEqual({ ok: false });
  });

  it("enforces the same short five-minute freshness window independently", () => {
    for (const delta of [-300, 300]) {
      expect(verify({ nowMs: NOW_MS + delta * 1_000 })).toMatchObject({ ok: true });
    }
    for (const delta of [-301, 301]) {
      expect(verify({ nowMs: NOW_MS + delta * 1_000 })).toEqual({ ok: false });
    }
  });

  it.each([
    [null, signature()],
    [CURRENT_KEY_ID, null],
    [CURRENT_KEY_ID, `ed25519=${"A".repeat(85)}`],
    [CURRENT_KEY_ID, `${signature()}=`],
    [CURRENT_KEY_ID, "sha256=" + "0".repeat(64)],
  ])("rejects malformed assertion headers uniformly: %j", (keyId, signed) => {
    expect(verify({ headers: { keyId, signature: signed } })).toEqual({ ok: false });
  });

  it("rejects incomplete, non-Ed25519, aliased, or duplicate public-key rotation config", () => {
    const base = {
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID: CURRENT_KEY_ID,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: CURRENT_PUBLIC,
    };
    expect(coreWeeklyReportWorkloadKeyReadiness(base)).toMatchObject({ ok: true });
    expect(coreWeeklyReportWorkloadKeyReadiness({
      ...base,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID: "",
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY: "",
    })).toMatchObject({ ok: true, keyring: { previous: null } });
    expect(coreWeeklyReportWorkloadKeyReadiness({
      ...base,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY: `${CURRENT_PUBLIC}=`,
    })).toEqual({ ok: false, reason: "invalid_workload_current_public_key" });
    expect(coreWeeklyReportWorkloadKeyReadiness({
      ...base,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID: PREVIOUS_KEY_ID,
    })).toEqual({ ok: false, reason: "incomplete_workload_previous_key" });
    expect(coreWeeklyReportWorkloadKeyReadiness({
      ...base,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_KEY_ID: PREVIOUS_KEY_ID,
      TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PREVIOUS_PUBLIC_KEY: CURRENT_PUBLIC,
    })).toEqual({ ok: false, reason: "duplicate_workload_rotation_public_key" });
  });
});
