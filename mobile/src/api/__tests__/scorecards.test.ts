import { getProjectScorecards, getScorecard, getScorecardDownload, type Fetcher } from "../endpoints";

function recordingFetcher(result: unknown) {
  const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
  const fetcher: Fetcher = (async (path: string, opts: Parameters<Fetcher>[1]) => {
    calls.push({ path, opts });
    return result;
  }) as Fetcher;
  return { calls, fetcher };
}

describe("scorecard endpoints", () => {
  it("getProjectScorecards GETs the per-project scorecards path", async () => {
    const { calls, fetcher } = recordingFetcher({ scorecards: [] });
    await getProjectScorecards(fetcher, "deal-1");
    expect(calls).toEqual([{ path: "/field/projects/deal-1/scorecards", opts: undefined }]);
  });

  it("getScorecard GETs the detail path by id", async () => {
    const { calls, fetcher } = recordingFetcher({ scorecard: {} });
    await getScorecard(fetcher, "sc-9");
    expect(calls).toEqual([{ path: "/field/scorecards/sc-9", opts: undefined }]);
  });

  it("getScorecardDownload GETs the presigned download path and returns { url, expiresAt }", async () => {
    const { calls, fetcher } = recordingFetcher({ url: "https://r2/sc.pdf", expiresAt: "2026-07-06T00:00:00.000Z" });
    const res = await getScorecardDownload(fetcher, "sc-9");
    expect(calls).toEqual([{ path: "/field/scorecards/sc-9/download", opts: undefined }]);
    expect(res).toEqual({ url: "https://r2/sc.pdf", expiresAt: "2026-07-06T00:00:00.000Z" });
  });
});
