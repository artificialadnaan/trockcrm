import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FILES_ASSOCIATION_CHECK_DISCOVERY_SQL,
  FILES_ASSOCIATION_CHECK_REPAIR_MIGRATION,
  buildDropFilesAssociationCheckStatement,
  runFilesAssociationCheckRepair,
} from "../../src/migrations/files-association-check-repair.js";

const runnerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/migrations/runner.ts",
);
const runnerSource = readFileSync(runnerPath, "utf8");
const repairMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0241_files_association_check_repair.sql",
);
const repairMigrationSource = readFileSync(repairMigrationPath, "utf8");

describe("0241 files association check repair runner wiring", () => {
  it("discovers only the named tenant-table CHECK and validates the schema before DDL", () => {
    expect(FILES_ASSOCIATION_CHECK_DISCOVERY_SQL).toContain("c.conname = 'files_association_check'");
    expect(FILES_ASSOCIATION_CHECK_DISCOVERY_SQL).toContain("c.contype = 'c'");
    expect(FILES_ASSOCIATION_CHECK_DISCOVERY_SQL).toContain("relation.relname = 'files'");
    expect(FILES_ASSOCIATION_CHECK_DISCOVERY_SQL).toContain("n.nspname LIKE 'office\\_%'");
    expect(buildDropFilesAssociationCheckStatement("office_dallas")).toBe(
      'ALTER TABLE "office_dallas".files DROP CONSTRAINT IF EXISTS files_association_check',
    );
    expect(() => buildDropFilesAssociationCheckStatement("office_dallas; DROP SCHEMA public")).toThrow(
      "Invalid office schema name",
    );
  });

  it("installs the old-container guard before the repair scan and migration ledger", () => {
    const branch = runnerSource.indexOf(`file === FILES_ASSOCIATION_CHECK_REPAIR_MIGRATION`);
    const sql = runnerSource.indexOf("await client.query(sql)", branch);
    const repair = runnerSource.indexOf("await runFilesAssociationCheckRepair(client)", sql);
    const ledger = runnerSource.indexOf('"INSERT INTO public._migrations (name) VALUES ($1)"', branch);

    expect(FILES_ASSOCIATION_CHECK_REPAIR_MIGRATION).toBe("0241_files_association_check_repair.sql");
    expect(branch).toBeGreaterThanOrEqual(0);
    expect(sql).toBeGreaterThan(branch);
    expect(repair).toBeGreaterThan(sql);
    expect(ledger).toBeGreaterThan(repair);
  });

  it("keeps a deferred office-provision guard for old API containers", () => {
    expect(repairMigrationSource).toContain(
      "CREATE CONSTRAINT TRIGGER files_association_check_on_office_provision",
    );
    expect(repairMigrationSource).toContain("AFTER INSERT ON public.offices");
    expect(repairMigrationSource).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(repairMigrationSource).toContain(
      "EXECUTE FUNCTION public.repair_files_association_check_after_office_provision()",
    );
  });

  it("commits one affected office before locking the next", async () => {
    const calls: string[] = [];
    const query = async (statement: string) => {
      calls.push(statement);
      if (statement === FILES_ASSOCIATION_CHECK_DISCOVERY_SQL) {
        return { rows: [{ schema_name: "office_atlanta" }, { schema_name: "office_dallas" }] };
      }
      return { rows: [] };
    };

    await runFilesAssociationCheckRepair({ query } as never);

    expect(calls).toEqual([
      FILES_ASSOCIATION_CHECK_DISCOVERY_SQL,
      "BEGIN",
      buildDropFilesAssociationCheckStatement("office_atlanta"),
      "COMMIT",
      "BEGIN",
      buildDropFilesAssociationCheckStatement("office_dallas"),
      "COMMIT",
    ]);
  });
});
