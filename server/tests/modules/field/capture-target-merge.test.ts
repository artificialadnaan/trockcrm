import { describe, expect, it } from "vitest";
import { mergeFieldCaptureTargets } from "../../../src/modules/field/projects-service.js";
import type { FieldOffice } from "../../../src/modules/field/cross-office.js";
import type { PhotoUploadTarget } from "../../../src/modules/files/service.js";

const dallas: FieldOffice = { id: "id-dallas", slug: "dallas" };
const atlanta: FieldOffice = { id: "id-atlanta", slug: "atlanta" };

function target(over: Partial<PhotoUploadTarget> & Pick<PhotoUploadTarget, "id" | "type">): PhotoUploadTarget {
  return {
    name: over.id,
    recordNumber: null,
    stageName: null,
    companyName: null,
    lastUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

describe("mergeFieldCaptureTargets", () => {
  it("stamps every target with its owning office", () => {
    const merged = mergeFieldCaptureTargets(
      [{ office: dallas, targets: [target({ id: "d1", type: "deal" })] }],
      30,
    );
    expect(merged[0]).toMatchObject({ id: "d1", officeSlug: "dallas", officeId: "id-dallas" });
  });

  it("groups by type (lead → opportunity → deal) across offices, recency desc within a type", () => {
    const merged = mergeFieldCaptureTargets(
      [
        {
          office: dallas,
          targets: [
            target({ id: "deal-old", type: "deal", lastUpdatedAt: new Date("2026-01-01T00:00:00.000Z") }),
            target({ id: "lead-dallas", type: "lead", lastUpdatedAt: new Date("2026-02-01T00:00:00.000Z") }),
          ],
        },
        {
          office: atlanta,
          targets: [
            target({ id: "deal-new", type: "deal", lastUpdatedAt: new Date("2026-05-01T00:00:00.000Z") }),
            target({ id: "lead-atlanta", type: "lead", lastUpdatedAt: new Date("2026-03-01T00:00:00.000Z") }),
          ],
        },
      ],
      30,
    );
    // leads first (atlanta newer than dallas), then deals (atlanta newer than dallas).
    expect(merged.map((t) => t.id)).toEqual(["lead-atlanta", "lead-dallas", "deal-new", "deal-old"]);
  });

  it("applies a GLOBAL limit across offices (not limit-per-office)", () => {
    const many = (office: FieldOffice, prefix: string) => ({
      office,
      targets: Array.from({ length: 20 }, (_, i) =>
        target({ id: `${prefix}-${i}`, type: "deal", lastUpdatedAt: new Date(2026, 0, 1, 0, i) }),
      ),
    });
    const merged = mergeFieldCaptureTargets([many(dallas, "d"), many(atlanta, "a")], 25);
    expect(merged).toHaveLength(25); // 40 candidates capped to the global 25, not 2×20
  });

  it("is deterministic for equal type+recency (stable id tiebreak)", () => {
    const ts = new Date("2026-04-01T00:00:00.000Z");
    const merged = mergeFieldCaptureTargets(
      [
        { office: atlanta, targets: [target({ id: "bbb", type: "deal", lastUpdatedAt: ts })] },
        { office: dallas, targets: [target({ id: "aaa", type: "deal", lastUpdatedAt: ts })] },
      ],
      30,
    );
    expect(merged.map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });
});
