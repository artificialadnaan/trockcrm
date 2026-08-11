import {
  MIN_SEARCH_LENGTH,
  compareSearchHits,
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

  it("withholds every STAMPED hit while the active office is unknown", () => {
    // The case I got wrong first. `/auth/accessible-offices` is a cached side-request that can still be
    // in flight or have failed, and passing everything through then re-admits every cross-office row
    // for the exact user this filter exists for — unopenable, and able to collide on id with a row from
    // another office in the same list. A stamp means the search WAS cross-office; with nothing to
    // compare it to, reachability is unknowable, so it is counted rather than offered.
    const { openable, elsewhere } = partitionByOffice(hits, null);
    expect(openable).toHaveLength(0);
    expect(elsewhere).toBe(3);
  });

  it("still shows an UNSTAMPED hit while the active office is unknown", () => {
    // No stamp means a single-office search, which by construction ran in the active office. Filtering
    // these out would empty the screen for the ordinary rep, which is the failure the null case exists
    // to avoid — the stamp is what tells the two situations apart.
    const plain: Array<{ id: string; officeSlug?: string }> = [{ id: "a" }, { id: "b" }];
    const { openable, elsewhere } = partitionByOffice(plain, null);
    expect(openable).toHaveLength(2);
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

describe("the order search results are shown in", () => {
  const sorted = (hits: Array<{ id: string; status?: string; rank: number }>) =>
    [...hits].sort(compareSearchHits).map((h) => h.id);

  it("puts live work above closed work even when the closed match is stronger", () => {
    // The contract the client sort was discarding. An exact-name match on a deal lost last quarter
    // outranked a weaker match on the one closing this week, so a search a rep runs to find live work
    // opened with dead work.
    expect(sorted([
      { id: "lost-exact", status: "lost", rank: 0.99 },
      { id: "active-weak", status: "active", rank: 0.2 },
    ])).toEqual(["active-weak", "lost-exact"]);
  });

  it("ranks on-hold between active and terminal", () => {
    expect(sorted([
      { id: "won", status: "won", rank: 0.9 },
      { id: "hold", status: "on_hold", rank: 0.9 },
      { id: "live", status: "active", rank: 0.9 },
    ])).toEqual(["live", "hold", "won"]);
  });

  it("compares relevance INSIDE a tier", () => {
    expect(sorted([
      { id: "weak", status: "active", rank: 0.1 },
      { id: "strong", status: "active", rank: 0.8 },
    ])).toEqual(["strong", "weak"]);
    expect(sorted([
      { id: "lost-weak", status: "lost", rank: 0.1 },
      { id: "lost-strong", status: "lost", rank: 0.8 },
    ])).toEqual(["lost-strong", "lost-weak"]);
  });

  it("treats a hit with no status as active", () => {
    // Contacts, companies, leads and properties carry no lifecycle. A contact is not "closed", and
    // sinking one below a won deal would be inventing a status the server never sent.
    expect(sorted([
      { id: "won-deal", status: "won", rank: 0.9 },
      { id: "contact", rank: 0.3 },
    ])).toEqual(["contact", "won-deal"]);
  });

  it("does not rank won above lost or lost above won", () => {
    // They share a tier on purpose: which of the two matters more is not a question search can answer.
    const byRank = sorted([
      { id: "lost", status: "lost", rank: 0.9 },
      { id: "won", status: "won", rank: 0.5 },
    ]);
    expect(byRank).toEqual(["lost", "won"]);
  });
});
