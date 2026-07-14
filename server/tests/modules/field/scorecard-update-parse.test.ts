import { describe, expect, it, vi } from "vitest";

// scorecard-submission only needs the UUID boundary helper from photos-service. Mock that narrow seam so this
// pure parser suite does not initialize the photo/image/R2 stack (including optional native codecs).
vi.mock("../../../src/modules/field/photos-service.js", () => ({
  assertValidUuid(value: string, field: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`${field} must be a valid UUID`);
    }
  },
}));

import { parseScorecardUpdate } from "../../../src/modules/field/scorecard-submission.js";

const EXISTING_PHOTO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function projectItems() {
  return [
    "planning_precon",
    "jobsite_5s",
    "safety",
    "schedule",
    "subcontractor",
    "quality",
    "communication",
    "financial",
  ].map((sectionKey) => ({ sectionKey, points: 8, note: `  ${sectionKey} note  ` }));
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    expectedUpdatedAt: "2026-07-14T12:34:56.000Z",
    superintendentName: "  Sam Superintendent  ",
    pmName: "  Pat Manager  ",
    items: projectItems(),
    criticalDeficiencies: ["failed_inspection"],
    criticalDeficiencyNotes: { failed_inspection: "  Reinspect the repaired area.  " },
    actionItems: ["  Complete reinspection  "],
    photos: [
      {
        scorecardPhotoId: EXISTING_PHOTO,
        sectionKey: "quality",
        deficiencyKey: null,
      },
      {
        clientUploadId: "  new-upload-1  ",
        sectionKey: "critical_deficiency",
        deficiencyKey: "failed_inspection",
      },
    ],
    superintendentSignature: "  data:image/png;base64,super  ",
    pmSignature: "  Pat Manager  ",
    summary: null,
    ...overrides,
  };
}

describe("parseScorecardUpdate", () => {
  it("normalizes the concurrency token and preserves retained/new evidence references", () => {
    const parsed = parseScorecardUpdate(
      body({ expectedUpdatedAt: "2026-07-14T07:34:56-05:00" }),
    );

    expect(parsed.expectedUpdatedAt).toBe("2026-07-14T12:34:56.000Z");
    expect(parsed.superintendentName).toBe("Sam Superintendent");
    expect(parsed.pmName).toBe("Pat Manager");
    expect(parsed.items[0]).toMatchObject({
      sectionKey: "planning_precon",
      points: 8,
      note: "planning_precon note",
    });
    expect(parsed.criticalDeficiencyNotes).toEqual({
      failed_inspection: "Reinspect the repaired area.",
    });
    expect(parsed.actionItems).toEqual(["Complete reinspection"]);
    expect(parsed.photos).toEqual([
      {
        scorecardPhotoId: EXISTING_PHOTO,
        sectionKey: "quality",
        deficiencyKey: null,
      },
      {
        clientUploadId: "new-upload-1",
        sectionKey: "critical_deficiency",
        deficiencyKey: "failed_inspection",
      },
    ]);
  });

  it.each([undefined, null, "", "not-a-timestamp"])(
    "rejects an invalid expectedUpdatedAt token (%s)",
    (expectedUpdatedAt) => {
      expect(() => parseScorecardUpdate(body({ expectedUpdatedAt }))).toThrow(/expectedUpdatedAt/i);
    },
  );

  it("requires exactly one retained-link id or new-upload id for every evidence row", () => {
    expect(() =>
      parseScorecardUpdate(body({ photos: [{ sectionKey: "quality" }] })),
    ).toThrow(/exactly one/i);

    expect(() =>
      parseScorecardUpdate(
        body({
          photos: [
            {
              scorecardPhotoId: EXISTING_PHOTO,
              clientUploadId: "new-upload-1",
              sectionKey: "quality",
            },
          ],
        }),
      ),
    ).toThrow(/exactly one/i);
  });

  it("validates retained scorecard-photo ids as UUIDs without requiring UUID upload ids", () => {
    expect(() =>
      parseScorecardUpdate(
        body({ photos: [{ scorecardPhotoId: "not-a-uuid", sectionKey: "quality" }] }),
      ),
    ).toThrow(/scorecardPhotoId/i);

    expect(
      parseScorecardUpdate(
        body({ photos: [{ clientUploadId: "durable-client-id", sectionKey: "quality" }] }),
      ).photos[0],
    ).toMatchObject({ clientUploadId: "durable-client-id" });
  });

  it("rejects implicit/coerced point values and the same oversized photo payload as submit", () => {
    const implicitPoints = projectItems();
    implicitPoints[0] = { ...implicitPoints[0], points: null as unknown as number };
    expect(() => parseScorecardUpdate(body({ items: implicitPoints }))).toThrow(/points/i);

    const photos = Array.from({ length: 101 }, (_, index) => ({
      clientUploadId: `upload-${index}`,
      sectionKey: "quality",
    }));
    expect(() => parseScorecardUpdate(body({ photos }))).toThrow(/many evidence photos/i);
  });
});
