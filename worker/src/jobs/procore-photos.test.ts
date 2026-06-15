import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolQueryMock = vi.hoisted(() => vi.fn());
const clientQueryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn(() => ({ query: clientQueryMock, release: releaseMock })));

vi.mock("../db.js", () => ({
  pool: {
    query: poolQueryMock,
    connect: connectMock,
  },
}));

describe("procore photo worker", () => {
  let fetchMock: any;

  beforeEach(() => {
    // Fresh module per test so the module-level Procore token cache (workerCachedToken) doesn't leak
    // a still-valid token across tests and shift the sequential fetch mocks.
    vi.resetModules();
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Procore API call"));
    delete process.env.PROCORE_PHOTOS_PUSH_ENABLED;
    delete process.env.PROCORE_LINK_CREATION_ENABLED;
    delete process.env.PROCORE_CLIENT_ID;
    delete process.env.PROCORE_CLIENT_SECRET;
    delete process.env.PROCORE_COMPANY_ID;
    delete process.env.FRONTEND_URL;
    delete process.env.PUBLIC_SHARE_BASE_URL; // new precedence over FRONTEND_URL — keep tests env-independent
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("leaves photo rows untouched when Procore photo push is feature-flagged off", async () => {
    const { handleProcorePhotoSyncJob } = await import("./procore-photos.js");
    poolQueryMock.mockResolvedValueOnce({ rows: [{ slug: "main" }] });
    clientQueryMock.mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] });

    await handleProcorePhotoSyncJob({ dealId: "deal-1", officeId: "office-1" }, null);

    const sqlText = clientQueryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("UPDATE office_main.files");
    expect(sqlText).not.toContain("procore_sync_status = 'pending'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create public viewer links when link creation is feature-flagged off", async () => {
    const { ensurePublicPhotoLinkForDeal } = await import("./procore-photos.js");

    const result = await ensurePublicPhotoLinkForDeal({
      officeId: "office-1",
      schemaName: "office_main",
      dealId: "deal-1",
    });

    expect(result).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create the Procore image category while photo push is feature-flagged off", async () => {
    const { ensureTRockPhotosAlbumForDeal } = await import("./procore-photos.js");

    const result = await ensureTRockPhotosAlbumForDeal({
      officeId: "office-1",
      schemaName: "office_main",
      dealId: "deal-1",
    });

    expect(result).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes a batch of pending photos, skips already-synced photos, stores Procore ids, and writes audit logs", async () => {
    process.env.PROCORE_PHOTOS_PUSH_ENABLED = "true";
    const { handleProcorePhotoSyncJob } = await import("./procore-photos.js");
    poolQueryMock.mockResolvedValueOnce({ rows: [{ slug: "main" }] });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [{ procore_image_category_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: "photo-1", display_name: "Photo 1", file_extension: ".jpg", mime_type: "image/jpeg", external_url: "https://files.test/1.jpg", description: "One", uploaded_by: "user-1", procore_sync_status: null, procore_photo_id: null },
          { id: "photo-2", display_name: "Photo 2", file_extension: ".jpg", mime_type: "image/jpeg", external_url: "https://files.test/2.jpg", description: "Two", uploaded_by: "user-2", procore_sync_status: "failed", procore_photo_id: null },
          { id: "photo-3", display_name: "Photo 3", file_extension: ".jpg", mime_type: "image/jpeg", external_url: "https://files.test/3.jpg", description: "Three", uploaded_by: "user-3", procore_sync_status: "synced", procore_photo_id: "pc-3" },
        ],
      })
      .mockResolvedValue({ rows: [] });
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response);

    await handleProcorePhotoSyncJob({ dealId: "deal-1", officeId: "office-1" }, null);

    const sqlText = clientQueryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText.match(/procore_sync_status = 'pending'/g)).toHaveLength(2);
    expect(sqlText.match(/procore_sync_status = 'synced'/g)).toHaveLength(2);
    expect(sqlText).toContain("procore_photo_id");
    expect(sqlText.match(/'procore_synced'/g)).toHaveLength(2);
    expect(sqlText).not.toContain("photo-3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks failed photo syncs failed and writes a procore_sync_failed audit event", async () => {
    process.env.PROCORE_PHOTOS_PUSH_ENABLED = "true";
    const { handleProcorePhotoSyncJob } = await import("./procore-photos.js");
    poolQueryMock.mockResolvedValueOnce({ rows: [{ slug: "main" }] });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [{ procore_image_category_id: 55 }] })
      .mockResolvedValueOnce({
        rows: [{ id: "photo-1", display_name: "Photo 1", file_extension: ".jpg", mime_type: "image/jpeg", external_url: "https://files.test/1.jpg", description: "One", uploaded_by: "user-1", procore_sync_status: null, procore_photo_id: null }],
      })
      .mockResolvedValue({ rows: [] });
    fetchMock.mockRejectedValueOnce(new Error("download failed"));

    await expect(handleProcorePhotoSyncJob({ dealId: "deal-1", officeId: "office-1" }, null)).rejects.toThrow("download failed");

    const sqlText = clientQueryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("procore_sync_status = 'failed'");
    expect(sqlText).toContain("'procore_sync_failed'");
  });

  it("uses at most three concurrent photo transfers", async () => {
    process.env.PROCORE_PHOTOS_PUSH_ENABLED = "true";
    const { handleProcorePhotoSyncJob } = await import("./procore-photos.js");
    poolQueryMock.mockResolvedValueOnce({ rows: [{ slug: "main" }] });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [{ procore_image_category_id: 55 }] })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 5 }, (_, index) => ({
          id: `photo-${index + 1}`,
          display_name: `Photo ${index + 1}`,
          file_extension: ".jpg",
          mime_type: "image/jpeg",
          external_url: `https://files.test/${index + 1}.jpg`,
          description: null,
          uploaded_by: "user-1",
          procore_sync_status: null,
          procore_photo_id: null,
        })),
      })
      .mockResolvedValue({ rows: [] });
    let active = 0;
    let maxActive = 0;
    fetchMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new Uint8Array([1]).buffer } as unknown as Response;
    });

    await handleProcorePhotoSyncJob({ dealId: "deal-1", officeId: "office-1" }, null);

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("creates public photo links when enabled and marks 403s as permission denied without throwing", async () => {
    process.env.PROCORE_LINK_CREATION_ENABLED = "true";
    process.env.PROCORE_CLIENT_ID = "client-id";
    process.env.PROCORE_CLIENT_SECRET = "client-secret";
    process.env.PROCORE_COMPANY_ID = "company-1";
    process.env.FRONTEND_URL = "https://crm.test";
    const { ensurePublicPhotoLinkForDeal } = await import("./procore-photos.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345, procore_photo_link_id: null, procore_photo_link_status: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValue({ rows: [{ id: "admin-1" }] });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "token", expires_in: 3600 }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" } as Response);

    await expect(ensurePublicPhotoLinkForDeal({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" })).resolves.toBe(false);

    expect(clientQueryMock.mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.stringContaining("procore_photo_link_status = $1"), expect.arrayContaining(["permission_denied", "deal-1"])]),
    ]));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/links/bulk_update"), expect.objectContaining({ method: "PATCH" }));
  });

  it("captures the Procore link id from the {data:[...]} bulk_update response (not null)", async () => {
    process.env.PROCORE_LINK_CREATION_ENABLED = "true";
    process.env.PROCORE_CLIENT_ID = "client-id";
    process.env.PROCORE_CLIENT_SECRET = "client-secret";
    process.env.PROCORE_COMPANY_ID = "company-1";
    process.env.FRONTEND_URL = "https://crm.test";
    const { ensurePublicPhotoLinkForDeal } = await import("./procore-photos.js");
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345, procore_photo_link_id: null, procore_photo_link_status: null }] }) // deal select
      .mockResolvedValueOnce({ rows: [] }) // token insert
      .mockResolvedValueOnce({ rows: [] }); // deal update
    poolQueryMock.mockResolvedValue({ rows: [{ id: "admin-1" }] });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "token", expires_in: 3600 }) } as Response)
      // Procore returns the created/updated links wrapped in { data: [...] } — NOT a bare array.
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ id: "link-99", title: "T Rock Photos" }] }) } as Response);

    await expect(ensurePublicPhotoLinkForDeal({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" })).resolves.toBe(true);

    // The link id must be persisted (so re-runs can update-by-id and the early-return fires), NOT null.
    const updateCall = clientQueryMock.mock.calls.find((c) => String(c[0]).includes("procore_photo_link_id = $1"));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(["link-99", "deal-1"]);
  });

  it("is idempotent: a re-run with an existing link id + 'created' status mints no new token and calls no Procore API", async () => {
    process.env.PROCORE_LINK_CREATION_ENABLED = "true";
    process.env.PROCORE_CLIENT_ID = "client-id";
    process.env.PROCORE_CLIENT_SECRET = "client-secret";
    process.env.PROCORE_COMPANY_ID = "company-1";
    process.env.FRONTEND_URL = "https://crm.test";
    const { ensurePublicPhotoLinkForDeal } = await import("./procore-photos.js");
    // Deal already has a captured link id + 'created' status (the steady state after the first run).
    clientQueryMock.mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345, procore_photo_link_id: "link-99", procore_photo_link_status: "created" }] });

    await expect(ensurePublicPhotoLinkForDeal({ officeId: "office-1", schemaName: "office_main", dealId: "deal-1" })).resolves.toBe(true);

    const sqlText = clientQueryMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sqlText).not.toContain("INSERT INTO public.public_photo_tokens"); // no duplicate token
    expect(fetchMock).not.toHaveBeenCalled(); // no duplicate "T Rock Photos" link appended
    expect(clientQueryMock).toHaveBeenCalledTimes(1); // only the deal SELECT, then early-return
  });

  it("enqueues batch and single Procore photo sync jobs", async () => {
    const { enqueueProcorePhotoBatch, enqueueProcorePhotoSingle } = await import("./procore-photos.js");
    poolQueryMock.mockResolvedValue({ rows: [] });

    await enqueueProcorePhotoBatch({ officeId: "00000000-0000-4000-8000-000000000001", dealId: "deal-1" });
    await enqueueProcorePhotoSingle({ officeId: "00000000-0000-4000-8000-000000000001", dealId: "deal-1", photoId: "photo-1" });

    expect(poolQueryMock).toHaveBeenCalledTimes(2);
    expect(poolQueryMock.mock.calls[0][1][0]).toContain('"action":"batch"');
    expect(poolQueryMock.mock.calls[1][1][0]).toContain('"action":"single"');
  });

});
