import { describe, expect, it } from "vitest";
import {
  parseBackfillArgs,
  buildBackfillPlan,
  runBackfillForSchema,
  discoverOfficeSchemas,
  missingFileColumns,
  REQUIRED_FILE_COLUMNS,
  type OtherFileRow,
  type QueryClient,
} from "../../../scripts/backfill-file-categories.js";

function row(over: Partial<OtherFileRow> & { id: string }): OtherFileRow {
  return {
    originalFilename: null,
    mimeType: null,
    subcategory: null,
    folderPath: null,
    changeOrderId: null,
    createdAt: null,
    ...over,
  };
}

interface FakeOpts {
  otherRows: OtherFileRow[];
  before: Record<string, number>;
  after?: Record<string, number>;
  /** rowCount the guarded UPDATE returns (default 1; 0 simulates a concurrent modification). */
  updateRowCount?: number;
}

function createFakeClient(opts: FakeOpts) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  let censusCalls = 0;
  const client: QueryClient = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      const t = text.trim();
      if (t.startsWith("SET search_path")) return { rows: [], rowCount: null };
      if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [], rowCount: null };
      if (t.startsWith("SELECT category")) {
        const src = censusCalls === 0 ? opts.before : opts.after ?? opts.before;
        censusCalls += 1;
        return { rows: Object.entries(src).map(([category, count]) => ({ category, count })), rowCount: null };
      }
      if (t.startsWith("SELECT id")) return { rows: opts.otherRows, rowCount: opts.otherRows.length };
      if (t.startsWith("UPDATE files")) return { rows: [], rowCount: opts.updateRowCount ?? 1 };
      throw new Error(`Unexpected query: ${t}`);
    },
  };
  return { client, queries };
}

describe("backfill-file-categories", () => {
  it("parseBackfillArgs defaults to dry-run and accepts exactly one mode", () => {
    expect(parseBackfillArgs(["node", "s"])).toEqual({ mode: "dry-run" });
    expect(parseBackfillArgs(["node", "s", "--dry-run"])).toEqual({ mode: "dry-run" });
    expect(parseBackfillArgs(["node", "s", "--commit"])).toEqual({ mode: "commit" });
    expect(() => parseBackfillArgs(["node", "s", "--commit", "--dry-run"])).toThrow("exactly one");
  });

  it("plans only rows that infer to a real (non-other) category; skips the rest", () => {
    const plan = buildBackfillPlan([
      row({ id: "a", originalFilename: "Master Contract.pdf", mimeType: "application/pdf", folderPath: "Correspondence" }),
      row({ id: "b", originalFilename: "site.jpg", mimeType: "image/jpeg" }),
      row({ id: "c", originalFilename: "random.pdf", mimeType: "application/pdf" }),
      row({ id: "d", originalFilename: "scan.pdf", mimeType: "application/pdf", changeOrderId: "co-9" }),
    ]);
    // Each change records the OLD folder_path (for revert) + the NEW one matching the inferred category.
    expect(plan.willUpdate).toEqual([
      { id: "a", from: "other", fromFolderPath: "Correspondence", to: "contract", newFolderPath: "Contracts" },
      { id: "b", from: "other", fromFolderPath: null, to: "photo", newFolderPath: "Photos" },
      { id: "d", from: "other", fromFolderPath: null, to: "change_order", newFolderPath: "Change Orders" },
    ]);
    expect(plan.skipped).toBe(1);
    expect(plan.byTarget).toEqual({ contract: 1, photo: 1, change_order: 1 });
  });

  it("dry-run reads but never writes (no BEGIN/UPDATE/COMMIT, no after census)", async () => {
    const { client, queries } = createFakeClient({
      otherRows: [row({ id: "a", originalFilename: "contract.pdf", mimeType: "application/pdf" })],
      before: { other: 10, photo: 5 },
    });
    const result = await runBackfillForSchema(client, "office_dallas", "dry-run");

    expect(result.plan.willUpdate).toHaveLength(1);
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.after).toBeUndefined();
    // The fetch excludes stage-gate-linked (scoping-intake) docs so the backfill can't break a gate.
    expect(queries.find((q) => q.text.trim().startsWith("SELECT id"))?.text).toContain("scoping_intake");
    expect(queries.some((q) => q.text.trim().startsWith("UPDATE"))).toBe(false);
    expect(queries.some((q) => q.text.trim() === "BEGIN")).toBe(false);
  });

  it("commit updates only category='other' rows, guarded + transactional + idempotent re-check", async () => {
    const { client, queries } = createFakeClient({
      otherRows: [
        row({ id: "a", originalFilename: "Master Contract.pdf", mimeType: "application/pdf" }),
        row({ id: "c", originalFilename: "random.pdf", mimeType: "application/pdf" }),
      ],
      before: { other: 2 },
      after: { other: 1, contract: 1 },
    });
    const result = await runBackfillForSchema(client, "office_dallas", "commit");

    // Only the row the UPDATE actually changed (rowCount > 0) is recorded as applied — this is the
    // basis for the audit snapshot, so it matches what was committed.
    expect(result.appliedChanges).toEqual([
      { id: "a", from: "other", fromFolderPath: null, to: "contract", newFolderPath: "Contracts" },
    ]);
    expect(result.after).toEqual({ other: 1, contract: 1 });

    const updates = queries.filter((q) => q.text.trim().startsWith("UPDATE files"));
    expect(updates).toHaveLength(1);
    // Data-integrity guard: the write is scoped to category='other' so it never clobbers a set category.
    expect(updates[0].text).toContain("category = 'other'");
    // Also moves the file into the folder matching its new category (id is the final param).
    expect(updates[0].text).toContain("folder_path = $2");
    // Write-guard also re-checks the scoping-intake exclusion (protects rows linked mid-run).
    expect(updates[0].text).toContain("scoping_intake");
    expect(updates[0].params).toEqual(["contract", "Contracts", "a"]);
    // Transactional
    expect(queries.some((q) => q.text.trim() === "BEGIN")).toBe(true);
    expect(queries.some((q) => q.text.trim() === "COMMIT")).toBe(true);
  });

  it("is a no-op when there are no category='other' rows (idempotent second run)", async () => {
    const { client, queries } = createFakeClient({ otherRows: [], before: { contract: 3 }, after: { contract: 3 } });
    const result = await runBackfillForSchema(client, "office_atlanta", "commit");
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.plan.willUpdate).toHaveLength(0);
    expect(queries.some((q) => q.text.trim().startsWith("UPDATE"))).toBe(false);
    expect(queries.some((q) => q.text.trim() === "BEGIN")).toBe(false);
  });

  it("excludes rows the guarded UPDATE did not change (concurrent modification → rowCount 0)", async () => {
    const { client } = createFakeClient({
      otherRows: [row({ id: "a", originalFilename: "Master Contract.pdf", mimeType: "application/pdf" })],
      before: { other: 1 },
      after: { other: 1 },
      updateRowCount: 0, // the row's category changed between SELECT and UPDATE → guard matches 0 rows
    });
    const result = await runBackfillForSchema(client, "office_dallas", "commit");
    // Planned, but the guard prevented the write, so it's NOT recorded as applied (and the audit
    // snapshot, built from appliedChanges, won't list it → a revert can't clobber the concurrent value).
    expect(result.plan.willUpdate).toHaveLength(1);
    expect(result.appliedChanges).toHaveLength(0);
  });

  it("discovers office_* schemas at runtime and ignores non-office namespaces", async () => {
    const client: QueryClient = {
      async query(text: string) {
        if (text.includes("pg_namespace")) {
          return {
            rows: [{ nspname: "office_atlanta" }, { nspname: "office_dallas" }, { nspname: "public" }],
            rowCount: 3,
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    };
    expect(await discoverOfficeSchemas(client)).toEqual(["office_atlanta", "office_dallas"]);
  });

  function columnsClient(presentColumns: string[]): { client: QueryClient; params: unknown[][] } {
    const params: unknown[][] = [];
    const client: QueryClient = {
      async query(text: string, p?: unknown[]) {
        if (text.includes("information_schema.columns")) {
          params.push(p ?? []);
          return { rows: presentColumns.map((column_name) => ({ column_name })), rowCount: presentColumns.length };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    };
    return { client, params };
  }

  it("reports no missing columns when the office's files table has every required column", async () => {
    const { client, params } = columnsClient([...REQUIRED_FILE_COLUMNS, "extra_unused_column"]);
    expect(await missingFileColumns(client, "office_dallas")).toEqual([]);
    // looks the table up by table_schema (no search_path dependency), so it can't throw 42703 itself
    expect(params).toEqual([["office_dallas"]]);
  });

  it("flags the exact drifted column so a missing intake_source is skipped, not thrown (42703 guard)", async () => {
    const present = REQUIRED_FILE_COLUMNS.filter((c) => c !== "intake_source");
    const { client } = columnsClient([...present]);
    expect(await missingFileColumns(client, "office_pwauditoffice")).toEqual(["intake_source"]);
  });

  it("treats a missing files table (zero columns) as all-columns-missing rather than erroring", async () => {
    const { client } = columnsClient([]);
    expect(await missingFileColumns(client, "office_ghost")).toEqual([...REQUIRED_FILE_COLUMNS]);
  });

  it("rejects an unsafe schema name before querying", async () => {
    const { client } = columnsClient([...REQUIRED_FILE_COLUMNS]);
    await expect(missingFileColumns(client, "public; drop table files")).rejects.toThrow("Unsafe schema name");
  });
});
