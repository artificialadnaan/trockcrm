import { describe, expect, it } from "vitest";
import {
  buildReseedSummary,
  KNOWN_SMOKE_CLEANUP_ASSIGNMENTS,
  parseReseedSmokeCleanupArgs,
  selectAssignmentsToUpdate,
} from "../../../scripts/reseed-smoke-cleanup";

describe("reseed smoke cleanup script helpers", () => {
  it("defaults to dry-run for the Dallas test-sales cleanup assignments", () => {
    expect(parseReseedSmokeCleanupArgs([])).toEqual({
      execute: false,
      tenant: "office_dallas",
      email: "test-sales@trock.test",
    });
  });

  it("requires an explicit execute flag before writes are allowed", () => {
    expect(parseReseedSmokeCleanupArgs(["--execute"]).execute).toBe(true);
    expect(parseReseedSmokeCleanupArgs(["--dry-run", "--execute"]).execute).toBe(true);
  });

  it("keeps the known smoke cleanup target set at exactly six records", () => {
    expect(KNOWN_SMOKE_CLEANUP_ASSIGNMENTS).toHaveLength(6);
    expect(KNOWN_SMOKE_CLEANUP_ASSIGNMENTS.map((assignment) => assignment.recordType).sort()).toEqual([
      "company",
      "contact",
      "contact",
      "deal",
      "deal",
      "deal",
    ]);
  });

  it("summarizes idempotent reseed work without double-counting already-pending rows", () => {
    const summary = buildReseedSummary([
      { assignmentId: "a1", statusBefore: "pending", found: true },
      { assignmentId: "a2", statusBefore: "completed", found: true },
      { assignmentId: "a3", statusBefore: "skipped", found: true },
      { assignmentId: "a4", statusBefore: null, found: false },
    ]);

    expect(summary).toEqual({
      found: 3,
      missing: 1,
      alreadyPending: 1,
      toUpdate: 2,
    });
  });

  it("selects only non-pending resolved assignments for writes", () => {
    const rows = [
      { assignmentId: "a1", statusBefore: "pending", found: true },
      { assignmentId: "a2", statusBefore: "completed", found: true },
      { assignmentId: "a3", statusBefore: "skipped", found: true },
      { assignmentId: "a4", statusBefore: null, found: false },
    ].map((row) => ({
      ...row,
      expected: KNOWN_SMOKE_CLEANUP_ASSIGNMENTS[0],
      recordName: "SMOKE TEST DELETE - Example Company",
    }));

    expect(selectAssignmentsToUpdate(rows)).toEqual([
      expect.objectContaining({ assignmentId: "a2" }),
      expect.objectContaining({ assignmentId: "a3" }),
    ]);
  });
});
