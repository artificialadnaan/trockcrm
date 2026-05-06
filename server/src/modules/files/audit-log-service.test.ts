import { describe, expect, it, vi } from "vitest";
import {
  getAdminPhotoAuditEvents,
  getPhotoAuditEvents,
  logPhotoEvent,
  normalizePhotoAuditRow,
  parseCsvQueryParam,
  parsePhotoAuditEventTypes,
} from "./audit-log-service.js";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    event_type: "uploaded",
    user_id: "user-1",
    user_name: "User One",
    user_avatar_url: "avatar.jpg",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ip_address: "127.0.0.1",
    user_agent: "vitest",
    metadata: { a: 1 },
    photo_id: "photo-1",
    photo_display_name: "Photo",
    photo_file_extension: "jpg",
    photo_r2_key: "key",
    photo_external_url: null,
    photo_external_thumbnail_url: null,
    deal_id: "deal-1",
    deal_name: "Deal",
    deal_number: "D-1",
    ...overrides,
  };
}

describe("photo audit log service", () => {
  it("logs photo events and swallows write errors", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const tenantDb = { insert: vi.fn(() => ({ values })) } as any;
    await logPhotoEvent(tenantDb, { photoId: "photo-1", eventType: "uploaded", userId: "user-1", metadata: { viaPublicToken: true } });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ photoId: "photo-1", eventType: "uploaded", userId: "user-1", metadata: { viaPublicToken: true } }));

    const errorDb = { insert: vi.fn(() => ({ values: vi.fn().mockRejectedValue(new Error("db down")) })) } as any;
    await expect(logPhotoEvent(errorDb, { photoId: "photo-1", eventType: "downloaded", userId: "user-1" })).resolves.toBeUndefined();
  });

  it("parses CSV query params and filters event types", () => {
    expect(parseCsvQueryParam(["a,b", " c ", ""])).toEqual(["a", "b", "c"]);
    expect(parseCsvQueryParam(undefined)).toEqual([]);
    expect(parsePhotoAuditEventTypes("uploaded,not-real,downloaded")).toEqual(["uploaded", "downloaded"]);
  });

  it("normalizes joined audit rows with nullable photo and deal", () => {
    expect(normalizePhotoAuditRow(row())).toEqual(expect.objectContaining({
      id: "audit-1",
      eventType: "uploaded",
      createdAt: "2026-01-01T00:00:00.000Z",
      photo: expect.objectContaining({ id: "photo-1", displayName: "Photo" }),
      deal: expect.objectContaining({ id: "deal-1", dealNumber: "D-1" }),
    }));
    expect(normalizePhotoAuditRow(row({ photo_id: null, deal_id: null, created_at: "2026-01-02" }))).toEqual(expect.objectContaining({ photo: null, deal: null, createdAt: "2026-01-02" }));
  });

  it("loads audit events for a photo", async () => {
    const tenantDb = { execute: vi.fn().mockResolvedValue({ rows: [row()] }) } as any;
    await expect(getPhotoAuditEvents(tenantDb, "photo-1")).resolves.toHaveLength(1);
    expect(tenantDb.execute).toHaveBeenCalledTimes(1);
  });

  it("loads admin audit events with pagination and filters", async () => {
    const tenantDb = { execute: vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [row()] }) } as any;

    const result = await getAdminPhotoAuditEvents(tenantDb, {
      userIds: ["user-1"],
      eventTypes: ["uploaded"],
      from: "2026-01-01",
      to: "2026-01-02",
      dealId: "deal-1",
      photoId: "photo-1",
      procoreSyncStatuses: ["failed"],
      page: 0,
      perPage: 500,
    });

    expect(result).toEqual(expect.objectContaining({ total: 1, page: 1, perPage: 200 }));
    expect(result.events).toHaveLength(1);
    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });
});
