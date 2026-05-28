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

  it("(b) wraps the caller's SQL in a transaction-level READ ONLY transaction", async () => {
    const { deps, client } = makeDeps();
    const code = await runSql.main(deps);
    expect(code).toBe(0);
    const queries = client.calls.filter((c) => c.method === "query").map((c) => c.sql);
    expect(queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(queries[1]).toBe("SELECT 1");
    expect(queries[2]).toBe(FIXTURE_SQL);
    expect(queries[3]).toBe("COMMIT");
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
          sql === "BEGIN TRANSACTION READ ONLY" || sql === "COMMIT"
            ? { command: sql.split(" ")[0], rowCount: null, fields: [], rows: [] }
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

  it("(d) preserves fields for each result in multi-statement output", () => {
    const out = runSql.formatResult([
      {
        command: "SELECT",
        rowCount: 1,
        fields: [{ name: "a" }],
        rows: [{ a: 1 }],
      },
      {
        command: "SELECT",
        rowCount: 1,
        fields: [{ name: "b" }],
        rows: [{ b: 2 }],
      },
    ]);

    const entries = out.split("\n").map((line: string) => JSON.parse(line));
    expect(entries).toEqual([
      { command: "SELECT", rowCount: 1, fields: ["a"], rows: [{ a: 1 }] },
      { command: "SELECT", rowCount: 1, fields: ["b"], rows: [{ b: 2 }] },
    ]);
    expect(Object.keys(entries[0])).toEqual(["command", "rowCount", "fields", "rows"]);
    expect(Object.keys(entries[1])).toEqual(["command", "rowCount", "fields", "rows"]);
  });

  it("(e) rejects SET TRANSACTION READ WRITE bypass attempts and rolls back", async () => {
    const payload = "SET TRANSACTION READ WRITE; CREATE TABLE test_should_not_exist (id int);";
    let readOnlyTransactionStarted = false;
    let transactionCharacteristicsFrozen = false;
    const client = makeFakeClient({
      onQuery: (sql) => {
        if (sql === "BEGIN TRANSACTION READ ONLY") {
          readOnlyTransactionStarted = true;
          return { command: "BEGIN", rowCount: null, fields: [], rows: [] };
        }
        if (sql === "SELECT 1" && readOnlyTransactionStarted) {
          transactionCharacteristicsFrozen = true;
          return { command: "SELECT", rowCount: 1, fields: [{ name: "?column?" }], rows: [{ "?column?": 1 }] };
        }
        if (sql === payload && readOnlyTransactionStarted && transactionCharacteristicsFrozen) {
          return Promise.reject(new Error("cannot set transaction read-write mode inside a read-only transaction"));
        }
        if (sql === "ROLLBACK") {
          readOnlyTransactionStarted = false;
          transactionCharacteristicsFrozen = false;
          return { command: "ROLLBACK", rowCount: null, fields: [], rows: [] };
        }
        return { command: "SELECT", rowCount: 0, fields: [], rows: [] };
      },
    });
    const { deps, error } = makeDeps({
      argv: ["node", "scripts/run-sql.cjs", payload],
      client,
    });

    const code = await runSql.main(deps);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "SQL ERROR: cannot set transaction read-write mode inside a read-only transaction",
    );
    expect(client.calls).toEqual([
      { method: "connect" },
      { method: "query", sql: "BEGIN TRANSACTION READ ONLY" },
      { method: "query", sql: "SELECT 1" },
      { method: "query", sql: payload },
      { method: "query", sql: "ROLLBACK" },
      { method: "end" },
    ]);
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("(f) rejects COMMIT escape attempts before running caller SQL", async () => {
    const payload = "COMMIT; CREATE TABLE test_should_not_exist (id int);";
    const client = makeFakeClient({
      onQuery: (sql) => {
        if (sql === payload) return Promise.reject(new Error("caller SQL should not be executed"));
        if (sql === "BEGIN TRANSACTION READ ONLY") return { command: "BEGIN", rowCount: null, fields: [], rows: [] };
        if (sql === "SELECT 1") return { command: "SELECT", rowCount: 1, fields: [{ name: "?column?" }], rows: [{ "?column?": 1 }] };
        if (sql === "ROLLBACK") return { command: "ROLLBACK", rowCount: null, fields: [], rows: [] };
        return { command: "SELECT", rowCount: 0, fields: [], rows: [] };
      },
    });
    const { deps, error } = makeDeps({
      argv: ["node", "scripts/run-sql.cjs", payload],
      client,
    });

    const code = await runSql.main(deps);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("SQL ERROR: Transaction boundary statements are not allowed in read-only SQL.");
    expect(client.calls).toEqual([
      { method: "connect" },
      { method: "query", sql: "BEGIN TRANSACTION READ ONLY" },
      { method: "query", sql: "SELECT 1" },
      { method: "query", sql: "ROLLBACK" },
      { method: "end" },
    ]);
  });

  it("(g) returns exit code 1 and cleans up the connection on a query error", async () => {
    const client = makeFakeClient({
      onQuery: (sql) => {
        if (sql === "BEGIN TRANSACTION READ ONLY") return { command: "BEGIN", rowCount: null, fields: [], rows: [] };
        if (sql === "SELECT 1") return { command: "SELECT", rowCount: 1, fields: [{ name: "?column?" }], rows: [{ "?column?": 1 }] };
        if (sql === "ROLLBACK") return { command: "ROLLBACK", rowCount: null, fields: [], rows: [] };
        return Promise.reject(new Error("relation does not exist"));
      },
    });
    const { deps, error } = makeDeps({ client });
    const code = await runSql.main(deps);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("SQL ERROR: relation does not exist");
    expect(client.calls.filter((c) => c.method === "query").map((c) => c.sql)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SELECT 1",
      FIXTURE_SQL,
      "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("(h) prefers DATABASE_PUBLIC_URL when both it and CRM_DATABASE_URL are set", () => {
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

  it("(i) never reads DATABASE_URL — even when it is the only variable set", async () => {
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
