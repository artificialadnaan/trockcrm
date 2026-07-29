import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The mobile rework form must come back EMPTY and ENABLED.
 *
 * The corrective-action screen renders its read-only resolved view as an early return from the same
 * component under a stable `key`, so the instance survives every status transition. A successful submit
 * deliberately leaves `submitting` true — the screen is going away and clearing it would flash an enabled
 * form — and keeps the reducer's comment and photos. When the approver rejects, the form returns on that
 * same instance: every control renders disabled off the stale `submitting`, `onSubmit` returns at its own
 * guard, and the previous attempt's text and photos are still in the fields. The responder cannot file the
 * rework without backing out and reopening the screen, which is the round trip the in-app rejection notice
 * exists to save.
 *
 * Guarded here, in the server suite, for the same reason the status-vocabulary invariant is: mobile has a
 * jest suite that no CI gate runs, so an assertion placed there would not hold anything. A literal scan is
 * the right shape — the risk is that someone tidies the effect back down to the one line it started as,
 * which reads perfectly reasonable and silently restores a dead form.
 */
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const SCREEN = join(REPO_ROOT, "mobile/app/(app)/scorecards/corrective-action/[id].tsx");

describe("mobile corrective-action screen: reopened-cycle reset", () => {
  it("clears every piece of per-cycle state when the item becomes outstanding again", () => {
    const source = readFileSync(SCREEN, "utf8");
    // The effect that fires on a status change. Anchored on its dependency list so this finds the reset
    // effect specifically rather than any effect in the file.
    const marker = source.indexOf("if (!outstanding) return;");
    expect(marker, "the reopened-cycle reset effect is gone or was renamed").toBeGreaterThan(-1);
    // Keyed on the BOOLEAN. `[item]` — what an exhaustive-deps autofix produces, since the old body read
    // `item` — re-fires on every refetch identity change and would wipe a response mid-typing; `[item.status]`
    // still fires on changes WITHIN the outstanding set. Pinned so neither can creep back.
    const end = source.indexOf("}, [outstanding]);", marker);
    expect(end, "the reset effect no longer keys on the outstanding boolean").toBeGreaterThan(marker);
    const body = source.slice(marker, end);

    // The photo-dir guard — resetting this ALONE was the original bug, and it is still required.
    expect(body).toContain("submittedOk = false");
    // ...the busy flag a successful submit leaves set, which disables every control on return.
    expect(body).toContain("setSubmitting(false)");
    // ...the previous attempt's comment and photos.
    expect(body).toContain('dispatch({ type: "reset" })');
    // ...and the notice from the previous cycle, which would otherwise sit above a blank form.
    expect(body).toContain("setNotice(null)");
  });
});
