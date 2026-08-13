import { describe, expect, it } from "vitest";
import { toProperCaseName } from "./person-name.js";

describe("toProperCaseName", () => {
  it("capitalises the all-lowercase names that prompted this", () => {
    // The exact production rows, from the census of public.users on 2026-08-13.
    expect(toProperCaseName("nick reyes")).toBe("Nick Reyes");
    expect(toProperCaseName("kevin posey")).toBe("Kevin Posey");
    expect(toProperCaseName("steve sanchez")).toBe("Steve Sanchez");
    expect(toProperCaseName("nick cheatham")).toBe("Nick Cheatham");
    expect(toProperCaseName("adnaan iqbal")).toBe("Adnaan Iqbal");
  });

  it("does NOT corrupt a name that is already correctly mixed-case", () => {
    // The whole reason for the hasInternalCapital guard. A naive title-case pass returns "Edward Mccarty"
    // here and silently degrades data that was right — worse than the bug being fixed, and it would hit
    // every existing user on every save.
    expect(toProperCaseName("Edward McCarty")).toBe("Edward McCarty");
    expect(toProperCaseName("Chris Higingbotham")).toBe("Chris Higingbotham");
    expect(toProperCaseName("Kristy Scheidegger")).toBe("Kristy Scheidegger");
    expect(toProperCaseName("Takashi Yamashita")).toBe("Takashi Yamashita");
  });

  it("leaves lowercase name particles alone in an already-cased name (Codex P2)", () => {
    // The regression that a per-TOKEN intent test caused: judged alone, "van" and "de" look like unstyled
    // words, so a correctly-stored Dutch or Spanish name came back mangled. Because this helper runs on
    // EVERY user write, that meant merely saving one of these rows corrupted it.
    expect(toProperCaseName("van der Berg")).toBe("van der Berg");
    expect(toProperCaseName("de la Cruz")).toBe("de la Cruz");
    expect(toProperCaseName("Ludwig van Beethoven")).toBe("Ludwig van Beethoven");
    expect(toProperCaseName("Vincent van Gogh")).toBe("Vincent van Gogh");
    expect(toProperCaseName("Oscar de la Renta")).toBe("Oscar de la Renta");
  });

  it("keeps particles lowercase when it DOES have to case an all-lowercase name", () => {
    // Here there is no intent to preserve, so the name is rewritten — and the particle list keeps that
    // rewrite from producing "Van Der Berg".
    expect(toProperCaseName("van der berg")).toBe("Van der Berg");
    expect(toProperCaseName("oscar de la renta")).toBe("Oscar de la Renta");
  });

  it("capitalises a leading particle in a FULL name, which is a given name far more often", () => {
    expect(toProperCaseName("van johnson")).toBe("Van Johnson");
    expect(toProperCaseName("al jackson")).toBe("Al Jackson");
  });

  it("keeps a leading particle lowercase in a standalone surname (Codex P2)", () => {
    // Without this the component columns contradict the full name: display_name normalises to
    // "Ludwig van Beethoven" while last_name alone becomes "Van Beethoven", and Admin → Field Users
    // renders `{firstName} {lastName}` — so that screen shows "Ludwig Van Beethoven".
    expect(toProperCaseName("van beethoven", { surname: true })).toBe("van Beethoven");
    expect(toProperCaseName("de la renta", { surname: true })).toBe("de la Renta");
  });

  it("agrees with the full name it was split from", () => {
    const full = toProperCaseName("ludwig van beethoven");
    const first = toProperCaseName("ludwig");
    const last = toProperCaseName("van beethoven", { surname: true });

    expect(full).toBe("Ludwig van Beethoven");
    expect(`${first} ${last}`).toBe(full);
  });

  it("preserves Roman-numeral generational suffixes (Codex P2)", () => {
    // Lowercasing the token and capitalising only its first letter stored "John Smith Iii" — corruption
    // on the create, import and backfill paths alike, and permanent once written.
    expect(toProperCaseName("JOHN SMITH III")).toBe("John Smith III");
    expect(toProperCaseName("john smith iii")).toBe("John Smith III");
    expect(toProperCaseName("john smith ii")).toBe("John Smith II");
    expect(toProperCaseName("john smith iv")).toBe("John Smith IV");
  });

  it("preserves compact initials in an all-caps name (Codex P2)", () => {
    // "AJ SMITH" was stored as "Aj Smith" — a rule that assumed every uppercase run was shouting.
    expect(toProperCaseName("AJ SMITH")).toBe("AJ Smith");
    expect(toProperCaseName("TJ JONES")).toBe("TJ Jones");
    expect(toProperCaseName("DJ BROWN")).toBe("DJ Brown");
    // Longer tokens still normalise, so genuine shouting is still fixed.
    expect(toProperCaseName("COREY SANCHEZ")).toBe("Corey Sanchez");
  });

  it("reads a two-letter particle as a particle, not as initials (Codex P2)", () => {
    // Ordering bug: "DE" and "LA" are two uppercase letters, so an initials-first rule claimed them and
    // stored "JOHN DE LA CRUZ" as "John DE LA Cruz". A token the surrounding name proves is a particle
    // is never initials — the ambiguous case the initials rule exists for is one with no such context.
    expect(toProperCaseName("JOHN DE LA CRUZ")).toBe("John de la Cruz");
    expect(toProperCaseName("DE LA CRUZ", { surname: true })).toBe("de la Cruz");
    expect(toProperCaseName("JAN VAN DER BERG")).toBe("Jan van der Berg");
    // ...while a two-letter token with no particle context is still preserved as initials.
    expect(toProperCaseName("AJ SMITH")).toBe("AJ Smith");
  });

  it("does NOT uppercase surnames that happen to be valid Roman numerals", () => {
    // Why the suffix set is enumerated rather than syntax-checked. LI (51), XI (11), DI (501), MI (1001),
    // CI (101) and VI (6) all parse as valid Roman numerals, and Li and Xi are among the most common
    // surnames on earth — a syntax check would file "john li" as "John LI".
    expect(toProperCaseName("john li")).toBe("John Li");
    expect(toProperCaseName("jinping xi")).toBe("Jinping Xi");
    expect(toProperCaseName("nguyen vi")).toBe("Nguyen Vi");
    expect(toProperCaseName("marco di")).toBe("Marco Di");
  });

  it("does not mistake a name for a suffix", () => {
    // "Vi" is a common given name, so the suffix rule is anchored to the LAST token of a multi-word name.
    expect(toProperCaseName("vi nguyen")).toBe("Vi Nguyen");
    expect(toProperCaseName("iii jones")).toBe("Iii Jones");
    // A lone token is never a suffix either.
    expect(toProperCaseName("vi")).toBe("Vi");
  });

  it("leaves single-letter suffixes alone, which never needed help", () => {
    // A one-character token already comes back uppercase, so the suffix set excludes single letters and
    // avoids competing with initials.
    expect(toProperCaseName("JOHN SMITH V")).toBe("John Smith V");
    expect(toProperCaseName("john smith x")).toBe("John Smith X");
  });

  it("still capitalises an ordinary surname that merely starts with a non-particle", () => {
    expect(toProperCaseName("posey", { surname: true })).toBe("Posey");
    expect(toProperCaseName("reyes", { surname: true })).toBe("Reyes");
    expect(toProperCaseName("sanchez", { surname: true })).toBe("Sanchez");
  });

  it("leaves a half-cased name as typed rather than guessing", () => {
    // The acknowledged cost of testing intent across the whole name. "shawn McDonald" is ambiguous —
    // leaving a human's text alone beats guessing which half they meant.
    expect(toProperCaseName("shawn McDonald")).toBe("shawn McDonald");
    expect(toProperCaseName("DeShawn smith")).toBe("DeShawn smith");
    expect(toProperCaseName("O'Brien connor")).toBe("O'Brien connor");
  });

  it("re-cases an all-uppercase name", () => {
    expect(toProperCaseName("COREY SANCHEZ")).toBe("Corey Sanchez");
    expect(toProperCaseName("KEVIN POSEY")).toBe("Kevin Posey");
  });

  it("capitalises after hyphens and apostrophes", () => {
    expect(toProperCaseName("mary-jane watson")).toBe("Mary-Jane Watson");
    expect(toProperCaseName("o'brien mcgee")).toBe("O'Brien Mcgee");
    // Typographic apostrophe, which real names pasted from Word carry.
    expect(toProperCaseName("o’neill park")).toBe("O’Neill Park");
  });

  it("collapses stray whitespace", () => {
    expect(toProperCaseName("  nick   reyes  ")).toBe("Nick Reyes");
  });

  it("passes null, undefined and empty through unchanged", () => {
    expect(toProperCaseName(null)).toBeNull();
    expect(toProperCaseName(undefined)).toBeUndefined();
    expect(toProperCaseName("")).toBe("");
    expect(toProperCaseName("   ")).toBe("");
  });

  it("leaves a single-letter or non-letter token alone rather than mangling it", () => {
    expect(toProperCaseName("alan")).toBe("Alan");
    expect(toProperCaseName("j r ewing")).toBe("J R Ewing");
    expect(toProperCaseName("123")).toBe("123");
  });

  it("capitalises the first LETTER, not the first character", () => {
    // A leading bracket or quote must not absorb the capitalisation.
    expect(toProperCaseName("(nick) reyes")).toBe("(Nick) Reyes");
  });

  it("is idempotent — running it twice changes nothing", () => {
    for (const input of ["nick reyes", "Edward McCarty", "COREY SANCHEZ", "mary-jane watson"]) {
      const once = toProperCaseName(input);
      expect(toProperCaseName(once)).toBe(once);
    }
  });
});
