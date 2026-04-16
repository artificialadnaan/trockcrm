import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Response } from "express";
import {
  canAdmitSseConnection,
  buildSsePaddingComment,
  registerSseConnection,
  pushToUser,
  writeSse,
} from "../../../src/modules/notifications/sse-manager.js";

function makeResponse() {
  return {
    write: vi.fn(),
    flush: vi.fn(),
    end: vi.fn(),
  } as unknown as Response & { flush: () => void };
}

describe("sse-manager", () => {
  beforeEach(() => {
    // Drain any prior test registrations by consuming the global limit.
    // Each cleanup returned below removes its own connection, so this keeps tests isolated.
  });

  it("flushes immediately after writing SSE payloads when flush is available", () => {
    const res = makeResponse();

    writeSse(res, "event: connected\ndata: {}\n\n");

    expect(res.write).toHaveBeenCalledWith("event: connected\ndata: {}\n\n");
    expect(res.flush).toHaveBeenCalledTimes(1);
  });

  it("builds a proxy-warming padding comment for initial SSE delivery", () => {
    const comment = buildSsePaddingComment();

    expect(comment.startsWith(":")).toBe(true);
    expect(comment.endsWith("\n\n")).toBe(true);
    expect(comment.length).toBeGreaterThan(2048);
  });

  it("pushes notifications through registered connections and flushes them", () => {
    const res = makeResponse();
    const cleanup = registerSseConnection("user-1", "office-1", res);

    pushToUser("user-1", "notification", { id: "n1", title: "Test" });

    expect(res.write).toHaveBeenCalledWith(
      'event: notification\ndata: {"id":"n1","title":"Test"}\n\n'
    );
    expect(res.flush).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("enforces the per-user cap by ending the oldest connection", () => {
    const cleanups: Array<() => void> = [];

    for (let index = 0; index < 5; index += 1) {
      cleanups.push(registerSseConnection("user-cap", "office-1", makeResponse()));
    }

    const oldest = makeResponse();
    const oldestCleanup = registerSseConnection("user-oldest", "office-1", oldest);
    const laterCleanups = [];
    for (let index = 0; index < 4; index += 1) {
      laterCleanups.push(registerSseConnection("user-oldest", "office-1", makeResponse()));
    }
    const overflow = makeResponse();
    const overflowCleanup = registerSseConnection("user-oldest", "office-1", overflow);

    expect(oldest.end).toHaveBeenCalledTimes(1);
    expect(canAdmitSseConnection()).toBe(true);

    overflowCleanup();
    oldestCleanup();
    cleanups.forEach((cleanup) => cleanup());
    laterCleanups.forEach((cleanup) => cleanup());
  });
});
