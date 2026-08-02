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
    // `fileSizeBytes` is passed but NOT signed, and that is deliberate — `generateUploadUrl` takes it as
    // `_maxSizeBytes` and signs only ContentType. Signing an exact `Content-Length` would put it in SigV4's
    // SignedHeaders, so R2 would reject any PUT whose header did not match to the byte, and the mobile
    // uploader cannot satisfy that:
    //   - it sets only `Content-Type` (`FileSystem.uploadAsync`, BINARY_CONTENT — mobile/src/walkthrough/
    //     upload.ts); Content-Length is computed by the platform HTTP stack, which is free to use chunked
    //     transfer encoding instead, and a 2 GiB artifact ceiling makes that likelier, not less.
    //   - worse, the size we would sign is the size the CLIENT declared at presign time, and that value
    //     falls back to 0 when the file stat has no size (`typeof info.size === "number" ? info.size : 0`).
    //     Signing `Content-Length: 0` fails every subsequent byte of a real upload.
    // So it would not harden the boundary, it would break it — and the shared `generateUploadUrl` already
    // carries the same finding for the browser upload paths, which cannot set the header at all.
    //
    // The size IS enforced, one step later and unconditionally: `verifyOneGlassesWalkthroughArtifact` HEADs
    // every object at completion and 400s on a Content-Length mismatch, so an artifact whose real size
    // differs from what was declared is never filed into the project folder and never forwarded to TROCK
    // Scope. What that leaves is bytes transiently sitting in R2 for a walk that was refused — a storage
    // question (bucket lifecycle expiry for unreferenced glasses-walkthrough keys), not an ingress one.
    presignUpload: (r2Key, mimeType, fileSizeBytes) => generateUploadUrl(r2Key, mimeType, fileSizeBytes),
  };
}
