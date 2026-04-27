import { describe, expect, it } from "vitest";
import { groupPhotoUploadTargets } from "./photo-capture-page";
import type { PhotoUploadTarget } from "@/hooks/use-files";

function target(input: Partial<PhotoUploadTarget> & Pick<PhotoUploadTarget, "id" | "type">): PhotoUploadTarget {
  return {
    name: input.name ?? input.id,
    recordNumber: input.recordNumber ?? null,
    stageName: input.stageName ?? null,
    companyName: input.companyName ?? null,
    lastUpdatedAt: input.lastUpdatedAt ?? "2026-04-27T00:00:00.000Z",
    ...input,
  };
}

describe("photo capture upload targets", () => {
  it("groups searchable upload targets by record lifecycle section", () => {
    const grouped = groupPhotoUploadTargets([
      target({ id: "lead-1", type: "lead" }),
      target({ id: "opp-1", type: "opportunity" }),
      target({ id: "deal-1", type: "deal" }),
      target({ id: "lead-2", type: "lead" }),
    ]);

    expect(grouped.lead.map((entry) => entry.id)).toEqual(["lead-1", "lead-2"]);
    expect(grouped.opportunity.map((entry) => entry.id)).toEqual(["opp-1"]);
    expect(grouped.deal.map((entry) => entry.id)).toEqual(["deal-1"]);
  });
});
