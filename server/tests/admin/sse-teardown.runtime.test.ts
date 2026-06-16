import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { registerSseConnection, closeUserSseConnections, getConnectionCount } from "../../src/modules/notifications/sse-manager.js";

function fakeRes() {
  const calls: string[] = [];
  let ended = false;
  const res = {
    write: (s: string) => { calls.push(s); return true; },
    end: () => { ended = true; },
    flush: () => {},
  } as unknown as Response;
  return { res, calls, get ended() { return ended; } };
}

describe("closeUserSseConnections", () => {
  it("ends every registered stream for the user, empties the registry, returns the count", () => {
    const a = fakeRes();
    const b = fakeRes();
    registerSseConnection("user-1", "office-1", a.res);
    registerSseConnection("user-1", "office-1", b.res);
    const before = getConnectionCount();
    const closed = closeUserSseConnections("user-1");
    expect(closed).toBe(2);
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(getConnectionCount()).toBe(before - 2);
  });

  it("is a no-op (0) for a user with no streams", () => {
    expect(closeUserSseConnections("nobody")).toBe(0);
  });
});
