import { describe, expect, it } from "vitest";
import { canArchiveLead } from "./lead-archive-eligibility";

const activeLead = { assignedRepId: "rep-1", isActive: true, status: "open" };

describe("canArchiveLead", () => {
  it("allows the assigned owner and admins", () => {
    expect(canArchiveLead(activeLead, { id: "rep-1", role: "rep" })).toBe(true);
    expect(canArchiveLead(activeLead, { id: "admin-1", role: "admin" })).toBe(true);
  });

  it("does not elevate a non-owner director or rep", () => {
    expect(canArchiveLead(activeLead, { id: "director-1", role: "director" })).toBe(false);
    expect(canArchiveLead(activeLead, { id: "rep-2", role: "rep" })).toBe(false);
  });

  it("hides archive for inactive, converted, and disqualified records", () => {
    expect(canArchiveLead({ ...activeLead, isActive: false }, { id: "admin-1", role: "admin" })).toBe(false);
    expect(canArchiveLead({ ...activeLead, status: "converted" }, { id: "admin-1", role: "admin" })).toBe(false);
    expect(canArchiveLead({ ...activeLead, status: "disqualified" }, { id: "admin-1", role: "admin" })).toBe(false);
  });
});
