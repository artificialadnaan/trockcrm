import { describe, expect, it, vi } from "vitest";
import { startSession, recordHeartbeat, recordViewEvents } from "../../../src/modules/usage/collection-service.js";

function tenantDbCapturingInsert() {
  const inserted: unknown[] = [];
  const chain = {
    values: vi.fn().mockImplementation((v: unknown) => {
      inserted.push(v);
      return { returning: vi.fn().mockResolvedValue([{ id: "new-session-id" }]) };
    }),
  };
  return {
    db: { insert: vi.fn().mockReturnValue(chain) } as any,
    inserted,
  };
}

describe("startSession", () => {
  it("inserts a session for the user with the user agent and impersonator stamp", async () => {
    const { db, inserted } = tenantDbCapturingInsert();
    const result = await startSession(db, {
      userId: "rep-1",
      userAgent: "Mozilla/5.0",
      impersonatorId: "admin-9",
    });
    expect(result).toEqual({ sessionId: "new-session-id" });
    expect(inserted[0]).toMatchObject({
      userId: "rep-1",
      userAgent: "Mozilla/5.0",
      impersonatorId: "admin-9",
    });
  });

  it("stamps null impersonator for a normal session", async () => {
    const { db, inserted } = tenantDbCapturingInsert();
    await startSession(db, { userId: "rep-1", userAgent: "UA", impersonatorId: null });
    expect(inserted[0]).toMatchObject({ impersonatorId: null });
  });
});

describe("recordHeartbeat", () => {
  it("inserts a heartbeat row and updates the session last_heartbeat_at", async () => {
    const heartbeatInserts: unknown[] = [];
    const sessionUpdates: unknown[] = [];
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v: unknown) => { heartbeatInserts.push(v); return Promise.resolve(); }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((v: unknown) => { sessionUpdates.push(v); return { where: vi.fn().mockResolvedValue(undefined) }; }),
      }),
    } as any;

    await recordHeartbeat(db, { userId: "rep-1", sessionId: "s1" });

    expect(heartbeatInserts[0]).toMatchObject({ userId: "rep-1", sessionId: "s1" });
    expect((sessionUpdates[0] as { lastHeartbeatAt: Date }).lastHeartbeatAt).toBeInstanceOf(Date);
  });
});

describe("recordViewEvents", () => {
  it("batch-inserts events with user + session attached", async () => {
    const inserts: unknown[] = [];
    const db = { insert: vi.fn().mockReturnValue({ values: vi.fn().mockImplementation((v: unknown) => { inserts.push(v); return Promise.resolve(); }) }) } as any;
    await recordViewEvents(db, "rep-1", "s1", [
      { entityType: "deal", entityId: "d-1", route: "/deals/d-1", labelSnapshot: "Tides" },
    ]);
    expect((inserts[0] as unknown[])[0]).toMatchObject({ userId: "rep-1", sessionId: "s1", entityType: "deal" });
  });

  it("no-ops on an empty batch", async () => {
    const db = { insert: vi.fn() } as any;
    await recordViewEvents(db, "rep-1", "s1", []);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
