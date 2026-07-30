import { describe, expect, it } from "vitest";
import { canArchiveDeal } from "./deal-archive-eligibility";

const deal = (assignedRepId: string | null) => ({ assignedRepId });

describe("canArchiveDeal", () => {
  it("admins can archive a deal they do not own", () => {
    expect(canArchiveDeal(deal("r1"), { id: "r2", role: "admin" })).toBe(true);
  });

  it("an owner can archive their own deal", () => {
    expect(canArchiveDeal(deal("r1"), { id: "r1", role: "rep" })).toBe(true);
  });

  it("a non-owner non-admin cannot archive", () => {
    expect(canArchiveDeal(deal("r1"), { id: "r2", role: "rep" })).toBe(false);
  });

  it("no user cannot archive", () => {
    expect(canArchiveDeal(deal("r1"), null)).toBe(false);
    expect(canArchiveDeal(deal("r1"), undefined)).toBe(false);
  });

  it("STAGE IS NOT A FACTOR for an owner — the rule this replaced admitted only opportunity/dd", () => {
    // The previous rule made the control dead on nearly every real deal: `dd` is seeded
    // is_active_pipeline=FALSE, so `opportunity` was effectively the only archivable stage. These slugs are
    // passed as extra properties precisely to prove the helper ignores them.
    for (const stageSlug of [
      "opportunity",
      "dd",
      "estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "contract",
      "in_production",
      "closed_won",
      "closed_lost",
    ]) {
      // Built via a variable so TypeScript's excess-property check does not fire — the point of the test is
      // that a REAL deal object carrying a stage still resolves on ownership alone.
      const withStage = { ...deal("r1"), stageSlug };
      expect(canArchiveDeal(withStage, { id: "r1", role: "rep" })).toBe(true);
    }
  });

  it("a non-admin cannot archive a change-order CHILD, even one they own", () => {
    // Deleting a CO removes its earned commission, which the server reserves for admins
    // (CHANGE_ORDER_ADMIN_ONLY). Showing the item here would open a dialog that 403s on submit.
    expect(canArchiveDeal({ assignedRepId: "r1", isChangeOrder: true }, { id: "r1", role: "rep" })).toBe(false);
    expect(canArchiveDeal({ assignedRepId: "r1", isChangeOrder: true }, { id: "r2", role: "admin" })).toBe(true);
  });

  it("a non-admin cannot archive a PARENT that still has active change-order children", () => {
    // Archiving the parent cascades: every child is voided and its commission removed — the same
    // admin-only operation, reached indirectly. This is the hole that removing the stage gate opened.
    expect(
      canArchiveDeal({ assignedRepId: "r1", activeChangeOrderChildCount: 1 }, { id: "r1", role: "rep" }),
    ).toBe(false);
    expect(
      canArchiveDeal({ assignedRepId: "r1", activeChangeOrderChildCount: 1 }, { id: "r2", role: "admin" }),
    ).toBe(true);
  });

  it("a parent with NO active change-order children is still archivable by its owner", () => {
    // The carve-out must not swallow the ordinary case; 0 and absent both mean "nothing cascades".
    expect(
      canArchiveDeal({ assignedRepId: "r1", activeChangeOrderChildCount: 0 }, { id: "r1", role: "rep" }),
    ).toBe(true);
    expect(canArchiveDeal({ assignedRepId: "r1" }, { id: "r1", role: "rep" })).toBe(true);
  });

  it("an absent assignedRepId never matches an absent user id", () => {
    // Guards the nullish case: two undefined values must not read as "this viewer owns it".
    expect(canArchiveDeal(deal(null), { id: undefined, role: "rep" })).toBe(false);
    expect(canArchiveDeal({}, { id: undefined, role: "rep" })).toBe(false);
  });
});
