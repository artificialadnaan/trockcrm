import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDealDisplayName } from "./deal-display-name.js";

// The exact string change-order-service.ts builds, reproduced here so a change to the generator's
// format breaks this test rather than silently disabling the rewrite in production.
const storedChildName = (parent: string, ordinal: number) => `${parent} — Change Order ${ordinal}`;

describe("formatDealDisplayName — the generated change-order suffix", () => {
  it("moves the suffix to the front of the name", () => {
    expect(formatDealDisplayName(storedChildName("Tides Park Lane", 1))).toBe(
      "Change Order 1 — Tides Park Lane"
    );
  });

  it("handles multi-digit ordinals", () => {
    expect(formatDealDisplayName(storedChildName("Tides Park Lane", 12))).toBe(
      "Change Order 12 — Tides Park Lane"
    );
    expect(formatDealDisplayName(storedChildName("Tides Park Lane", 107))).toBe(
      "Change Order 107 — Tides Park Lane"
    );
  });

  it("keeps em-dashes that belong to the parent's own name", () => {
    // change-order-service.ts appends to whatever the parent is called; only the LAST segment is ours.
    expect(formatDealDisplayName(storedChildName("Tides — Phase 2", 3))).toBe(
      "Change Order 3 — Tides — Phase 2"
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(formatDealDisplayName("Tides Park Lane—Change Order 4")).toBe(
      "Change Order 4 — Tides Park Lane"
    );
    expect(formatDealDisplayName("Tides Park Lane   —   Change Order 4   ")).toBe(
      "Change Order 4 — Tides Park Lane"
    );
    expect(formatDealDisplayName("   Tides Park Lane — Change Order 4")).toBe(
      "Change Order 4 — Tides Park Lane"
    );
  });

  it("shows the bare label when the name is ONLY the suffix", () => {
    expect(formatDealDisplayName(" — Change Order 1")).toBe("Change Order 1");
    expect(formatDealDisplayName("— Change Order 9")).toBe("Change Order 9");
  });

  it("survives the varchar(500) truncation branch of the generator", () => {
    // A near-limit parent name is sliced so the suffix still fits; the suffix itself stays intact.
    const suffix = " — Change Order 2";
    const parent = "T".repeat(500 - suffix.length);
    expect(formatDealDisplayName(`${parent}${suffix}`)).toBe(`Change Order 2 — ${parent}`);
  });
});

describe("formatDealDisplayName — idempotency", () => {
  it("does not double-prefix an already-prefixed name", () => {
    const once = formatDealDisplayName(storedChildName("Tides Park Lane", 1));
    expect(formatDealDisplayName(once)).toBe(once);
    expect(formatDealDisplayName(formatDealDisplayName(once))).toBe(once);
  });

  it("leaves a bare label alone", () => {
    expect(formatDealDisplayName("Change Order 1")).toBe("Change Order 1");
    expect(formatDealDisplayName("Change Order 12 — Tides Park Lane")).toBe(
      "Change Order 12 — Tides Park Lane"
    );
  });

  it("does not rotate a (rejected-by-the-server) doubly-suffixed name back and forth", () => {
    // Nesting is blocked server-side, but if such a row ever existed the display must be STABLE.
    const first = formatDealDisplayName("Tides — Change Order 1 — Change Order 2");
    expect(formatDealDisplayName(first)).toBe(first);
  });
});

describe("formatDealDisplayName — names it must leave byte for byte", () => {
  it("leaves an ordinary deal name untouched", () => {
    expect(formatDealDisplayName("Tides Park Lane")).toBe("Tides Park Lane");
    expect(formatDealDisplayName("Tides Park Lane — Phase 2")).toBe("Tides Park Lane — Phase 2");
  });

  it("does not rewrite 'Change Order' appearing mid-string", () => {
    expect(formatDealDisplayName("Change Order Backlog Review")).toBe("Change Order Backlog Review");
    expect(formatDealDisplayName("Tides — Change Order 1 Addendum")).toBe(
      "Tides — Change Order 1 Addendum"
    );
    expect(formatDealDisplayName("Change Order 1 review — Tides")).toBe(
      "Change Order 1 review — Tides"
    );
    expect(formatDealDisplayName("Tides — Change Orders 1")).toBe("Tides — Change Orders 1");
  });

  it("requires the em-dash the generator emits — not a hyphen or an en-dash", () => {
    expect(formatDealDisplayName("Tides Park Lane - Change Order 1")).toBe(
      "Tides Park Lane - Change Order 1"
    );
    expect(formatDealDisplayName("Tides Park Lane – Change Order 1")).toBe(
      "Tides Park Lane – Change Order 1"
    );
  });

  it("requires an ordinal, and the generator's exact casing", () => {
    expect(formatDealDisplayName("Tides Park Lane — Change Order")).toBe(
      "Tides Park Lane — Change Order"
    );
    expect(formatDealDisplayName("Tides Park Lane — change order 1")).toBe(
      "Tides Park Lane — change order 1"
    );
    expect(formatDealDisplayName("Tides Park Lane — Change Order A")).toBe(
      "Tides Park Lane — Change Order A"
    );
  });
});

describe("formatDealDisplayName — empty and nullish", () => {
  it("passes nullish straight through without throwing", () => {
    expect(formatDealDisplayName(null)).toBeNull();
    expect(formatDealDisplayName(undefined)).toBeUndefined();
  });

  it("returns an empty or whitespace-only name exactly as given", () => {
    expect(formatDealDisplayName("")).toBe("");
    expect(formatDealDisplayName("   ")).toBe("   ");
  });
});

// `mobile/` (T-Rock Cam) is a non-workspace Expo app whose Metro bundle cannot resolve @trock-crm/shared,
// so it carries a hand-synced MIRROR of this helper. Nothing in CI compiles or runs `mobile/`, which is
// exactly why the drift guard belongs HERE, in a suite the pre-merge gate actually executes: if the two
// matching rules stop agreeing, the change order that reads correctly on the web reads wrong on the phone.
describe("the mobile mirror does not drift", () => {
  const mirror = readFileSync(
    new URL("../../../mobile/src/projects/field-projects.ts", import.meta.url),
    "utf8"
  );
  const canonical = readFileSync(new URL("./deal-display-name.ts", import.meta.url), "utf8");

  // Both regex literals, lifted from each file by name. Comparing the SOURCE (not behaviour) is the point:
  // a mirror can only be verified against the original by looking at what it actually says.
  const patternOf = (source: string, name: string) => {
    const match = new RegExp(`^const ${name} = (/.+/);$`, "m").exec(source);
    if (!match) throw new Error(`${name} not found — did the constant get renamed?`);
    return match[1];
  };

  it.each(["CHANGE_ORDER_NAME_SUFFIX", "CHANGE_ORDER_NAME_PREFIX"])(
    "%s is byte-identical in shared and in mobile",
    (name) => {
      expect(patternOf(mirror, name)).toBe(patternOf(canonical, name));
    }
  );

  it("both files agree on the em-dash separator the generator emits", () => {
    expect(mirror).toContain('const EM_DASH = "—";');
    expect(canonical).toContain('const EM_DASH = "—";');
  });
});
