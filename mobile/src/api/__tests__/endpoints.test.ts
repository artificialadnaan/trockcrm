import {
  getNearbyCaptureTargets,
  requestGlassesWalkthroughArtifactUploadUrl,
  searchCaptureTargets,
  submitGlassesWalkthrough,
} from "../endpoints";
import type { Fetcher } from "../endpoints";

describe("api endpoints", () => {
  it("requests nearby capture targets with coordinates and a limit", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { targets: [] } as never;
    };

    await getNearbyCaptureTargets(fetcher, { latitude: 32.911, longitude: -96.775, limit: 3 });

    expect(calls).toEqual([{
      path: "/field/photo-targets/nearby",
      opts: { query: { lat: 32.911, lng: -96.775, limit: 3 } },
    }]);
  });

  it("defaults nearby capture target limit to 3 when omitted", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { targets: [] } as never;
    };

    await getNearbyCaptureTargets(fetcher, { latitude: 32.911, longitude: -96.775 });

    expect(calls).toEqual([{
      path: "/field/photo-targets/nearby",
      opts: { query: { lat: 32.911, lng: -96.775, limit: 3 } },
    }]);
  });

  // Both narrowings are SERVER-side and for the same reason: the endpoint caps its answer before the
  // client sees it (per type in one office, and once globally across offices, ordered lead →
  // opportunity → deal), so anything filtered on the phone is filtered out of an already-truncated
  // list. `dealsOnly` alone also applies the field BROWSING rule; the walkthrough recovery picker
  // needs the deals narrowing WITHOUT it, which is what includeTerminalDeals asks for.
  it("asks for every ACTIVE deal — deals-only WITHOUT the browsing stage rule — for the recovery picker", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { targets: [] } as never;
    };

    await searchCaptureTargets(fetcher, "preston", 20, true, true);

    expect(calls).toEqual([{
      path: "/field/photo-targets/search",
      opts: { query: { search: "preston", limit: 20, dealsOnly: "true", includeTerminalDeals: "true" } },
    }]);
  });

  // GUARD: the ordinary pickers must keep asking exactly what they ask today — the scorecard picker's
  // server gate refuses a terminal deal outright, so widening its list would offer a project it 404s.
  it("leaves the scorecard and all-types searches unwidened", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { targets: [] } as never;
    };

    await searchCaptureTargets(fetcher, "preston", 20, true);
    await searchCaptureTargets(fetcher, "preston");

    expect(calls.map((call) => call.opts?.query)).toEqual([
      { search: "preston", limit: 20, dealsOnly: "true" },
      { search: "preston", limit: 20 },
    ]);
  });

  // dealId must land on the URL path (never the request body) — see the route's comment on why: a body
  // field could be forged to presign/file a walk under a deal the caller has no write access to.
  // /field, not /deals: this app authenticates via `/auth/field-login`, whose `surface: "field"` token the
  // server rejects on every CRM route by design. Addressed at /deals these 401'd on every walk, and the
  // app read that as a dead session and signed the user out — one stuck walk locked the crew out entirely.
  it("presigns a glasses-walkthrough artifact upload under the FIELD project path, not the body", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { uploadUrl: "https://r2.test/x", r2Key: "office/deal/walk/video", expiresIn: 900 } as never;
    };

    await requestGlassesWalkthroughArtifactUploadUrl(fetcher, "deal-42", {
      walkId: "walk-1",
      idempotencyKey: "walk-1:video",
      kind: "video",
      mimeType: "video/mp4",
      fileSizeBytes: 1024,
    });

    expect(calls).toEqual([{
      path: "/field/projects/deal-42/glasses-walkthroughs/artifacts/upload-url",
      opts: {
        method: "POST",
        body: {
          walkId: "walk-1",
          idempotencyKey: "walk-1:video",
          kind: "video",
          mimeType: "video/mp4",
          fileSizeBytes: 1024,
        },
      },
    }]);
  });

  it("submits a completed glasses walkthrough under the FIELD project path, not the body", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { walkId: "walk-1", files: [], forwarding: { status: "queued", jobId: "1" } } as never;
    };

    await submitGlassesWalkthrough(fetcher, "deal-42", {
      walkId: "walk-1",
      title: "Post RE Group - Building C — 30 Jul 2026, 9:15 PM",
      siteLabel: "123 Main St",
      projectId: null,
      capturedAt: "2026-07-30T02:15:00.000Z",
      artifacts: [],
    });

    expect(calls).toEqual([{
      path: "/field/projects/deal-42/glasses-walkthroughs",
      opts: {
        method: "POST",
        body: {
          walkId: "walk-1",
          title: "Post RE Group - Building C — 30 Jul 2026, 9:15 PM",
          siteLabel: "123 Main St",
          projectId: null,
          capturedAt: "2026-07-30T02:15:00.000Z",
          artifacts: [],
        },
      },
    }]);
  });
});
