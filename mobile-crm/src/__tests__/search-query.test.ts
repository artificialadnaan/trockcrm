import { MIN_SEARCH_LENGTH, effectiveSearchQuery, searchIsTooShort } from "../search-query";

describe("what a typed search box asks the server for", () => {
  it("sends nothing for an empty box", () => {
    expect(effectiveSearchQuery("")).toBe("");
    expect(effectiveSearchQuery("   ")).toBe("");
  });

  it("sends nothing for a one-character entry", () => {
    // The floor the submit guard already enforced: one letter matches too much of an office to be
    // worth the round trip. Live search makes it fire on every keystroke, so the floor matters MORE.
    expect(effectiveSearchQuery("b")).toBe("");
  });

  it("sends the trimmed term once it clears the floor", () => {
    expect(effectiveSearchQuery("bishop")).toBe("bishop");
    expect(effectiveSearchQuery("  bishop  ")).toBe("bishop");
  });

  it("treats a too-short entry as NO filter, not as the previous one", () => {
    // Holding a stale query while the box shows something else is the two-paths-disagreeing shape this
    // codebase keeps getting caught by — the rep would be reading results for a term they had deleted.
    expect(effectiveSearchQuery("bi")).toBe("bi");
    expect(effectiveSearchQuery("b")).toBe("");
  });

  it("explains itself only when the entry is genuinely too short", () => {
    // An empty box is not a mistake and must not be nagged at.
    expect(searchIsTooShort("")).toBe(false);
    expect(searchIsTooShort("   ")).toBe(false);
    expect(searchIsTooShort("b")).toBe(true);
    expect(searchIsTooShort("bi")).toBe(false);
  });

  it("keeps the hint and the query agreeing at the boundary", () => {
    // If these ever disagree the screen either filters with no explanation, or explains while filtering.
    for (const raw of ["", " ", "b", " b ", "bi", "bishop"]) {
      const filtering = effectiveSearchQuery(raw) !== "";
      const complaining = searchIsTooShort(raw);
      expect(filtering && complaining).toBe(false);
    }
  });

  it("honours a caller's own floor", () => {
    expect(effectiveSearchQuery("bi", 3)).toBe("");
    expect(effectiveSearchQuery("bis", 3)).toBe("bis");
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });
});
