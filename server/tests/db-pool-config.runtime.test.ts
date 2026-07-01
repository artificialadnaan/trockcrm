import { describe, expect, it } from "vitest";
import { pool } from "../src/db.js";

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
