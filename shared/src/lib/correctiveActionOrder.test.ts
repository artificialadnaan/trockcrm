import { describe, expect, it } from "vitest";
import { compareCorrectiveActionsByRef, orderCorrectiveActions } from "./correctiveActionOrder.js";

const row = (itemRef: string, itemLabel: string, itemType = "action_item") => ({
  itemRef,
  itemLabel,
  itemType,
});

describe("compareCorrectiveActionsByRef", () => {
  it("sorts DEFICIENCIES before action items, and action refs numerically not lexically", () => {
    const sorted = [
      row("10", "Ten"),
      row("missed_hold_point", "Missed hold point", "critical_deficiency"),
      row("2", "Two"),
      row("1", "One"),
    ].sort(compareCorrectiveActionsByRef);

    // Deficiencies first, because the scorecard body renders "Critical Deficiencies" above "Action Items"
    // and the CRM threads responses under the same two sections in that order. And "10" after "2" — lexical
    // ordering gets that wrong the moment a card has 11+ items.
    expect(sorted.map((r) => r.itemRef)).toEqual(["missed_hold_point", "1", "2", "10"]);
  });
});

describe("orderCorrectiveActions", () => {
  it("REGRESSION: ranks by the CURRENT action-item list, not the preserved item_ref", () => {
    // Reconciliation preserves an action item's original ref across edits (it re-matches on itemLabel) so a
    // reorder cannot orphan an already-settled response. The consequence is that ref order is the OLD order
    // afterwards — so every surface sorting by it contradicts the action-item list printed above it.
    const ordered = orderCorrectiveActions([row("0", "Item A"), row("1", "Item B")], ["Item B", "Item A"]);
    expect(ordered.map((r) => r.itemLabel)).toEqual(["Item B", "Item A"]);
  });

  it("gives duplicate labels distinct positions instead of collapsing them onto the first", () => {
    const ordered = orderCorrectiveActions(
      [row("5", "Fix anchors"), row("3", "Clear the deck"), row("9", "Fix anchors")],
      ["Fix anchors", "Clear the deck", "Fix anchors"],
    );
    // Positions 0 and 2 are consumed in base-ref order, so ref 3 lands between refs 5 and 9.
    expect(ordered.map((r) => r.itemRef)).toEqual(["5", "3", "9"]);
  });

  it("sorts rows the list no longer contains last, keeping their stable ref order", () => {
    const ordered = orderCorrectiveActions(
      [
        row("0", "Removed A"),
        row("1", "Still here"),
        row("2", "Removed B"),
        row("k", "Deficiency", "critical_deficiency"),
      ],
      ["Still here"],
    );
    // The deficiency leads (deficiencies render first), then the ranked action item, then the two whose
    // labels the list no longer contains — in their stable ref order rather than an arbitrary one.
    expect(ordered.map((r) => r.itemRef)).toEqual(["k", "1", "0", "2"]);
  });

  it("falls back to ref order when there is no action-item list", () => {
    // A leadership card, or any caller without a list. Ref order is then the best-known order, not a
    // degenerate one — it must not scramble.
    const ordered = orderCorrectiveActions([row("10", "Ten"), row("2", "Two")], []);
    expect(ordered.map((r) => r.itemRef)).toEqual(["2", "10"]);
  });

  it("matches labels ignoring surrounding whitespace", () => {
    // The PDF builder trims the action-item list before ranking; the stored item_label may not be trimmed.
    const ordered = orderCorrectiveActions([row("0", "  Item A  "), row("1", "Item B")], ["Item B", "Item A"]);
    expect(ordered.map((r) => r.itemRef)).toEqual(["1", "0"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [row("1", "B"), row("0", "A")];
    orderCorrectiveActions(rows, ["A", "B"]);
    expect(rows.map((r) => r.itemRef)).toEqual(["1", "0"]);
  });

  it("REGRESSION: ranks deficiencies by the STORED key order, not lexically", () => {
    // The card body renders deficiencies in the order they are stored in critical_deficiencies. Sorting the
    // corrective actions lexically made a card whose deficiencies were picked out of alphabetical order
    // disagree with its own deficiencies section, one page apart in the same document.
    const ordered = orderCorrectiveActions(
      [
        row("alpha_issue", "Alpha", "critical_deficiency"),
        row("zulu_issue", "Zulu", "critical_deficiency"),
      ],
      [],
      ["zulu_issue", "alpha_issue"],
    );
    expect(ordered.map((r) => r.itemRef)).toEqual(["zulu_issue", "alpha_issue"]);
  });

  it("puts deficiencies ahead of action items even when both are ranked", () => {
    const ordered = orderCorrectiveActions(
      [row("0", "Do the thing"), row("k", "A deficiency", "critical_deficiency")],
      ["Do the thing"],
      ["k"],
    );
    expect(ordered.map((r) => r.itemType)).toEqual(["critical_deficiency", "action_item"]);
  });

  it("falls back to lexical for a deficiency the stored list no longer contains", () => {
    const ordered = orderCorrectiveActions(
      [row("zulu", "Z", "critical_deficiency"), row("alpha", "A", "critical_deficiency")],
      [],
      [],
    );
    expect(ordered.map((r) => r.itemRef)).toEqual(["alpha", "zulu"]);
  });
});
