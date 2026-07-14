import { updateScorecard, type Fetcher } from "../endpoints";
import type { ScorecardUpdatePayload } from "../../scorecards/draft";

describe("updateScorecard", () => {
  it("PUTs the full replacement body to the submitted scorecard path", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = (async (path: string, opts: Parameters<Fetcher>[1]) => {
      calls.push({ path, opts });
      return { scorecard: { id: "scorecard-9" } };
    }) as Fetcher;
    const body: ScorecardUpdatePayload = {
      expectedUpdatedAt: "2026-07-14T12:34:56.000Z",
      superintendentName: "Sam Superintendent",
      pmName: "Pat Manager",
      items: [
        { sectionKey: "planning_precon", points: 8, note: null },
        { sectionKey: "jobsite_5s", points: 8, note: null },
        { sectionKey: "safety", points: 8, note: null },
        { sectionKey: "schedule", points: 8, note: null },
        { sectionKey: "subcontractor", points: 8, note: null },
        { sectionKey: "quality", points: 8, note: null },
        { sectionKey: "communication", points: 8, note: null },
        { sectionKey: "financial", points: 8, note: null },
      ],
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      actionItems: [],
      photos: [
        {
          scorecardPhotoId: "photo-link-1",
          sectionKey: "quality",
          deficiencyKey: null,
        },
        {
          clientUploadId: "new-upload-1",
          sectionKey: "safety",
          deficiencyKey: null,
        },
      ],
      superintendentSignature: "data:image/png;base64,super",
      pmSignature: "data:image/png;base64,pm",
      summary: null,
    };

    const result = await updateScorecard(fetcher, "scorecard-9", body);

    expect(calls).toEqual([
      {
        path: "/field/scorecards/scorecard-9",
        opts: { method: "PUT", body },
      },
    ]);
    expect(result).toEqual({ scorecard: { id: "scorecard-9" } });
  });
});
