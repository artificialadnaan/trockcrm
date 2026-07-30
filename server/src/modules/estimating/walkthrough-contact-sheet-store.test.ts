// R33. The PRODUCTION wiring of the contact-sheet port, tested at the layer the finding lives in.
//
// WHY THIS FILE EXISTS AT ALL. The ingress suite drives `ingestWalkthrough` through an INJECTED fake
// store, which is what makes the seam's ~70 ingest tests cheap — but it also means reverting
// `walkthrough-contact-sheet-store.ts` to the swallowing `headObject` cannot fail any of them: the fake
// is substituted for exactly the code the mutation would change. Those tests pin what the INGRESS does
// with a throw (a retryable 503) and with a null (a 400 naming the key); this file pins that the real
// store PRODUCES a throw rather than a null for a storage failure. Neither half is sufficient alone.
//
// THE FINDING. `headObject` (r2-client.ts:210-220) is `try { return await headObjectStrict(...) } catch
// { return null }`, and calls itself "backward-compatible best-effort" in its own comment. So a 403 from a
// rotated credential, a socket timeout, a DNS blip or R2 being down all came back as `null`, and ingress
// read that as "the object is not there" and answered with a NON-RETRYABLE 400 telling trock-scope its
// pre-upload had failed. That is a wrong answer, not a vague one: a correct integration acts on it by
// abandoning a perfectly good upload. `headObjectStrict` (r2-client.ts:231) returns null only for a
// genuine not-found (`isR2ObjectNotFoundError`) and rethrows everything else.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the `vi.mock` factories below (which are hoisted above the imports) can close over them.
const r2 = vi.hoisted(() => ({
  headObject: vi.fn(),
  headObjectStrict: vi.fn(),
  isR2Configured: vi.fn(() => true),
}));

// r2-client is mocked because this file is about WHICH of its two HEADs the store calls. The two
// thumbnail modules are mocked only to keep sharp/heic-convert and a second copy of the r2-client import
// off this suite's graph — nothing here exercises them.
vi.mock("../../lib/r2-client.js", () => r2);
vi.mock("../../lib/image-thumbnail.js", () => ({ generateAndStoreThumbnail: vi.fn() }));
vi.mock("../../lib/pdf-thumbnail.js", () => ({ generateAndStorePdfThumbnail: vi.fn() }));

const { createWalkthroughContactSheetStore } = await import("./walkthrough-contact-sheet-store.js");

describe("createWalkthroughContactSheetStore.head", () => {
  beforeEach(() => {
    r2.headObject.mockReset();
    r2.headObjectStrict.mockReset();
  });

  it("propagates a storage failure instead of reporting the object as absent", async () => {
    const outage = Object.assign(new Error("connect ETIMEDOUT"), {
      $metadata: { httpStatusCode: 500 },
    });
    r2.headObjectStrict.mockRejectedValue(outage);
    // What the swallowing variant answers for the very same condition. Asserting the store does NOT
    // produce this is the whole point: with `headObject` wired back in, the expectation below sees a
    // resolved `null` instead of a rejection and the test fails.
    r2.headObject.mockResolvedValue(null);

    const store = createWalkthroughContactSheetStore();

    await expect(store.head("walkthroughs/deal/project/wt/contact-sheet.jpg")).rejects.toBe(outage);
    // ...and it got there by not calling the swallowing one at all, which names the mutation directly
    // rather than only its effect.
    expect(r2.headObject).not.toHaveBeenCalled();
    expect(r2.headObjectStrict).toHaveBeenCalledWith(
      "walkthroughs/deal/project/wt/contact-sheet.jpg"
    );
  });

  // THE OTHER ARM, so the pair proves a DISTINCTION rather than one behaviour. Without it, "storage
  // failures throw" could be satisfied by a store that threw for every HEAD — which would turn a missing
  // pre-upload (the sender's problem, a 400 it can act on) into an unactionable 503 it would retry
  // forever.
  it("still reports a genuinely absent object as null", async () => {
    // `headObjectStrict` resolves null for exactly one condition: `isR2ObjectNotFoundError`.
    r2.headObjectStrict.mockResolvedValue(null);

    const store = createWalkthroughContactSheetStore();

    await expect(store.head("walkthroughs/deal/project/wt/contact-sheet.jpg")).resolves.toBeNull();
  });

  it("passes the object's headers through unchanged when it is there", async () => {
    r2.headObjectStrict.mockResolvedValue({ contentType: "image/jpeg", contentLength: 184320 });

    const store = createWalkthroughContactSheetStore();

    await expect(store.head("walkthroughs/deal/project/wt/contact-sheet.jpg")).resolves.toEqual({
      contentType: "image/jpeg",
      contentLength: 184320,
    });
  });

  // `isConfigured` is a function rather than a snapshot because `isR2Configured()` reads process.env, and
  // a module-level evaluation would bake in whatever the environment looked like at import time. Pinned
  // so that stays true.
  it("evaluates isConfigured per call rather than snapshotting it", () => {
    const store = createWalkthroughContactSheetStore();

    r2.isR2Configured.mockReturnValue(true);
    expect(store.isConfigured()).toBe(true);
    r2.isR2Configured.mockReturnValue(false);
    expect(store.isConfigured()).toBe(false);
  });
});
