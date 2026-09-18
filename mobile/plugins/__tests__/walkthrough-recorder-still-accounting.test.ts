import { readFileSync } from "fs";
import { join } from "path";

/**
 * A SOURCE guard over `WalkthroughRecorder.swift`, and it is worth being blunt about what that is.
 *
 * Nothing in CI compiles or runs this file. There is no Swift test target, the premerge gate never
 * touches `mobile/plugins/wearables-native/`, and the jest suite cannot load a `.swift`. So two real
 * defects in the still accounting — both found by review, neither catchable by any existing test —
 * could be reintroduced by an ordinary edit and every check in this repository would stay green.
 *
 * This does not prove the recorder BEHAVES correctly. It cannot: it reads text. What it does is make
 * a silent reversion loud, which is the only thing available at this seam short of a device build.
 * The two invariants below are the ones whose violation is invisible until an estimator loses a walk:
 *
 *   1. The in-flight count is released only AFTER the write and the event, not at callback entry.
 *      Released early, `awaitPendingStills` returns while a write is still running, `endWalk`
 *      resolves, the JS reducer goes terminal, and the `walkthrough:still` event that arrives a
 *      moment later is ignored — the JPEG is on disk, absent from the manifest, and deleted by
 *      cleanup. That is the ordinary "Capture, then immediately End" sequence.
 *
 *   2. The keep-or-discard decision reads stills that were WRITTEN, not filenames that were
 *      allocated. Reading the allocation index means a failed write still counts, so a walk whose
 *      storage ran out — failing the still write and the video finalize together — keeps a directory
 *      that nothing can ever open: the recovery scan refuses the unfinalized mp4 and finds no still
 *      beside it, and a multi-gigabyte folder stays on the device permanently. The same decision now
 *      also keeps a directory holding a closed narration.m4a, which is the mirror-image loss: the
 *      recovery scan WOULD offer that walk, and discarding deletes the one recording that survived
 *      the failure the standalone recorder exists for.
 *
 * If this file is ever genuinely restructured, update the guard deliberately — do not delete it
 * because it went red.
 */

const SOURCE = readFileSync(
  join(__dirname, "..", "wearables-native", "WalkthroughRecorder.swift"),
  "utf8",
);

/**
 * The body of a `private func <name>(` up to the next top-level member.
 *
 * The terminator has to cover every member form Swift allows at this indent, not just the two this
 * file happens to use today. An earlier version stopped only at `func`/`var` with an optional
 * `private`, so adding a `static func`, `@objc func`, `fileprivate func` or `private(set) var` after
 * `deliverStill` would have made this absorb it — and the ORDERING assertions below would then be
 * comparing positions across two functions, silently, while still passing.
 */
function swiftFunctionBody(name: string): string {
  const start = SOURCE.indexOf(`private func ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = SOURCE.slice(start);
  const MEMBER_START =
    /\n {2}(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:private|fileprivate|internal|public|open)(?:\(set\))?\s+)*(?:static\s+|class\s+|final\s+)*(?:func|var|let|init|deinit|subscript)[\s(]/;
  const next = rest.slice(1).search(MEMBER_START);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("WalkthroughRecorder.swift still accounting (source guard)", () => {
  it("releases the in-flight slot only after the write, never at callback entry", () => {
    const body = swiftFunctionBody("deliverStill");

    const decrement = body.indexOf("stillsInFlightStorage = max(0, stillsInFlightStorage - 1)");
    const write = body.indexOf("photo.data.write(to: url)");
    expect(decrement).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);

    // The release must be a `defer`, so it also covers the early returns (a nil directory, a failed
    // write) without each of them having to remember. A bare decrement placed after the write would
    // satisfy an ordering check and still leak the slot on those paths.
    expect(body).toMatch(/defer \{[^}]*stillsInFlightStorage = max\(0, stillsInFlightStorage - 1\)/);

    // And nothing may touch the count BEFORE that defer — the allocation block runs ahead of the write,
    // which is exactly where the release used to live. Sliced to the text preceding `defer` rather than
    // to the closure, because the defer statement itself of course mentions the counter.
    const beforeDefer = body.slice(0, body.indexOf("defer {"));
    expect(beforeDefer).toContain("walkStateQueue.sync");
    expect(beforeDefer).not.toContain("stillsInFlightStorage");
  });

  it("counts a still only once its bytes are on disk", () => {
    const body = swiftFunctionBody("deliverStill");
    const write = body.indexOf("photo.data.write(to: url)");
    const counted = body.indexOf("stillsWrittenStorage += 1");

    expect(counted).toBeGreaterThan(write);
    // The allocation index is still incremented before the write — that is correct, it exists to make
    // filenames unique — so this asserts the two are genuinely different counters.
    expect(body).toContain("stillIndexStorage += 1");
    expect(body.indexOf("stillIndexStorage += 1")).toBeLessThan(write);
  });

  it("decides keep-or-discard from stills WRITTEN, not filenames allocated", () => {
    // The single most consequential line in the file. narration.m4a joined the disjunction after
    // review: a finalize failure with no still deleted a narration file that was already closed and
    // recoverable — the exact walk the standalone recorder exists for. Both operands are pinned for
    // the same reason, and both are the ON-DISK answer rather than the intent: `stillsWritten` is
    // JPEGs that landed (not filenames allocated), and `narration?.audioUri` is what
    // `narrationFileUrl()` returns after checking the file's bytes (not "the recorder was started").
    expect(SOURCE).toContain("let stills = stillsWritten");
    expect(SOURCE).not.toContain("let stills = stillIndex");
    expect(SOURCE).toContain("let narrationKept = narration?.audioUri != nil");
    expect(SOURCE).toMatch(
      /teardown\(finalized \|\| stills > 0 \|\| narrationKept \? \.keep : \.discard\)/,
    );
  });

  it("resets both counters when a walk claims the recorder", () => {
    // A leftover count from a previous walk decides THIS walk's keep-or-discard, so the new counter
    // has to be reset everywhere the old ones are.
    const claim = SOURCE.slice(SOURCE.indexOf("guard !walkActive else { return false }"));
    expect(claim.slice(0, 400)).toContain("stillIndexStorage = 0");
    expect(claim.slice(0, 400)).toContain("stillsWrittenStorage = 0");
    expect(claim.slice(0, 400)).toContain("stillsInFlightStorage = 0");
  });
});
