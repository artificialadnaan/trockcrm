import { describe, expect, it } from "vitest";
import { mergeNearbyProjects, type FieldProject } from "../../../src/modules/field/projects-service.js";

const office = (slug: string) => ({ id: `office-${slug}`, slug });

function project(id: string, distanceMiles: number | null): FieldProject {
  return {
    id,
    name: id,
    dealNumber: id,
    projectNumber: id,
    propertyName: null,
    propertyAddress: null,
    stage: "Active",
    lastActivityAt: null,
    photoCount: 0,
    starred: false,
    distanceMiles,
  };
}

describe("mergeNearbyProjects", () => {
  it("returns the TRUE global nearest across offices, not nearest-per-office", () => {
    const merged = mergeNearbyProjects(
      [
        { office: office("dfw"), projects: [project("a", 1.0), project("c", 8.0)] },
        { office: office("atl"), projects: [project("b", 2.0), project("d", 4.0)] },
      ],
      3,
    );
    // Global order by distance: a(1) < b(2) < d(4) < c(8) → top 3 = a, b, d.
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "d"]);
  });

  it("stamps each row with its owning office", () => {
    const merged = mergeNearbyProjects(
      [{ office: office("dfw"), projects: [project("a", 1.0)] }],
      3,
    );
    expect(merged[0]).toMatchObject({ id: "a", officeSlug: "dfw", officeId: "office-dfw" });
  });

  it("sorts null/absent distances last and breaks ties by id", () => {
    const merged = mergeNearbyProjects(
      [{ office: office("dfw"), projects: [project("z", null), project("y", 5.0), project("x", 5.0)] }],
      3,
    );
    expect(merged.map((p) => p.id)).toEqual(["x", "y", "z"]);
  });

  it("never returns more than the limit", () => {
    const merged = mergeNearbyProjects(
      [{ office: office("dfw"), projects: [project("a", 1), project("b", 2), project("c", 3), project("d", 4)] }],
      3,
    );
    expect(merged).toHaveLength(3);
  });
});
