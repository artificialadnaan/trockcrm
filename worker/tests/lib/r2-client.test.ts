import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getObjectRangeBuffer` is the ONLY data-plane read in this repo whose result is written straight back
// out over the network without ever being inspected: glasses-walkthrough-forward.ts PUTs it at a
// presigned TROCK Scope part URL. That makes "returned fewer bytes than asked for" indistinguishable
// from success at every layer above it — a presigned part PUT accepts zero bytes, answers 200, and hands
// back an ETag — so the guarantee has to live here, in the function that knows what was requested.
//
// These cases pin the three ways it can under-deliver: no credentials, no response body, and a short
// read. All three used to resolve to `Buffer.alloc(0)` or a truncated buffer.

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

/** A distinctive stand-in for the real R2 secret, so the "never in the error text" assertions below match
 *  on something that could only have come from the credential rather than on an incidental substring. */
const FAKE_SECRET = "not-a-real-r2-secret-4b7e";
const KEY = "office_dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-1.mp4";

/** R2 hands the SDK an async-iterable stream, not a Buffer — mirror that so the concat path under test is
 *  the real one rather than a shortcut. */
function bodyOf(...chunks: Uint8Array[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function configureR2() {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = FAKE_SECRET;
}

function unconfigureR2() {
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
}

describe("worker r2-client getObjectRangeBuffer", () => {
  beforeEach(() => {
    sendMock.mockReset();
    // The module memoizes its S3Client in a module-level `_client`, so a per-test env change is only
    // observed after the module cache is dropped.
    vi.resetModules();
    unconfigureR2();
  });
  afterEach(() => {
    unconfigureR2();
  });

  it("throws instead of returning zero bytes when R2 is not configured", async () => {
    const { getObjectRangeBuffer } = await import("../../src/lib/r2-client.js");

    // The empty buffer this used to return is the whole defect: a single-part clip forwarded as zero
    // bytes reaches TROCK Scope as a filed-looking recording that transcribes to an empty scope, and the
    // job reports success, so nothing retries and nothing alerts.
    await expect(getObjectRangeBuffer(KEY, 0, 1023)).rejects.toThrow(/not configured/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("names the missing env vars but never their values", async () => {
    // This message lands in job_queue.last_error and in the dead-letter alert email, both of which a
    // human reads. Naming a var is what makes it actionable; naming a value would leak a credential.
    const { getObjectRangeBuffer } = await import("../../src/lib/r2-client.js");
    process.env.R2_SECRET_ACCESS_KEY = FAKE_SECRET; // one of three set ⇒ still unconfigured

    const err = await getObjectRangeBuffer(KEY, 0, 1023).catch((e: Error) => e);
    expect((err as Error).message).toContain("R2_ACCESS_KEY_ID");
    expect((err as Error).message).not.toContain(FAKE_SECRET);
  });

  it("throws when R2 answers with no body at all", async () => {
    configureR2();
    sendMock.mockResolvedValue({});
    const { getObjectRangeBuffer } = await import("../../src/lib/r2-client.js");

    await expect(getObjectRangeBuffer(KEY, 0, 9)).rejects.toThrow(/no body/i);
  });

  it("throws when the range comes back SHORT of the bytes it asked for", async () => {
    // Not a hypothetical: R2 clamps a range to the object's real end, so a `files` row overstating
    // fileSizeBytes yields a short part. S3 multipart accepts an undersized FINAL part, which means this
    // one completes "successfully" as a silently truncated recording rather than failing.
    configureR2();
    sendMock.mockResolvedValue({ Body: bodyOf(new Uint8Array(4)) });
    const { getObjectRangeBuffer } = await import("../../src/lib/r2-client.js");

    await expect(getObjectRangeBuffer(KEY, 0, 9)).rejects.toThrow(/4 bytes/);
  });

  it("throws when the range comes back LONGER than the bytes it asked for", async () => {
    // The other direction, and the more dangerous one because nothing about it looks like a failure. S3
    // answers a Range header it cannot PARSE by ignoring it and returning the WHOLE object — so a caller
    // that only checks for a short read hands a multi-GB buffer to a PUT sized for one 32MiB part, and
    // the part that lands is neither the range asked for nor the object. A byte count that is wrong in
    // either direction means the read did not do what was asked.
    configureR2();
    sendMock.mockResolvedValue({ Body: bodyOf(new Uint8Array(4096)) });
    const { getObjectRangeBuffer } = await import("../../src/lib/r2-client.js");

    await expect(getObjectRangeBuffer(KEY, 0, 9)).rejects.toThrow(/4096 bytes/);
  });

  it("returns the bytes, reassembled across stream chunks, when the range is fully satisfied", async () => {
    // The other half of the contract: strictness must not reject a correct multi-chunk read, which is
    // what every real multi-MiB part looks like coming off the socket.
    configureR2();
    sendMock.mockResolvedValue({
      Body: bodyOf(Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])),
    });
    const { getObjectRangeBuffer } = await import("../../src/lib/r2-client.js");

    await expect(getObjectRangeBuffer(KEY, 10, 14)).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("asks R2 for the inclusive HTTP range it was given", async () => {
    configureR2();
    sendMock.mockResolvedValue({ Body: bodyOf(new Uint8Array(1024)) });
    const { getObjectRangeBuffer, getR2Bucket } = await import("../../src/lib/r2-client.js");

    await getObjectRangeBuffer(KEY, 1024, 2047);
    expect(sendMock.mock.calls[0]![0].input).toEqual({
      Bucket: getR2Bucket(),
      Key: KEY,
      Range: "bytes=1024-2047",
    });
  });

  // `getObjectBuffer` deliberately keeps its lenient `null` return: it is typed `Buffer | null`, so the
  // compiler forces every caller (exif-extract, field-scorecard-email,
  // scorecard-corrective-action-oversight-email) to branch on the miss, and none of them can relay it
  // anywhere. That type is exactly what the ranged read lacked.
  it("leaves getObjectBuffer's null-on-unconfigured contract alone", async () => {
    const { getObjectBuffer } = await import("../../src/lib/r2-client.js");
    await expect(getObjectBuffer(KEY)).resolves.toBeNull();
  });
});
