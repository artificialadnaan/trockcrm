import { describe, expect, it } from "vitest";
import { canArchiveDeal } from "./deal-archive-eligibility";

const deal = (stageSlug: string, assignedRepId: string) => ({ stageSlug, assignedRepId });

describe("canArchiveDeal", () => {
  it("admins can archive any stage", () => {
    expect(canArchiveDeal(deal("awarded", "r1"), { id: "r2", role: "admin" })).toBe(true);
  });
  it("an owner rep can archive an opportunity deal", () => {
    expect(canArchiveDeal(deal("opportunity", "r1"), { id: "r1", role: "rep" })).toBe(true);
  });
  it("an owner rep can archive a legacy dd (opportunity alias) deal", () => {
    expect(canArchiveDeal(deal("dd", "r1"), { id: "r1", role: "rep" })).toBe(true);
  });
  it("an owner rep cannot archive a non-opportunity deal", () => {
    expect(canArchiveDeal(deal("awarded", "r1"), { id: "r1", role: "rep" })).toBe(false);
  });
  it("a non-owner non-admin cannot archive", () => {
    expect(canArchiveDeal(deal("opportunity", "r1"), { id: "r2", role: "rep" })).toBe(false);
  });
});
