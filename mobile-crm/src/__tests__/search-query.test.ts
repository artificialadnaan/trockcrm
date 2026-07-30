import {
  MIN_SEARCH_LENGTH,
  effectiveSearchQuery,
  partitionByOffice,
  searchIsTooShort,
} from "../search-query";

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

describe("which search hits this app can actually open", () => {
  const hits = [
    { id: "a", officeSlug: "dallas" },
    { id: "b", officeSlug: "austin" },
    { id: "c", officeSlug: "dallas" },
  ];

  it("keeps hits from the active office and counts the rest", () => {
    // Offices are separate Postgres schemas and every other request sends the ACTIVE office's
    // x-office-id, so an austin record fetched from dallas is a 404 — not a row worth offering.
    const { openable, elsewhere } = partitionByOffice(hits, "dallas");
    expect(openable.map((h) => h.id)).toEqual(["a", "c"]);
    expect(elsewhere).toBe(1);
  });

  it("passes everything through when the active office is not known yet", () => {
    // The office list is a cached side-request. Filtering against a null active office would empty the
    // screen for the ordinary single-office rep — a far worse failure than showing one unopenable row.
    const { openable, elsewhere } = partitionByOffice(hits, null);
    expect(openable).toHaveLength(3);
    expect(elsewhere).toBe(0);
  });

  it("passes hits that carry no office at all", () => {
    // A single-office search response stamps no slug; absence means "not cross-office", not "elsewhere".
    const noSlug: Array<{ id: string; officeSlug?: string }> = [{ id: "a" }, { id: "b" }];
    const { openable, elsewhere } = partitionByOffice(noSlug, "dallas");
    expect(openable).toHaveLength(2);
    expect(elsewhere).toBe(0);
  });

  it("never counts a hit it also shows", () => {
    for (const active of ["dallas", "austin", "houston"]) {
      const { openable, elsewhere } = partitionByOffice(hits, active);
      expect(openable.length + elsewhere).toBe(hits.length);
    }
  });
});
