import { describe, expect, it } from "vitest";
import { buildRepFilterOptions } from "./rep-filter-options";

const ROSTER = [
  { id: "rep-1", displayName: "Colby Burling" },
  { id: "rep-2", displayName: "Derek Barr" },
];

const NAMES: Record<string, string> = {
  "rep-1": "Colby Burling",
  "rep-2": "Derek Barr",
  "off-roster": "Adnaan Iqbal",
};

const resolve = (id: string) => NAMES[id];

describe("buildRepFilterOptions", () => {
  it("returns the roster untouched when nothing is selected", () => {
    expect(buildRepFilterOptions(ROSTER, null, resolve)).toEqual(ROSTER);
    expect(buildRepFilterOptions(ROSTER, undefined, resolve)).toEqual(ROSTER);
    expect(buildRepFilterOptions(ROSTER, "", resolve)).toEqual(ROSTER);
  });

  it("treats the all-reps sentinel as no selection", () => {
    expect(buildRepFilterOptions(ROSTER, "__all__", resolve)).toEqual(ROSTER);
  });

  it("returns the roster untouched when the selection is already on it", () => {
    expect(buildRepFilterOptions(ROSTER, "rep-2", resolve)).toEqual(ROSTER);
  });

  it("appends an off-roster selection so the control cannot report 'All reps'", () => {
    // The defect this exists for: FilterSelect resolves its label with
    // `items.find(...)?.label ?? allLabel`, so an unmatched value renders as "All reps" while the board
    // is still narrowed to that person — the control stating the opposite of what it is doing.
    const options = buildRepFilterOptions(ROSTER, "off-roster", resolve);

    expect(options).toHaveLength(3);
    expect(options[2]).toEqual({ id: "off-roster", displayName: "Adnaan Iqbal" });
    // The roster entries are preserved, in order, ahead of it.
    expect(options.slice(0, 2)).toEqual(ROSTER);
  });

  it("falls back to a truthful placeholder when the name cannot be resolved", () => {
    // A deactivated or deleted user is absent from the wide feed too. "Selected rep" is vague but honest;
    // "All reps" would be a lie.
    const options = buildRepFilterOptions(ROSTER, "ghost", () => undefined);

    expect(options[2]).toEqual({ id: "ghost", displayName: "Selected rep" });
  });

  it("does not mutate the roster it was given", () => {
    const roster = [...ROSTER];
    buildRepFilterOptions(roster, "off-roster", resolve);
    expect(roster).toEqual(ROSTER);
  });

  it("appends nothing when the roster is empty but a selection exists", () => {
    // An errored or still-loading roster must not swallow the active selection either.
    const options = buildRepFilterOptions([], "off-roster", resolve);
    expect(options).toEqual([{ id: "off-roster", displayName: "Adnaan Iqbal" }]);
  });
});
