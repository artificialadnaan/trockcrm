/**
 * The concrete `WalkthroughUploadClient` — the ONE thing upload.ts's "SERVER CONTRACT SEAM" comment
 * says needs to exist for the queue to go live. Thin on purpose: both methods just forward to the
 * matching ../api/endpoints.ts functions, which are what actually knows the URL shape (`/deals/:id/...`,
 * dealId on the path, never the body) and go through the same `Fetcher` (apiFetch-bound) every other
 * call in this app uses — no second fetch pattern, no second auth story.
 */
import { requestGlassesWalkthroughArtifactUploadUrl, submitGlassesWalkthrough } from "../api/endpoints";
import type { WalkthroughUploadClient } from "./upload";

export const walkthroughUploadClient: WalkthroughUploadClient = {
  requestUploadUrl: (f, dealId, req) => requestGlassesWalkthroughArtifactUploadUrl(f, dealId, req),
  completeWalk: (f, dealId, req) => submitGlassesWalkthrough(f, dealId, req),
};
