import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clientQueryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn(() => ({ query: clientQueryMock, release: releaseMock })));
const ensureAlbumMock = vi.hoisted(() => vi.fn());
const ensureLinkMock = vi.hoisted(() => vi.fn());
const enqueueBatchMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: { connect: connectMock },
}));

vi.mock("./procore-photos.js", () => ({
  ensureTRockPhotosAlbumForDeal: ensureAlbumMock,
  ensurePublicPhotoLinkForDeal: ensureLinkMock,
  enqueueProcorePhotoBatch: enqueueBatchMock,
}));

// The worker is PHOTO-LINK-ONLY against Procore: SyncHub (trocksynchubv3) is the authoritative
// Procore project/status/change-order pipeline. The worker must NEVER create a Procore project,
// poll project status, push stage changes, or import change orders — doing so re-introduces
// duplicate Procore projects (the contract-signed handoff footgun) and double-writes stage +
// change_order_total (corrupting commissions and double-counting CRM-native COs). These tests
// pin that posture even when real Procore credentials are present.
describe("procore sync worker — link-only posture", () => {
  const ENV_KEYS = ["PROCORE_CLIENT_ID", "PROCORE_CLIENT_SECRET", "PROCORE_COMPANY_ID"] as const;
  const originalEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

  beforeEach(() => {
    // Fully reset implementations + the `*Once` queues (clearAllMocks only wipes call history),
    // then re-establish the connection mock so tests can't leak state into one another.
    for (const m of [clientQueryMock, releaseMock, ensureAlbumMock, ensureLinkMock, enqueueBatchMock, connectMock]) {
      m.mockReset();
    }
    connectMock.mockImplementation(() => ({ query: clientQueryMock, release: releaseMock }));
    // Real credentials present: gating must be in code, NOT merely "dev mode off".
    process.env.PROCORE_CLIENT_ID = "client-id";
    process.env.PROCORE_CLIENT_SECRET = "client-secret";
    process.env.PROCORE_COMPANY_ID = "company-1";
  });

  afterAll(() => {
    // Restore original Procore env so this suite can't leak non-dev mode into later worker specs.
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("does NOT create a Procore project for a deal with no procore_project_id (even with real creds)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Procore mutation"));
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] }) // office slug
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Portfolio Deal", procore_project_id: null, property_address: "100 Main", property_city: "Dallas", property_state: "TX", property_zip: "75201" }] })
      .mockResolvedValue({ rows: [] });

    await handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" });

    // No project creation: never POST to Procore, never write procore_project_id, never run photo helpers.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clientQueryMock.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("procore_project_id = $1");
    expect(ensureAlbumMock).not.toHaveBeenCalled();
    expect(ensureLinkMock).not.toHaveBeenCalled();
    expect(enqueueBatchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("cleanly no-ops a create_project job in the pre-provisioning window (no PROCORE_COMPANY_ID, no throw/retry)", async () => {
    // After this change merges but BEFORE creds are set, the contract-signed handoff still enqueues
    // create_project jobs. They must no-op, NOT throw on a missing PROCORE_COMPANY_ID (which would
    // retry forever in job_queue).
    delete process.env.PROCORE_COMPANY_ID;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Procore mutation"));
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Portfolio Deal", procore_project_id: null }] })
      .mockResolvedValue({ rows: [] });

    await expect(
      handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" })
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clientQueryMock.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("procore_project_id = $1");
    fetchMock.mockRestore();
  });

  it("applies the photo album + public link + batch for an ALREADY-created (relay) project — the only live path", async () => {
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Portfolio Deal", procore_project_id: 12345 }] })
      .mockResolvedValue({ rows: [] });
    ensureAlbumMock.mockResolvedValue(true);
    ensureLinkMock.mockResolvedValue(true);
    enqueueBatchMock.mockResolvedValue(undefined);

    await handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" });

    expect(ensureAlbumMock).toHaveBeenCalledWith({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" });
    expect(ensureLinkMock).toHaveBeenCalledWith({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" });
    expect(enqueueBatchMock).toHaveBeenCalledWith({ officeId: "office-1", dealId: "deal-1" });
    // It links onto the EXISTING project; it must not create a new sync-state row as if it created the project.
    expect(clientQueryMock.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("INSERT INTO public.procore_sync_state");
  });

  it("runProcoreSync (15-min poll) makes NO Procore calls — SyncHub owns project status / change-order sync", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Procore poll"));
    const { runProcoreSync } = await import("./procore-sync.js");

    await runProcoreSync();

    expect(fetchMock).not.toHaveBeenCalled();
    // Gated before it ever opens a DB connection to enumerate offices/linked deals.
    expect(connectMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("handleSyncStage pushes NOTHING to Procore even for a linked deal with a real stage mapping (gated)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Procore stage push"));
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    // A linked deal WITH a Procore stage mapping — ungated, this would PATCH the Procore project.
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] }) // office slug (resolved first by handleProcoreSyncJob)
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [{ procore_stage_mapping: "Course of Construction" }] })
      .mockResolvedValue({ rows: [] });

    await handleProcoreSyncJob({ action: "sync_stage", dealId: "deal-1", officeId: "office-1", crmStageId: "won" });

    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("handleProcoreWebhookJob does NOT sync status/CO back to the CRM, but marks the webhook processed", async () => {
    const { handleProcoreWebhookJob } = await import("./procore-sync.js");
    // A resolvable office — ungated, the handler would BEGIN a tx and run syncProjectStatusToCrm.
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ office_id: "office-1", slug: "main" }] })
      .mockResolvedValue({ rows: [] });

    await handleProcoreWebhookJob({ webhookLogId: 7, eventType: "project.update", payload: { project: { id: 12345 } } });

    const sql = clientQueryMock.mock.calls.map((c) => String(c[0])).join("\n");
    // Gated before resolving the office / opening a tx: no office join, no tx, no reverse-stage / CO sync.
    expect(sql).not.toContain("JOIN public.procore_sync_state");
    expect(sql).not.toContain("BEGIN");
    expect(sql).not.toContain("pipeline_stage_config");
    expect(sql).not.toContain(".change_orders");
    // Still marks the webhook processed so it doesn't retry forever.
    expect(sql).toContain("procore_webhook_log");
  });

  it("does not touch Procore helpers when the office slug is invalid", async () => {
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock.mockResolvedValueOnce({ rows: [{ slug: "../bad" }] });

    await handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" });

    expect(ensureAlbumMock).not.toHaveBeenCalled();
    expect(ensureLinkMock).not.toHaveBeenCalled();
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });
});
