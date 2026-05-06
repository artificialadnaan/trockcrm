import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("procore sync worker photo-link integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PROCORE_CLIENT_ID;
    delete process.env.PROCORE_CLIENT_SECRET;
    process.env.PROCORE_COMPANY_ID = "company-1";
  });

  it("runs photo album, public link, and batch enqueue after creating a Portfolio Procore project", async () => {
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Portfolio Deal", procore_project_id: null, property_address: "100 Main", property_city: "Dallas", property_state: "TX", property_zip: "75201" }] })
      .mockResolvedValue({ rows: [] });
    ensureAlbumMock.mockResolvedValue(true);
    ensureLinkMock.mockResolvedValue(true);
    enqueueBatchMock.mockResolvedValue(undefined);

    await handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" });

    expect(ensureAlbumMock).toHaveBeenCalledWith({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" });
    expect(ensureLinkMock).toHaveBeenCalledWith({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" });
    expect(enqueueBatchMock).toHaveBeenCalledWith({ officeId: "office-1", dealId: "deal-1" });
    expect(clientQueryMock.mock.calls.map((call) => String(call[0])).join("\n")).toContain("procore_project_id = $1");
  });

  it("re-enters Portfolio idempotently for an existing Procore project and re-enqueues sync", async () => {
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Portfolio Deal", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [] });

    await handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" });

    expect(ensureAlbumMock).toHaveBeenCalledOnce();
    expect(ensureLinkMock).toHaveBeenCalledOnce();
    expect(enqueueBatchMock).toHaveBeenCalledOnce();
    expect(clientQueryMock.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("INSERT INTO public.procore_sync_state");
  });

  it("keeps Procore untouched on stage rollback when no Procore stage mapping exists", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Procore mutation"));
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [{ procore_stage_mapping: null }] });

    await handleProcoreSyncJob({ action: "sync_stage", dealId: "deal-1", officeId: "office-1", crmStageId: "bid-board" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureAlbumMock).not.toHaveBeenCalled();
    expect(ensureLinkMock).not.toHaveBeenCalled();
    expect(enqueueBatchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("does not call Procore helpers when the office slug is invalid", async () => {
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock.mockResolvedValueOnce({ rows: [{ slug: "../bad" }] });

    await handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" });

    expect(ensureAlbumMock).not.toHaveBeenCalled();
    expect(ensureLinkMock).not.toHaveBeenCalled();
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("surfaces project creation errors so the job queue can retry", async () => {
    process.env.PROCORE_CLIENT_ID = "client-id";
    process.env.PROCORE_CLIENT_SECRET = "client-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token", expires_in: 3600 }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" } as Response);
    const { handleProcoreSyncJob } = await import("./procore-sync.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ slug: "main" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Portfolio Deal", procore_project_id: null, property_address: "100 Main" }] })
      .mockResolvedValue({ rows: [] });

    await expect(handleProcoreSyncJob({ action: "create_project", dealId: "deal-1", officeId: "office-1" })).rejects.toThrow("Procore project creation failed: 500 server error");

    expect(clientQueryMock.mock.calls.map((call) => String(call[0]))).toContain("ROLLBACK");
    expect(ensureAlbumMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/projects"), expect.objectContaining({ method: "POST" }));
    fetchMock.mockRestore();
  });
});
