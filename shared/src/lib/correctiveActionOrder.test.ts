import { describe, expect, it } from "vitest";
import { compareCorrectiveActionsByRef, orderCorrectiveActions } from "./correctiveActionOrder.js";

const row = (itemRef: string, itemLabel: string, itemType = "action_item") => ({
  itemRef,
  itemLabel,
  itemType,
});

describe("compareCorrectiveActionsByRef", () => {
  it("sorts action items before deficiencies, and refs numerically not lexically", () => {
    const sorted = [
      row("10", "Ten"),
      row("missed_hold_point", "Missed hold point", "critical_deficiency"),
      row("2", "Two"),
      row("1", "One"),
    ].sort(compareCorrectiveActionsByRef);

    // "10" after "2" — lexical ordering gets this wrong the moment a card has 11+ items.
    expect(sorted.map((r) => r.itemRef)).toEqual(["1", "2", "10", "missed_hold_point"]);
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
    expect(ordered.map((r) => r.itemRef)).toEqual(["1", "0", "2", "k"]);
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
});
