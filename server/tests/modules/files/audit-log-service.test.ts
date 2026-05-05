import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHOTO_AUDIT_EVENT_TYPES } from "@trock-crm/shared/types";

const schemaMocks = vi.hoisted(() => ({
  photoAuditLog: {
    id: "id",
    photoId: "photo_id",
    eventType: "event_type",
    userId: "user_id",
    createdAt: {
      desc: vi.fn(() => "created_at_desc"),
    },
    ipAddress: "ip_address",
    userAgent: "user_agent",
    metadata: "metadata",
  },
  users: {
    id: "user_id",
    displayName: "display_name",
    avatarUrl: "avatar_url",
  },
  files: {
    id: "file_id",
    displayName: "display_name",
    fileExtension: "file_extension",
    r2Key: "r2_key",
    externalUrl: "external_url",
    externalThumbnailUrl: "external_thumbnail_url",
    dealId: "deal_id",
  },
  deals: {
    id: "deal_id",
    name: "deal_name",
    dealNumber: "deal_number",
  },
}));

vi.mock("@trock-crm/shared/schema", () => schemaMocks);

const {
  getAdminPhotoAuditEvents,
  getPhotoAuditEvents,
  logPhotoEvent,
  normalizePhotoAuditRow,
  parseCsvQueryParam,
  parsePhotoAuditEventTypes,
} = await import(
  "../../../src/modules/files/audit-log-service.js"
);

function createInsertDb(options: { shouldFail?: boolean } = {}) {
  const values = vi.fn(async () => {
    if (options.shouldFail) throw new Error("insert failed");
    return [];
  });
  const insert = vi.fn(() => ({ values }));
  return { insert, values };
}

describe("photo audit log service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(PHOTO_AUDIT_EVENT_TYPES)("writes %s events with request metadata", async (eventType) => {
    const db = createInsertDb();

    await logPhotoEvent(db as any, {
      photoId: "photo-1",
      eventType,
      userId: "user-1",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      metadata: { eventType },
    });

    expect(db.insert).toHaveBeenCalledWith(schemaMocks.photoAuditLog);
    expect(db.values).toHaveBeenCalledWith({
      photoId: "photo-1",
      eventType,
      userId: "user-1",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      metadata: { eventType },
    });
  });

  it("does not throw when the insert fails", async () => {
    const db = createInsertDb({ shouldFail: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(logPhotoEvent(db as any, {
      photoId: "photo-1",
      eventType: "deleted",
      userId: "user-1",
    })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write photo audit event"),
      expect.objectContaining({ photoId: "photo-1", eventType: "deleted", userId: "user-1" }),
      expect.any(Error)
    );
  });

  it("normalizes joined rows for the photo history and admin page", () => {
    const row = normalizePhotoAuditRow({
      id: "audit-1",
      event_type: "category_changed",
      user_id: "user-1",
      user_name: "Kaleb Martin",
      user_avatar_url: null,
      created_at: new Date("2026-05-04T12:00:00.000Z"),
      ip_address: "127.0.0.1",
      user_agent: "vitest",
      metadata: { oldCategory: "damage", newCategory: "safety" },
      photo_id: "photo-1",
      photo_display_name: "Roof damage",
      photo_file_extension: ".jpg",
      photo_r2_key: "office/deals/photos/photo.jpg",
      photo_external_url: null,
      photo_external_thumbnail_url: "https://example.test/photo-thumb.jpg",
      deal_id: "deal-1",
      deal_name: "Test Deal",
      deal_number: "TR-1",
    });

    expect(row).toMatchObject({
      id: "audit-1",
      eventType: "category_changed",
      userName: "Kaleb Martin",
      createdAt: "2026-05-04T12:00:00.000Z",
      metadata: { oldCategory: "damage", newCategory: "safety" },
      photo: {
        id: "photo-1",
        displayName: "Roof damage",
        externalThumbnailUrl: "https://example.test/photo-thumb.jpg",
      },
      deal: {
        id: "deal-1",
        name: "Test Deal",
        dealNumber: "TR-1",
      },
    });
  });

  it("parses repeated and comma-separated query params", () => {
    expect(parseCsvQueryParam(["uploaded,deleted", "restored"])).toEqual(["uploaded", "deleted", "restored"]);
    expect(parseCsvQueryParam("")).toEqual([]);
    expect(parseCsvQueryParam(undefined)).toEqual([]);
    expect(parsePhotoAuditEventTypes(["uploaded", "not_real"])).toEqual(["uploaded"]);
  });

  it("returns single-photo audit history ordered by the service query", async () => {
    const execute = vi.fn(async () => ({
      rows: [{
        id: "audit-1",
        event_type: "uploaded",
        user_id: "user-1",
        user_name: "Kaleb Martin",
        user_avatar_url: null,
        created_at: "2026-05-04T18:00:00.000Z",
        ip_address: null,
        user_agent: null,
        metadata: {},
      }],
    }));

    const rows = await getPhotoAuditEvents({ execute } as any, "photo-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(rows).toEqual([expect.objectContaining({
      id: "audit-1",
      eventType: "uploaded",
      userName: "Kaleb Martin",
      createdAt: "2026-05-04T18:00:00.000Z",
    })]);
  });

  it("returns paginated admin audit rows with photo and deal details", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "audit-1",
          event_type: "downloaded",
          user_id: "user-1",
          user_name: "Kaleb Martin",
          user_avatar_url: null,
          created_at: "2026-05-04T18:00:00.000Z",
          ip_address: "127.0.0.1",
          user_agent: "vitest",
          metadata: {},
          photo_id: "photo-1",
          photo_display_name: "Roof",
          photo_file_extension: ".jpg",
          photo_r2_key: "photo.jpg",
          photo_external_url: null,
          photo_external_thumbnail_url: null,
          deal_id: "deal-1",
          deal_name: "Deal",
          deal_number: "TR-1",
        }],
      });

    const result = await getAdminPhotoAuditEvents({ execute } as any, {
      userIds: ["user-1"],
      eventTypes: ["downloaded"],
      from: "2026-05-01",
      to: "2026-05-05",
      dealId: "deal-1",
      photoId: "photo-1",
      page: Number.NaN,
      perPage: 500,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(200);
    expect(result.events[0]).toMatchObject({
      eventType: "downloaded",
      photo: { id: "photo-1", displayName: "Roof" },
      deal: { id: "deal-1", name: "Deal" },
    });
  });
});
