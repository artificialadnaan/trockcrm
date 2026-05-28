import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// run-sql.cjs is CommonJS by design (matches the canonical helper). Load it with
// a native require so we get module.exports directly and the `require.main`
// auto-run guard stays false (no DB connection, no .env read at import time).
const require = createRequire(import.meta.url);
const runSql = require("../../../scripts/run-sql.cjs") as {
  resolveConnectionString: (env: Record<string, string | undefined>) => string;
  formatResult: (res: unknown) => string;
  runQuery: (client: { query: (sql: string) => Promise<unknown> }, sql: string) => Promise<unknown>;
  main: (deps: MainDeps) => Promise<number>;
  USAGE: string;
};

interface MainDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  log: (m: string) => void;
  error: (m: string) => void;
  createClient: (connectionString: string) => FakeClient;
}

interface QueryCall {
  method: "connect" | "query" | "end";
  sql?: string;
}

const FIXTURE_SQL = "SELECT count(*) FROM placeholder.widgets;";

function makeFakeClient(opts: { onQuery?: (sql: string) => unknown } = {}) {
  const calls: QueryCall[] = [];
  const client = {
    calls,
    connect: vi.fn(async () => {
      calls.push({ method: "connect" });
    }),
    end: vi.fn(async () => {
      calls.push({ method: "end" });
    }),
    query: vi.fn(async (sql: string) => {
      calls.push({ method: "query", sql });
      if (opts.onQuery) return opts.onQuery(sql);
      return { command: "SELECT", rowCount: 0, fields: [], rows: [] };
    }),
  };
  return client;
}
type FakeClient = ReturnType<typeof makeFakeClient>;

function makeDeps(overrides: Partial<MainDeps> & { client?: FakeClient } = {}) {
  const client = overrides.client ?? makeFakeClient();
  const log = vi.fn();
  const error = vi.fn();
  const createClient = vi.fn(() => client);
  const deps: MainDeps = {
    argv: ["node", "scripts/run-sql.cjs", FIXTURE_SQL],
    env: { DATABASE_PUBLIC_URL: "postgresql://fixture-public/db" },
    log,
    error,
    createClient,
    ...overrides,
  };
  return { deps, client, log, error, createClient };
}

describe("run-sql.cjs", () => {
  it("(a) aborts with the usage message when no SQL is provided", async () => {
    const { deps, error, createClient } = makeDeps({ argv: ["node", "scripts/run-sql.cjs"] });
    const code = await runSql.main(deps);
    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(runSql.USAGE);
    expect(runSql.USAGE).toBe('Usage: node scripts/run-sql.cjs "<SQL>"');
    expect(createClient).not.toHaveBeenCalled();
  });

  it("(b) issues SET default_transaction_read_only = on BEFORE the caller's SQL", async () => {
    const { deps, client } = makeDeps();
    const code = await runSql.main(deps);
    expect(code).toBe(0);
    const queries = client.calls.filter((c) => c.method === "query").map((c) => c.sql);
    expect(queries[0]).toBe("SET default_transaction_read_only = on");
    expect(queries[1]).toBe(FIXTURE_SQL);
  });

  it("(c) formats output as { command, rowCount, fields, rows } JSON", async () => {
    const out = runSql.formatResult({
      command: "SELECT",
      rowCount: 1,
      fields: [{ name: "count" }],
      rows: [{ count: "1193" }],
    });
    expect(JSON.parse(out)).toEqual({
      command: "SELECT",
      rowCount: 1,
      fields: ["count"],
      rows: [{ count: "1193" }],
    });

    // The same shape is emitted through main().
    const { deps, log } = makeDeps({
      client: makeFakeClient({
        onQuery: (sql) =>
          sql.startsWith("SET")
            ? { command: "SET", rowCount: null, rows: [] }
            : { command: "SELECT", rowCount: 1, fields: [{ name: "count" }], rows: [{ count: "1193" }] },
      }),
    });
    await runSql.main(deps);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({
      command: "SELECT",
      rowCount: 1,
      fields: ["count"],
      rows: [{ count: "1193" }],
    });
  });

  it("(d) returns exit code 1 and cleans up the connection on a query error", async () => {
    const client = makeFakeClient({
      onQuery: (sql) => {
        if (sql.startsWith("SET")) return { command: "SET", rowCount: null, rows: [] };
        return Promise.reject(new Error("relation does not exist"));
      },
    });
    const { deps, error } = makeDeps({ client });
    const code = await runSql.main(deps);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("SQL ERROR: relation does not exist");
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("(e) prefers DATABASE_PUBLIC_URL when both it and CRM_DATABASE_URL are set", () => {
    expect(
      runSql.resolveConnectionString({
        DATABASE_PUBLIC_URL: "postgresql://public/db",
        CRM_DATABASE_URL: "postgresql://crm/db",
      }),
    ).toBe("postgresql://public/db");
    expect(
      runSql.resolveConnectionString({ CRM_DATABASE_URL: "postgresql://crm/db" }),
    ).toBe("postgresql://crm/db");
  });

  it("(f) never reads DATABASE_URL — even when it is the only variable set", async () => {
    expect(
      runSql.resolveConnectionString({ DATABASE_URL: "postgresql://internal/db" }),
    ).toBe("");
    expect(
      runSql.resolveConnectionString({
        DATABASE_PUBLIC_URL: "postgresql://public/db",
        DATABASE_URL: "postgresql://internal/db",
      }),
    ).toBe("postgresql://public/db");

    // With only DATABASE_URL set, main() must refuse to connect.
    const { deps, createClient } = makeDeps({ env: { DATABASE_URL: "postgresql://internal/db" } });
    const code = await runSql.main(deps);
    expect(code).toBe(3);
    expect(createClient).not.toHaveBeenCalled();
  });
});
