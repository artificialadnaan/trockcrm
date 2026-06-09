import { describe, expect, it, vi } from "vitest";
import { startSession, recordHeartbeat } from "./collection-service.js";

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
