import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_WEEKLY_REPORT_REQUEST_ID_HEADER,
  CORE_WEEKLY_REPORT_SIGNATURE_HEADER,
  CORE_WEEKLY_REPORT_TIMESTAMP_HEADER,
  signCoreWeeklyReportRequest,
} from "./modules/weekly-reports/core-api-auth.js";
import {
  CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID_HEADER,
  CORE_WEEKLY_REPORT_WORKLOAD_SIGNATURE_HEADER,
  coreWeeklyReportWorkloadAuthFrame,
} from "./modules/weekly-reports/core-api-workload-auth.js";

vi.mock("./modules/procore/event-handlers.js", () => ({
  registerProcoreEventHandlers: vi.fn(),
}));

vi.mock("./modules/notifications/sse-manager.js", () => ({
  initSsePush: vi.fn(),
}));

const SECRET = "crm-current-weekly-report-key-material-0001";
const KEY_ID = "core-weekly-2026-08";
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g",
    "base64url",
  ),
  format: "der",
  type: "pkcs8",
});
const PUBLIC_KEY =
  "MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATH = "/api/integrations/trock-core/v1/weekly-reports/deals/resolve";
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("app Core weekly-report integration registration", () => {
  it("mounts the known path dark as a content-free no-store 404", async () => {
    vi.stubEnv("ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API", "false");
    const { createApp } = await import("./app.js");
    const response = await request(createApp())
      .post(PATH)
      .set("Content-Type", "application/json")
      .send('{"officeSlug":"dallas","projectNumber":"24-001"}');
    expect(response.status).toBe(404);
    expect(response.text).toBe("");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("mounts before express.json so both proofs see the exact raw bytes", async () => {
    vi.stubEnv("ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API", "true");
    vi.stubEnv("TROCK_CORE_WEEKLY_REPORT_API_SECRET", SECRET);
    vi.stubEnv("TROCK_CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID", KEY_ID);
    vi.stubEnv("TROCK_CORE_WEEKLY_REPORT_WORKLOAD_PUBLIC_KEY", PUBLIC_KEY);
    const { createApp } = await import("./app.js");
    const rawBody = Buffer.from(
      '{"officeSlug":"dallas","projectNumber":"24-001"}',
      "utf8",
    );
    const timestampSeconds = Math.floor(Date.now() / 1_000);
    const hmac = signCoreWeeklyReportRequest({
      action: "resolve-deal",
      requestId: REQUEST_ID,
      timestampSeconds,
      rawBody,
      secret: SECRET,
    });
    // A valid Ed25519 proof over the wrong action reaches post-raw-body dual verification and fails
    // content-free. If express.json had consumed the bytes first, this would instead be a typed 415.
    const workload = `ed25519=${signEd25519(
      null,
      coreWeeklyReportWorkloadAuthFrame({
        keyId: KEY_ID,
        action: "list-reports",
        requestId: REQUEST_ID,
        timestampSeconds,
        rawBody,
      }),
      PRIVATE_KEY,
    ).toString("base64url")}`;
    const response = await request(createApp())
      .post(PATH)
      .set("Content-Type", "application/json")
      .set(CORE_WEEKLY_REPORT_REQUEST_ID_HEADER, REQUEST_ID)
      .set(CORE_WEEKLY_REPORT_TIMESTAMP_HEADER, String(timestampSeconds))
      .set(CORE_WEEKLY_REPORT_SIGNATURE_HEADER, hmac)
      .set(CORE_WEEKLY_REPORT_WORKLOAD_KEY_ID_HEADER, KEY_ID)
      .set(CORE_WEEKLY_REPORT_WORKLOAD_SIGNATURE_HEADER, workload)
      .send(rawBody.toString("utf8"));
    expect(response.status).toBe(401);
    expect(response.text).toBe("");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});
