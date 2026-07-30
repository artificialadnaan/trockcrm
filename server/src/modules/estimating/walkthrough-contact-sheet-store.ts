// The PRODUCTION wiring of `WalkthroughContactSheetStore` — the one place that names which real
// functions implement the port `ingestWalkthrough` verifies its contact sheet through.
//
// WHY IT IS ITS OWN FILE. `walkthrough-ingress-service.ts` is a pure-database module and says so
// repeatedly: `getCrmFileBucket` reads `R2_BUCKET_NAME` from the environment rather than importing
// `r2-client`, and the size ceiling comes from `file-constants.ts` (the dependency-free half of the files
// module) for the same reason. R23 and R25 gave that module a need for object I/O; putting the imports
// here keeps the need satisfied without putting the S3 client on the ingress module's import path, and
// keeps the port's implementation reviewable in one small place instead of inline in a route handler.
//
// Each function is the SAME one `confirmUpload` uses (files/service.ts:773-804), which is the point: the
// walkthrough seam is a parallel file-creation path, and every invariant it re-implements instead of
// reusing is a future divergence. See the parity audit on `WalkthroughContactSheetStore`.
import { generateAndStoreThumbnail } from "../../lib/image-thumbnail.js";
import { generateAndStorePdfThumbnail } from "../../lib/pdf-thumbnail.js";
import { headObjectStrict, isR2Configured } from "../../lib/r2-client.js";
import type { WalkthroughContactSheetStore } from "./walkthrough-ingress-service.js";

/**
 * The real store. A function rather than a frozen object literal so `isR2Configured()` is evaluated per
 * request — it reads `process.env`, and a module-level snapshot would bake in whatever the environment
 * looked like at import time.
 */
export function createWalkthroughContactSheetStore(): WalkthroughContactSheetStore {
  return {
    isConfigured: () => isR2Configured(),
    /**
     * R33. `headObjectStrict`, NOT `headObject`, and the difference is a wrong answer to the sender.
     *
     * `headObject` (r2-client.ts:210-220) is `try { headObjectStrict } catch { return null }` — it says so
     * itself, "backward-compatible best-effort". So EVERY failure became `null`: a 403 from a rotated
     * credential, a socket timeout, a DNS blip, R2 being down. The ingress reads `null` as "the object is
     * not there" and answers with a NON-RETRYABLE 400 that tells trock-scope its upload failed and it
     * should not try again — when the truth is that we could not check. A correct integration acts on that
     * by abandoning a perfectly good upload.
     *
     * `headObjectStrict` (r2-client.ts:231) returns null ONLY for a genuine not-found
     * (`isR2ObjectNotFoundError`) and rethrows everything else, which is exactly the distinction the
     * ingress needs: null becomes the 400 naming the derived key, a throw becomes a retryable 503. The
     * port's contract is written down on `WalkthroughContactSheetStore.head` so a future implementation
     * cannot quietly go back to swallowing.
     */
    head: (r2Key) => headObjectStrict(r2Key),
    generateImageThumbnail: (r2Key, mimeType) => generateAndStoreThumbnail(r2Key, mimeType),
    generatePdfThumbnail: (r2Key, mimeType) => generateAndStorePdfThumbnail(r2Key, mimeType),
  };
}
