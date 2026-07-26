import { discardScorecardEditEvidence, updateScorecard, type Fetcher } from "../endpoints";
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
      superintendentResponderId: null,
      pmResponderId: null,
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

describe("discardScorecardEditEvidence", () => {
  it("POSTs the durable attempted-id ledger to the scorecard-scoped cleanup path", async () => {
    const fetcher = jest.fn(async () => ({ discarded: 2 })) as unknown as Fetcher;
    await expect(discardScorecardEditEvidence(fetcher, "scorecard-9", ["cu-1", "cu-2"]))
      .resolves.toEqual({ discarded: 2 });
    expect(fetcher).toHaveBeenCalledWith(
      "/field/scorecards/scorecard-9/discard-edit-evidence",
      { method: "POST", body: { clientUploadIds: ["cu-1", "cu-2"] } },
    );
  });

  it("chunks ledgers larger than 100 and only resolves after every cleanup request succeeds", async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `cu-${index + 1}`);
    const fetchMock = jest.fn(async (_path: string, opts?: { body?: { clientUploadIds?: string[] } }) => ({
      discarded: opts?.body?.clientUploadIds?.length ?? 0,
    }));
    const fetcher = fetchMock as unknown as Fetcher;

    await expect(discardScorecardEditEvidence(fetcher, "scorecard-9", ids))
      .resolves.toEqual({ discarded: 205 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[1]?.body?.clientUploadIds?.length)).toEqual([100, 100, 5]);
    expect(fetchMock.mock.calls[1]?.[1]?.body?.clientUploadIds?.[0]).toBe("cu-101");
  });

  it("stops on a failed cleanup chunk so the caller retains the draft for retry", async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `cu-${index + 1}`);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ discarded: 100 })
      .mockRejectedValueOnce(new Error("offline"));

    await expect(discardScorecardEditEvidence(fetchMock as unknown as Fetcher, "scorecard-9", ids))
      .rejects.toThrow("offline");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
