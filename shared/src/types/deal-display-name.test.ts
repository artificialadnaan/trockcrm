import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDealDisplayName } from "./deal-display-name.js";

// The exact string change-order-service.ts builds, reproduced here so a change to the generator's
// format breaks this test rather than silently disabling the rewrite in production.
const storedChildName = (parent: string, ordinal: number) => `${parent} — Change Order ${ordinal}`;

// A near-limit parent name is sliced by the generator so the suffix still fits in deals.name's
// varchar(500); the suffix itself stays intact, so the rewrite must still fire.
const TRUNCATED_PARENT = "T".repeat(500 - " — Change Order 2".length);

/**
 * THE contract, as one table. Every case lives here rather than being scattered across `it` blocks so
 * that the idempotency property below is proven against ALL of them — not against a hand-picked few.
 * That property is load-bearing: it is what replaced an earlier "does this name already look formatted?"
 * prefix guard, which silently did nothing for a parent a human had named "Change Order 7 — Lobby".
 */
const CASES: Array<[label: string, input: string, expected: string]> = [
  // --- the generated suffix moves to the front -------------------------------------------------
  ["the ordinary child", storedChildName("Tides Park Lane", 1), "Change Order 1 — Tides Park Lane"],
  ["a multi-digit ordinal", storedChildName("Tides Park Lane", 12), "Change Order 12 — Tides Park Lane"],
  ["a three-digit ordinal", storedChildName("Tides Park Lane", 107), "Change Order 107 — Tides Park Lane"],
  ["an em-dash inside the PARENT's own name", storedChildName("Tides — Phase 2", 3), "Change Order 3 — Tides — Phase 2"],
  ["the generator's varchar(500) truncation branch", storedChildName(TRUNCATED_PARENT, 2), `Change Order 2 — ${TRUNCATED_PARENT}`],
  ["no spaces around the em-dash", "Tides Park Lane—Change Order 4", "Change Order 4 — Tides Park Lane"],
  ["extra whitespace everywhere", "Tides Park Lane   —   Change Order 4   ", "Change Order 4 — Tides Park Lane"],
  ["leading whitespace on the stored name", "   Tides Park Lane — Change Order 4", "Change Order 4 — Tides Park Lane"],
  ["a name that is ONLY the suffix", " — Change Order 1", "Change Order 1"],
  ["a name that is only the suffix, unpadded", "— Change Order 9", "Change Order 9"],

  // --- REGRESSION: a parent whose OWN name is prefix-shaped -------------------------------------
  // The child of a deal a human named "Change Order 7 — Lobby" is stored with BOTH parts. An
  // "already looks formatted?" prefix test fires on this and returns it unchanged, stranding the
  // child's real "Change Order 1" at the end — the exact truncation this helper exists to prevent.
  ["a prefix-shaped PARENT with a generated child suffix", "Change Order 7 — Lobby — Change Order 1", "Change Order 1 — Change Order 7 — Lobby"],
  ["two stacked generated suffixes", "A — Change Order 1 — Change Order 2", "Change Order 2 — Change Order 1 — A"],

  // --- already in display form: nothing left at the END to move --------------------------------
  ["this function's own output", "Change Order 1 — Tides Park Lane", "Change Order 1 — Tides Park Lane"],
  ["its own output, multi-digit", "Change Order 12 — Tides Park Lane", "Change Order 12 — Tides Park Lane"],
  ["a human-typed prefix-shaped name", "Change Order 5 — Lobby", "Change Order 5 — Lobby"],
  ["a bare label", "Change Order 1", "Change Order 1"],

  // --- left byte for byte ----------------------------------------------------------------------
  ["an ordinary deal name", "Tides Park Lane", "Tides Park Lane"],
  ["an ordinary name with an em-dash", "Tides Park Lane — Phase 2", "Tides Park Lane — Phase 2"],
  ["'Change Order' at the START of a longer phrase", "Change Order Backlog Review", "Change Order Backlog Review"],
  ["'Change Order N' mid-string, trailing text after it", "Tides — Change Order 1 Addendum", "Tides — Change Order 1 Addendum"],
  ["'Change Order N' mid-string, as a prefix phrase", "Change Order 1 review — Tides", "Change Order 1 review — Tides"],
  ["the plural, which the generator never writes", "Tides — Change Orders 1", "Tides — Change Orders 1"],
  ["a HYPHEN separator — a name someone typed", "Suite 200 - Change Order 3", "Suite 200 - Change Order 3"],
  ["an EN-dash separator", "Tides Park Lane – Change Order 1", "Tides Park Lane – Change Order 1"],
  ["no ordinal", "Tides Park Lane — Change Order", "Tides Park Lane — Change Order"],
  ["the wrong casing", "Tides Park Lane — change order 1", "Tides Park Lane — change order 1"],
  ["a non-numeric ordinal", "Tides Park Lane — Change Order A", "Tides Park Lane — Change Order A"],
  // nextChildOrdinal() is `COUNT(*)::int + 1`, so it can only ever emit a positive, unpadded decimal.
  // A zero or a zero-padded ordinal is therefore something a human typed.
  ["a ZERO ordinal, which the generator can never emit", "Tides Park Lane — Change Order 0", "Tides Park Lane — Change Order 0"],
  ["a ZERO-PADDED ordinal", "Tides Park Lane — Change Order 01", "Tides Park Lane — Change Order 01"],
  ["an empty name", "", ""],
  ["a whitespace-only name", "   ", "   "],

  // --- DEGENERATE: a rejoin that would re-create a trailing suffix is refused ------------------
  // Both of these peel to a candidate that itself ends in a generated suffix, so formatting them would
  // oscillate forever between two spellings. They are returned exactly as stored instead.
  ["an empty base under two stacked labels", " — Change Order 1 — Change Order 2", " — Change Order 1 — Change Order 2"],
  ["a base that is itself a bare label", "Change Order 1 — Change Order 2", "Change Order 1 — Change Order 2"],
  ["a base that is itself a bare label, equal ordinals", "Change Order 1 — Change Order 1", "Change Order 1 — Change Order 1"],
];

describe("formatDealDisplayName", () => {
  it.each(CASES)("%s", (_label, input, expected) => {
    expect(formatDealDisplayName(input)).toBe(expected);
  });
});

/**
 * THE post-condition: a formatted name never ends in a generated suffix.
 *
 * This is the invariant idempotency rests on — if it holds, a second pass has nothing to peel — so it is
 * asserted directly rather than inferred from a handful of before/after pairs. The regex is duplicated
 * here on purpose: a test that imported the implementation's own constant would keep passing if that
 * constant were loosened.
 */
const GENERATED_SUFFIX = /\s*—\s*Change Order\s+[1-9]\d*\s*$/;

const expectSettled = (input: string) => {
  const once = formatDealDisplayName(input);
  // Either the rewrite happened and its output is suffix-free, or it declined and handed back the input.
  if (once !== input) expect(GENERATED_SUFFIX.test(once)).toBe(false);
  expect(formatDealDisplayName(once)).toBe(once);
};

describe("formatDealDisplayName settles — post-condition + idempotency", () => {
  it.each(CASES)("%s", (_label, input) => {
    expectSettled(input);
  });

  /**
   * Hand-picked rows are what let the last oscillation through: the table simply did not contain the
   * shape that broke it. So generate the shapes instead of choosing them — every combination of a base
   * (including the empty and label-shaped ones that caused it), a stack depth, and surrounding padding.
   */
  const BASES = [
    "",
    "   ",
    "Tides",
    "Tides — Phase 2",
    "Change Order 1", // label-shaped: rejoining onto this re-creates a suffix
    "Change Order 7 — Lobby",
    "Suite 200 - Change Order 3", // hyphen: never ours
  ];
  const PADDING: Array<[string, string]> = [["", ""], ["   ", ""], ["", "   "], ["  ", "  "]];

  const GENERATED: string[] = [];
  for (const base of BASES) {
    for (let depth = 0; depth <= 3; depth += 1) {
      let composed = base;
      for (let n = 1; n <= depth; n += 1) composed += ` — Change Order ${n}`;
      for (const [lead, trail] of PADDING) GENERATED.push(`${lead}${composed}${trail}`);
    }
  }

  it(`holds for all ${GENERATED.length} composed names`, () => {
    // One `it` rather than `it.each` so a failure reports the offending inputs together — the useful
    // signal is WHICH shape family broke, not one arbitrary member of it.
    const violations = GENERATED.filter((input) => {
      const once = formatDealDisplayName(input);
      const reformatted = formatDealDisplayName(once);
      return (once !== input && GENERATED_SUFFIX.test(once)) || reformatted !== once;
    });
    expect(violations).toEqual([]);
  });

  it("reaches a fixed point in ONE application, and stays there", () => {
    for (const input of GENERATED) {
      const once = formatDealDisplayName(input);
      let value = input;
      for (let i = 0; i < 6; i += 1) value = formatDealDisplayName(value);
      expect(value).toBe(once);
    }
  });
});

describe("formatDealDisplayName — nullish", () => {
  it("passes nullish straight through without throwing", () => {
    expect(formatDealDisplayName(null)).toBeNull();
    expect(formatDealDisplayName(undefined)).toBeUndefined();
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

  const IMPLEMENTATION_SIGNATURE =
    "export function formatDealDisplayName(name: string | null | undefined): string | null | undefined {";

  // Compare the SOURCE, not the behaviour: a mirror can only be verified against the original by looking
  // at what it actually says. Comments and indentation may differ (each file explains itself to its own
  // readers); every line of LOGIC must be identical.
  const implementationOf = (source: string) => {
    const start = source.indexOf(IMPLEMENTATION_SIGNATURE);
    if (start === -1) throw new Error("implementation signature not found — was it renamed?");
    const end = source.indexOf("\n}", start);
    if (end === -1) throw new Error("implementation end not found");
    return source
      .slice(start, end)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"))
      .join("\n");
  };

  it("implements the rewrite with identical logic in shared and in mobile", () => {
    expect(implementationOf(mirror)).toBe(implementationOf(canonical));
  });

  it("matches the generated suffix with a byte-identical pattern", () => {
    const patternOf = (source: string) => {
      const match = /^const CHANGE_ORDER_NAME_SUFFIX = (\/.+\/);$/m.exec(source);
      if (!match) throw new Error("CHANGE_ORDER_NAME_SUFFIX not found — did the constant get renamed?");
      return match[1];
    };
    expect(patternOf(mirror)).toBe(patternOf(canonical));
  });

  it("both files agree on the em-dash separator the generator emits", () => {
    expect(mirror).toContain('const EM_DASH = "—";');
    expect(canonical).toContain('const EM_DASH = "—";');
  });

  it("neither file reintroduces a prefix short-circuit", () => {
    // The bug this replaced: an early return on a name that merely LOOKED already-formatted skipped the
    // rewrite entirely for a parent a human had named "Change Order 7 — Lobby".
    expect(canonical).not.toContain("CHANGE_ORDER_NAME_PREFIX");
    expect(mirror).not.toContain("CHANGE_ORDER_NAME_PREFIX");
  });
});
