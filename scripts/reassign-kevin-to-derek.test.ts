import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TARGETS,
  buildUpdateSql,
  parseArgs,
} from "./reassign-kevin-to-derek";

describe("Kevin to Derek reassignment script safety contract", () => {
  it("fails closed unless exactly one execution mode is selected", () => {
    expect(() => parseArgs([])).toThrow(/exactly one/i);
    expect(() => parseArgs(["--dry-run", "--commit"])).toThrow(/exactly one/i);
    expect(() => parseArgs(["--rollback-check", "--commit"])).toThrow(/exactly one/i);

    expect(parseArgs(["--dry-run"]).mode).toBe("dry-run");
    expect(parseArgs(["--rollback-check"]).mode).toBe("rollback-check");
    expect(parseArgs(["--commit"]).mode).toBe("commit");
  });

  it("covers every ownership or assignment field for deals, leads, contacts, and companies", () => {
    expect(ASSIGNMENT_TARGETS.map((target) => `${target.table}.${target.column}`)).toEqual([
      "deals.assigned_rep_id",
      "leads.assigned_rep_id",
      "leads.sales_rep_id",
      "contacts.owner_id",
      "companies.owner_id",
      "companies.assigned_approver_user_id",
    ]);
  });

  it("updates only the target assignment field and updated_at", () => {
    const sql = buildUpdateSql("office_dallas", ASSIGNMENT_TARGETS[0]);

    expect(sql).toContain("UPDATE \"office_dallas\".\"deals\"");
    expect(sql).toContain("SET \"assigned_rep_id\" = $2::uuid");
    expect(sql).toContain("\"updated_at\" = NOW()");
    expect(sql).toContain("WHERE \"assigned_rep_id\" = $1::uuid");
    expect(sql).not.toContain("ownership_sync_status");
    expect(sql).not.toContain("unassigned_reason_code");
  });
});
