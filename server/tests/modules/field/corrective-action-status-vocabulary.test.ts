import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORRECTIVE_ACTION_ITEM_STATUSES } from "@trock-crm/shared/types";

/**
 * A tree-wide invariant on the corrective-action item vocabulary.
 *
 * Migration 0202 renamed the item status `resolved` to `submitted` and added `approved` / `rejected`. That
 * value is consumed by SIX surfaces across five packages — the server, the worker's two email jobs, the CRM
 * deal tab, the tokenized web responder page, and the mobile app (which has TWO source roots). The rename
 * was swept surface by surface from memory, and review found consumers in every one of them that had been
 * missed: each failed SILENTLY, because a comparison against a string that no longer occurs simply never
 * matches. Emails rendered every item as "Open", counters read zero, and a rejected item was read-only on
 * the phone.
 *
 * Nothing about "I updated the places I could think of" is checkable. This is, so the next person renaming a
 * status gets a failing test naming every file instead of a silent behaviour change in six places.
 *
 * Deliberately a LITERAL scan rather than an AST parse: the risk here is a forgotten string, and a string is
 * exactly what a literal scan is good at. (Where the risk is a forgotten CALL SITE, parse — see the mobile
 * sweep note in #958.)
 */

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

/** The value 0202 removed. Any surviving occurrence in corrective-action code is a missed rename. */
const REMOVED_ITEM_STATUS = "resolved";

/** Source roots that can hold a corrective-action consumer. mobile has TWO — app/ and src/ — and a sweep
 *  that checks only one is how a rename reaches production half-applied. */
const SOURCE_ROOTS = [
  "server/src",
  "worker/src",
  "client/src",
  "client-field/src",
  "shared/src",
  "mobile/src",
  "mobile/app",
  "mobile-crm/src",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a root that does not exist in this checkout is not a failure
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".expo") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Files that actually deal with corrective actions — the only ones this vocabulary binds. */
function correctiveActionFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)))
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file) && !/__tests__/.test(file))
    .filter((file) => /corrective[-_]?action/i.test(readFileSync(file, "utf8")));
}

describe("corrective-action item status vocabulary", () => {
  it("no corrective-action source compares against the REMOVED `resolved` status", () => {
    const offenders: string[] = [];

    for (const file of correctiveActionFiles()) {
      const source = readFileSync(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // Only string-literal uses of the bare value. `resolvedAt`, `resolvedCount`, resolvePhotoUrl and the
        // unrelated `resolved` statuses on AI-intervention cases and SyncHub orphans are different domains.
        if (!/["']resolved["']/.test(line)) continue;
        // A comment explaining the rename is not a consumer of it.
        if (/^\s*(\/\/|\*|--)/.test(line)) continue;
        offenders.push(`${file.replace(REPO_ROOT, "")}:${index + 1}: ${line.trim()}`);
      }
    }

    expect(offenders, `corrective-action code still reads the removed status:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("the shared status set is the four post-0202 values", () => {
    // Pins what the scan above is scanning FOR. If a fifth state is added, this fails and whoever adds it
    // has to decide, explicitly, whether it is outstanding.
    expect([...CORRECTIVE_ACTION_ITEM_STATUSES]).toEqual(["open", "submitted", "approved", "rejected"]);
    expect(CORRECTIVE_ACTION_ITEM_STATUSES).not.toContain(REMOVED_ITEM_STATUS);
  });
});
