import { describe, expect, it, vi } from "vitest";
import { isBrokenConnectionError, releasePooledClient } from "../src/db.js";

describe("isBrokenConnectionError", () => {
  it("flags query_timeout and connection-level failures", () => {
    expect(isBrokenConnectionError(new Error("Query read timeout"))).toBe(true);
    expect(isBrokenConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isBrokenConnectionError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isBrokenConnectionError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true); // admin_shutdown
    expect(isBrokenConnectionError(Object.assign(new Error("x"), { code: "08006" }))).toBe(true); // connection_failure
  });

  it("does NOT flag ordinary query errors (the connection is still healthy)", () => {
    expect(isBrokenConnectionError(Object.assign(new Error("dup key"), { code: "23505" }))).toBe(false);
    expect(isBrokenConnectionError(new Error("syntax error at or near"))).toBe(false);
    expect(isBrokenConnectionError(undefined)).toBe(false);
    expect(isBrokenConnectionError(null)).toBe(false);
    expect(isBrokenConnectionError("nope")).toBe(false);
  });
});

describe("releasePooledClient", () => {
  it("DESTROYS the client on a broken-connection error (release called with the error)", () => {
    const release = vi.fn();
    const err = new Error("Query read timeout");
    releasePooledClient({ release } as never, err);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toBe(err); // truthy arg => node-pg discards the socket
  });

  it("releases cleanly (reuses the connection) with no error", () => {
    const release = vi.fn();
    releasePooledClient({ release } as never, undefined);
    expect(release).toHaveBeenCalledWith();
  });

  it("releases cleanly on an ordinary query error so the healthy connection is reused", () => {
    const release = vi.fn();
    releasePooledClient({ release } as never, Object.assign(new Error("dup"), { code: "23505" }));
    expect(release).toHaveBeenCalledWith();
  });
});
