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

  it("preserves deliberate internal capitals token by token", () => {
    // Mixed input: one token an admin cased on purpose, one they did not.
    expect(toProperCaseName("shawn McDonald")).toBe("Shawn McDonald");
    expect(toProperCaseName("DeShawn smith")).toBe("DeShawn Smith");
    expect(toProperCaseName("O'Brien connor")).toBe("O'Brien Connor");
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
