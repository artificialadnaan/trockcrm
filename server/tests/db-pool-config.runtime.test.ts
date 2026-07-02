import { describe, expect, it, vi } from "vitest";
import { pool, isBrokenConnectionError, releasePooledClient } from "../src/db.js";

// The API server's pool had no defense against a dead/half-open socket: node-pg's connectionTimeoutMillis
// only bounds ACQUIRING a connection, not a query on one already checked out. When Railway's private
// network silently drops a long-lived connection, the next query on it blocks on a socket read with no
// error and pins the pooled client until the process restarts — connections leak until the pool exhausts
// and requests start failing (the "Couldn't load deals" picker symptom). These options make a hung query
// reject and free its connection instead. node-pg surfaces the resolved config on `pool.options`.
describe("API DB pool resilience config", () => {
  it("enables TCP keepAlive so a dead peer is detected instead of hanging forever", () => {
    expect(pool.options.keepAlive).toBe(true);
    expect(pool.options.keepAliveInitialDelayMillis).toBeGreaterThan(0);
  });

  it("sets a client-side query_timeout that backstops (never precedes) the 30s tenant statement_timeout", () => {
    // query_timeout is a node-pg client-side timer, so it fires even when the socket is dead — unlike a
    // server-side statement_timeout, which a gone backend can never enforce. It must sit ABOVE the tenant
    // transaction's 30s statement_timeout so it only ever catches a stuck/dead query, not a slow-but-legit one.
    expect(pool.options.query_timeout).toBeGreaterThan(30000);
  });

  it("sets a server-side statement_timeout for queries that bypass the tenant middleware", () => {
    // Auth, office lookups, LISTEN/NOTIFY setup, and direct pool.query calls never run the tenant
    // middleware's `SET LOCAL statement_timeout`, so give the pool a default ceiling too.
    expect(pool.options.statement_timeout).toBe(30000);
  });
});

// A pool-level query_timeout can reject a query on a DEAD socket without node-pg auto-removing the
// checked-out client (unlike pool.query()), so callers holding a client (tenant middleware, cross-office
// fan-out) must destroy it on a broken-connection error — else the next request inherits the dead socket.
describe("isBrokenConnectionError", () => {
  it("flags dead-socket / shutdown / timeout errors as broken", () => {
    expect(isBrokenConnectionError({ code: "ECONNRESET" })).toBe(true);
    expect(isBrokenConnectionError({ code: "57P01" })).toBe(true); // admin_shutdown
    expect(isBrokenConnectionError({ code: "08006" })).toBe(true); // connection_failure
    expect(isBrokenConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isBrokenConnectionError(new Error("Query read timeout"))).toBe(true);
  });

  it("does NOT flag normal query errors or absent errors (connection stays reusable)", () => {
    expect(isBrokenConnectionError({ code: "23505" })).toBe(false); // unique_violation
    expect(isBrokenConnectionError(new Error("null value violates not-null constraint"))).toBe(false);
    expect(isBrokenConnectionError(null)).toBe(false);
    expect(isBrokenConnectionError(undefined)).toBe(false);
  });
});

describe("releasePooledClient", () => {
  it("destroys the client (release(err)) on a broken-connection error", () => {
    const client = { release: vi.fn() } as any;
    releasePooledClient(client, { code: "ECONNRESET" });
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("releases cleanly (no arg) on a normal query error", () => {
    const client = { release: vi.fn() } as any;
    releasePooledClient(client, { code: "23505" });
    expect(client.release).toHaveBeenCalledWith();
  });

  it("releases cleanly when there is no error", () => {
    const client = { release: vi.fn() } as any;
    releasePooledClient(client);
    expect(client.release).toHaveBeenCalledWith();
  });
});
