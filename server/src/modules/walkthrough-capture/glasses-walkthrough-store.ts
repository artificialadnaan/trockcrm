// The PRODUCTION wiring of `GlassesWalkthroughArtifactStore` — the object-storage port
// `glasses-walkthrough-service.ts` verifies pre-uploaded artifacts through and presigns uploads via.
//
// Mirrors `walkthrough-contact-sheet-store.ts` (the estimating module's equivalent seam for the
// RETURN path): the service module stays a pure-database module and does not import the S3 client
// directly, so tests can inject a fake store instead of standing up real R2. See that file for the
// fuller rationale — this is the same pattern, one door earlier in the pipeline (INBOUND from the
// mobile app rather than inbound from TROCK Scope).
import { generateUploadUrl, headObjectStrict, isR2Configured } from "../../lib/r2-client.js";
import type { GlassesWalkthroughArtifactStore } from "./glasses-walkthrough-service.js";

/**
 * A function rather than a frozen object literal so `isR2Configured()` is evaluated per request — it
 * reads `process.env`, and a module-level snapshot would bake in whatever the environment looked like
 * at import time.
 */
export function createGlassesWalkthroughArtifactStore(): GlassesWalkthroughArtifactStore {
  return {
    isConfigured: () => isR2Configured(),
    // `headObjectStrict`, not `headObject` — same R33 reasoning as the contact-sheet store: a genuine
    // 404 (null) means the sender's pre-upload never landed (a 400 the sender must fix), while a THROW
    // (network blip, expired credential, R2 outage) means we could not check and must not report that
    // as "not found" — the ingress maps a throw to a retryable 503 instead.
    head: (r2Key) => headObjectStrict(r2Key),
    presignUpload: (r2Key, mimeType, fileSizeBytes) => generateUploadUrl(r2Key, mimeType, fileSizeBytes),
  };
}
