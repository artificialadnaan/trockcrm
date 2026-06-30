import { describe, expect, it } from "vitest";
import { mergeFieldProjects, type FieldProject } from "../../../src/modules/field/projects-service.js";

const office = (slug: string) => ({ id: `office-${slug}`, slug });

function project(id: string, photoCount: number, lastActivityAt: string | null): FieldProject {
  return {
    id,
    name: id,
    dealNumber: id,
    projectNumber: id,
    propertyName: null,
    propertyAddress: null,
    stage: "Active",
    lastActivityAt,
    photoCount,
    starred: false,
  };
}

describe("mergeFieldProjects", () => {
  it("ranks projects WITH photos above projects with none, across offices", () => {
    const merged = mergeFieldProjects([
      // dfw: an empty project touched today, and a photo'd project touched a week ago.
      {
        office: office("dfw"),
        projects: [project("empty-today", 0, "2026-06-29T00:00:00.000Z"), project("photos-old", 4, "2026-06-22T00:00:00.000Z")],
      },
      // atl: a photo'd project touched yesterday.
      { office: office("atl"), projects: [project("photos-recent", 2, "2026-06-28T00:00:00.000Z")] },
    ]);
    // Both photo'd projects come first (recent-first within the group), THEN the empty one —
    // even though the empty one was touched most recently overall.
    expect(merged.map((p) => p.id)).toEqual(["photos-recent", "photos-old", "empty-today"]);
  });

  it("orders by recency desc within each photo group", () => {
    const merged = mergeFieldProjects([
      {
        office: office("dfw"),
        projects: [
          project("with-a", 1, "2026-06-20T00:00:00.000Z"),
          project("with-b", 9, "2026-06-25T00:00:00.000Z"),
          project("none-a", 0, "2026-06-10T00:00:00.000Z"),
          project("none-b", 0, "2026-06-15T00:00:00.000Z"),
        ],
      },
    ]);
    expect(merged.map((p) => p.id)).toEqual(["with-b", "with-a", "none-b", "none-a"]);
  });

  it("sorts null lastActivityAt last and breaks ties by id", () => {
    const merged = mergeFieldProjects([
      {
        office: office("dfw"),
        projects: [
          project("z", 0, null),
          project("y", 0, "2026-06-15T00:00:00.000Z"),
          project("x", 0, "2026-06-15T00:00:00.000Z"),
        ],
      },
    ]);
    // x and y share a timestamp → id tiebreak (x before y); the null sorts last.
    expect(merged.map((p) => p.id)).toEqual(["x", "y", "z"]);
  });

  it("stamps each row with its owning office", () => {
    const merged = mergeFieldProjects([{ office: office("dfw"), projects: [project("a", 3, "2026-06-20T00:00:00.000Z")] }]);
    expect(merged[0]).toMatchObject({ id: "a", officeSlug: "dfw", officeId: "office-dfw" });
  });
});
