import { describe, expect, it } from "vitest";
import {
  matchFieldResponders,
  nameEditDistance,
  type ResponderMatchConfidence,
} from "./responderNameMatch.js";

// The real office_dallas field_responders roster, verbatim, because every rule below was derived from the
// interaction between THIS roster and the free text that was actually typed on the 19 cards. A trimmed
// fixture would quietly delete the collisions that make the hard cases hard (Nick Reyes vs Nick Cheatam is
// the whole ballgame). `email` is carried so the tests also prove the caller's richer row survives the
// match — resolving a responder is only useful if you get the address back.
const responder = (name: string, role: string, isActive = true) => ({
  id: name.toLowerCase().replace(/[^a-z]+/g, "-"),
  name,
  role,
  isActive,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@trockgc.com`,
});

const DALLAS_ROSTER = [
  responder("Adam Sherwood", "project_manager"),
  responder("Brock Burns", "project_manager"),
  responder("Colby Burling", "project_manager"),
  responder("Nick Cheatam", "project_manager"),
  responder("Adnaan Iqbal", "superintendent", false),
  responder("Andrew Green", "superintendent"),
  responder("Brett Bell", "superintendent"),
  responder("Caleb Stone", "superintendent"),
  responder("Chris Higingbotham", "superintendent"),
  responder("Corey McShane", "superintendent"),
  responder("Eric Burnett", "superintendent"),
  responder("Kevin Posey", "superintendent"),
  responder("Nick Reyes", "superintendent"),
  responder("Robert Sampley", "superintendent"),
  responder("Steve Sanchez", "superintendent"),
  responder("Triston Mitchell", "superintendent"),
];

type Roster = typeof DALLAS_ROSTER;

interface Expectation {
  matches?: Array<[name: string, confidence: ResponderMatchConfidence]>;
  ambiguous?: Array<[matchedText: string, names: string[]]>;
  unmatched?: string[];
}

interface Case extends Expectation {
  /** Named after the behaviour it protects, prefixed with the rule it came from. */
  name: string;
  text: string | null | undefined;
  role: string;
  roster?: Roster;
}

function run(testCase: Case) {
  const result = matchFieldResponders({
    text: testCase.text,
    role: testCase.role,
    roster: testCase.roster ?? DALLAS_ROSTER,
  });
  expect(result.matches.map((m) => [m.responder.name, m.confidence])).toEqual(
    testCase.matches ?? [],
  );
  expect(result.ambiguous.map((a) => [a.matchedText, a.candidates.map((c) => c.name)])).toEqual(
    testCase.ambiguous ?? [],
  );
  expect(result.unmatched).toEqual(testCase.unmatched ?? []);
}

const CASES: Case[] = [
  // 1. Role scoping is absolute, not a tie-breaker.
  {
    name: "1: a project_manager is NEVER returned for a superintendent query, exact name or not",
    text: "Adam Sherwood",
    role: "superintendent",
    unmatched: ["Adam Sherwood"],
  },
  {
    name: "1: the PM roster does not answer a superintendent query even for a PERFECT full name",
    text: "Nick Cheatam",
    role: "superintendent",
    unmatched: ["Nick Cheatam"],
  },

  // 2. !! Inactive is not a candidate.
  {
    name: "2 !!: 'Adnaan Iqbal' resolves to NOBODY — on the roster, but is_active = false",
    text: "Adnaan Iqbal",
    role: "superintendent",
    unmatched: ["Adnaan Iqbal"],
  },

  // 3. Exact full names.
  {
    name: "3: exact full name -> that person, confidence exact (Kevin Posey)",
    text: "Kevin Posey",
    role: "superintendent",
    matches: [["Kevin Posey", "exact"]],
  },
  {
    name: "3: exact full name -> that person, confidence exact (Brett Bell)",
    text: "Brett Bell",
    role: "superintendent",
    matches: [["Brett Bell", "exact"]],
  },
  {
    name: "3: exact full name -> that person, confidence exact (Eric Burnett)",
    text: "Eric Burnett",
    role: "superintendent",
    matches: [["Eric Burnett", "exact"]],
  },
  {
    name: "3: exact full name -> that person, confidence exact (Chris Higingbotham)",
    text: "Chris Higingbotham",
    role: "superintendent",
    matches: [["Chris Higingbotham", "exact"]],
  },
  {
    name: "3: exact full name -> that person, confidence exact (Nick Reyes)",
    text: "Nick Reyes",
    role: "superintendent",
    matches: [["Nick Reyes", "exact"]],
  },

  // 4. Case is not evidence.
  {
    name: "4: lower-cased surname is still exact ('Brett bell')",
    text: "Brett bell",
    role: "superintendent",
    matches: [["Brett Bell", "exact"]],
  },
  {
    name: "4: lower-cased surname is still exact ('Kevin posey')",
    text: "Kevin posey",
    role: "superintendent",
    matches: [["Kevin Posey", "exact"]],
  },
  {
    name: "4: an INTERNAL capital is not a difference ('Corey mcshane' -> Corey McShane)",
    text: "Corey mcshane",
    role: "superintendent",
    matches: [["Corey McShane", "exact"]],
  },

  // 5. Punctuation / whitespace are not evidence either.
  {
    name: "5: stray punctuation and repeated whitespace do not downgrade an exact match",
    text: "  Kevin   Posey.  ",
    role: "superintendent",
    matches: [["Kevin Posey", "exact"]],
  },

  // 6-8. Multi-person fields yield MULTIPLE recipients, in the order typed.
  {
    name: "6: '/' separates two people, returned in input order",
    text: "Brett Bell/Robert Sampley",
    role: "superintendent",
    matches: [
      ["Brett Bell", "exact"],
      ["Robert Sampley", "exact"],
    ],
  },
  {
    name: "7: '&' separates two people, returned in input order",
    text: "Brett bell & Robert Sampley",
    role: "superintendent",
    matches: [
      ["Brett Bell", "exact"],
      ["Robert Sampley", "exact"],
    ],
  },
  {
    name: "8: a BARE FIRST NAME segment still resolves when the roster holds exactly one Brett",
    text: "Brett/robert sampley",
    role: "superintendent",
    // "Brett" is high, not exact: it accounts for part of the name, so a caller wanting the full-name tier
    // before auto-sending can still tell the two apart.
    matches: [
      ["Brett Bell", "high"],
      ["Robert Sampley", "exact"],
    ],
  },
  {
    name: "8: the word 'and' separates people too",
    text: "Brett Bell and Robert Sampley",
    role: "superintendent",
    matches: [
      ["Brett Bell", "exact"],
      ["Robert Sampley", "exact"],
    ],
  },

  // 9-12. Four prod spellings of ONE person.
  {
    name: "9: 'Nick Cheatham' (inserted h) -> Nick Cheatam, high",
    text: "Nick Cheatham",
    role: "project_manager",
    matches: [["Nick Cheatam", "high"]],
  },
  {
    name: "10: 'Nick Cheatum' (substituted vowel) -> Nick Cheatam, high",
    text: "Nick Cheatum",
    role: "project_manager",
    matches: [["Nick Cheatam", "high"]],
  },
  {
    name: "11: 'Nick Cheatem' (substituted vowel) -> Nick Cheatam, high",
    text: "Nick Cheatem",
    role: "project_manager",
    matches: [["Nick Cheatam", "high"]],
  },
  {
    name: "12: 'Nick Chatham' (edit distance 2 on the surname) -> Nick Cheatam, high",
    text: "Nick Chatham",
    role: "project_manager",
    matches: [["Nick Cheatam", "high"]],
  },

  // 13. !! THE case. An unmatched surname token is evidence AGAINST the first-name match.
  {
    name: "13 !!: 'Nick Cheaham' as SUPERINTENDENT resolves to nobody — it must NOT reach Nick Reyes",
    text: "Nick Cheaham",
    role: "superintendent",
    unmatched: ["Nick Cheaham"],
  },
  {
    name: "13 !!: the same text as PROJECT_MANAGER resolves fine — role scoping did the work, not luck",
    text: "Nick Cheaham",
    role: "project_manager",
    matches: [["Nick Cheatam", "high"]],
  },

  // 14. !! Short strings make ratios lie.
  {
    name: "14 !!: 'Addy' resolves to nobody — it must NOT become Adam Sherwood",
    text: "Addy",
    role: "project_manager",
    unmatched: ["Addy"],
  },
  {
    name: "14 !!: 'Adam' DOES resolve — the difference is exactness, not length",
    text: "Adam",
    role: "project_manager",
    matches: [["Adam Sherwood", "high"]],
  },

  // 15-17. Off-roster and junk.
  {
    name: "15: 'Derek Barr' — a real CRM user who is NOT on the PM roster — resolves to nobody",
    text: "Derek Barr",
    role: "project_manager",
    unmatched: ["Derek Barr"],
  },
  {
    name: "16: 'James helms' — same shape, off-roster — resolves to nobody",
    text: "James helms",
    role: "project_manager",
    unmatched: ["James helms"],
  },
  {
    name: "17: 'Test' resolves to nobody and is reported as unmatched, not swallowed",
    text: "Test",
    role: "project_manager",
    unmatched: ["Test"],
  },
  { name: "17: null does not throw", text: null, role: "project_manager" },
  { name: "17: undefined does not throw", text: undefined, role: "project_manager" },
  { name: "17: an empty string does not throw", text: "", role: "project_manager" },
  { name: "17: whitespace-only does not throw and is not an unmatched segment", text: "   ", role: "superintendent" },
  { name: "17: a lone delimiter does not throw and is not an unmatched segment", text: " / ", role: "superintendent" },

  // 18. A bare first name, on its own, when nothing argues otherwise.
  {
    name: "18: bare 'Brett' -> Brett Bell, high — one Brett in the role and no surname contradicting it",
    text: "Brett",
    role: "superintendent",
    matches: [["Brett Bell", "high"]],
  },
  {
    name: "18: a bare SURNAME resolves the same way when it is unique in the role",
    text: "Mitchell",
    role: "superintendent",
    matches: [["Triston Mitchell", "high"]],
  },

  // The gates themselves, each with the input that would slip past if it were tuned one notch looser.
  // These are the tests that would have to be argued with to loosen a threshold, which is the point.
  {
    name: "the fuzzy LENGTH FLOOR holds even with a corroborating surname ('Addy Sherwood')",
    text: "Addy Sherwood",
    role: "project_manager",
    // Rule 14's trap does not stop being a trap because a second token agrees: four characters cannot
    // carry two edits' worth of intent. A miss here costs a follow-up; guessing costs Adam Sherwood.
    unmatched: ["Addy Sherwood"],
  },
  {
    name: "the fuzzy LENGTH FLOOR rejects a SHORT surname one edit out ('Brett Ball')",
    text: "Brett Ball",
    role: "superintendent",
    // Ball/Bell is a single edit, and that is exactly why the floor exists: at four characters one edit is
    // the distance between two different families, so short tokens get no allowance at all. Note the bare
    // "Brett" of rule 18 DOES resolve — a surname that is nearly right still argues against, same as 13.
    unmatched: ["Brett Ball"],
  },
  {
    name: "a 5-char FIRST name two edits out does not ride an exact surname ('Casey McShane')",
    text: "Casey McShane",
    role: "superintendent",
    // Casey/Corey is distance 2 — the same distance the ladder ALLOWS on 12-character Higingbotham below.
    // That asymmetry is the ladder's entire content: two edits inside a long surname is a typo, two edits
    // inside a five-letter first name is a different name.
    unmatched: ["Casey McShane"],
  },
  {
    name: "a BARE name that is not exactly right resolves to nobody ('Samply')",
    text: "Samply",
    role: "superintendent",
    // One token, and misspelled, is the thinnest evidence any input can carry. Fuzz needs an exact token
    // anchoring it, which is also what keeps rule 18's bare-first-name allowance from becoming a guess.
    unmatched: ["Samply"],
  },
  {
    name: "a short token does not inherit a long name part's allowance ('Corey Shane')",
    text: "Corey Shane",
    role: "superintendent",
    // Shane/McShane is distance 2, measured at the SHORTER length (5) and so capped at 1. Measuring on the
    // longer would let any five-letter surname reach a seven-letter one — "Shane" is a name in its own
    // right, not a misspelling of McShane.
    unmatched: ["Corey Shane"],
  },
  {
    name: "one token cannot account for the same name part twice ('Brett Brett')",
    text: "Brett Brett",
    role: "superintendent",
    // Each token consumes a DISTINCT part, so a doubled token cannot pass itself off as a full-name match.
    unmatched: ["Brett Brett"],
  },
  {
    name: "the DISTANCE CAP earns its keep on the real-world misspelling of a long surname",
    text: "Chris Higginbotham",
    role: "superintendent",
    // The spelling most people reach for, two edits from the roster's — the same allowance rule 12 needs.
    matches: [["Chris Higingbotham", "high"]],
  },
  {
    name: "a PLAUSIBLE but wrong surname does not ride a unique first name ('Steve Sanders')",
    text: "Steve Sanders",
    role: "superintendent",
    // Rule 13's shape with an ordinary-looking surname: Steve is the only Steve in the role, and that
    // still is not enough, because "Sanders" is four edits from "Sanchez" and so argues against him.
    unmatched: ["Steve Sanders"],
  },
  {
    name: "an unexplained EXTRA token is evidence against, not decoration ('Brett Bell Jr')",
    text: "Brett Bell Jr",
    role: "superintendent",
    // Deliberate: if a Brett Bell Jr ever joins, the generational suffix is the ONLY thing distinguishing
    // two humans, so a matcher that discards it addresses a coin flip.
    unmatched: ["Brett Bell Jr"],
  },
  {
    name: "two typos in ONE name is a coincidence, not a spelling",
    text: "Chris Von Higinbotham",
    role: "superintendent",
    // Needs a three-part name to be reachable at all (with two-part names, two fuzzy tokens means no exact
    // anchor and the exact-anchor rule rejects first). "Von" is 3 chars from "Van" and the surname is one
    // edit out; either alone would pass, together they are a guess.
    roster: [...DALLAS_ROSTER, responder("Chris Van Higingbotham", "superintendent")],
    unmatched: ["Chris Von Higinbotham"],
  },
];

describe("matchFieldResponders", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => run(testCase));
  }

  // 19 + 20. Collisions the prod roster does not happen to have TODAY. Asserting these against a synthetic
  // roster is the point: "no two Bretts right now" is a fact about hiring, not a property of the matcher,
  // and the roster grows. Prod already has superintendent Triston Mitchell while Timothy Mitchell submits
  // cards, so bare "Mitchell" is the exact shape that will collide next.
  it("19: a bare FIRST name shared by two people in the role is AMBIGUOUS, never a pick", () => {
    const roster = [...DALLAS_ROSTER, responder("Brett Sanders", "superintendent")];
    const result = matchFieldResponders({ text: "Brett", role: "superintendent", roster });

    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].matchedText).toBe("Brett");
    expect(result.ambiguous[0].candidates.map((c) => c.name)).toEqual([
      "Brett Bell",
      "Brett Sanders",
    ]);
  });

  it("20: a bare SURNAME shared by two people in the role is AMBIGUOUS, never a pick", () => {
    const roster = [...DALLAS_ROSTER, responder("Timothy Mitchell", "superintendent")];
    const result = matchFieldResponders({ text: "Mitchell", role: "superintendent", roster });

    expect(result.matches).toEqual([]);
    expect(result.ambiguous[0].candidates.map((c) => c.name)).toEqual([
      "Triston Mitchell",
      "Timothy Mitchell",
    ]);
  });

  it("a full-name hit still wins outright when a partial hit exists, rather than going ambiguous", () => {
    // Two people share the first name, but the text names one of them completely. Going ambiguous here
    // would strand a card whose author did everything right.
    const roster = [...DALLAS_ROSTER, responder("Brett Sanders", "superintendent")];
    const result = matchFieldResponders({ text: "Brett Bell", role: "superintendent", roster });

    expect(result.ambiguous).toEqual([]);
    expect(result.matches.map((m) => [m.responder.name, m.confidence])).toEqual([
      ["Brett Bell", "exact"],
    ]);
  });

  it("names one person once, even when the field spells them twice", () => {
    // A comma is a person delimiter (a two-PM field is normal), so "Surname, First" arrives as two
    // segments. Both resolve to the same human and must not become two recipients.
    const result = matchFieldResponders({
      text: "Higingbotham, Chris",
      role: "superintendent",
      roster: DALLAS_ROSTER,
    });

    expect(result.matches.map((m) => m.responder.name)).toEqual(["Chris Higingbotham"]);
  });

  it("reports a partially-resolved field as BOTH matched and unmatched, never as a clean resolve", () => {
    const result = matchFieldResponders({
      text: "Brett Bell/Derek Barr",
      role: "superintendent",
      roster: DALLAS_ROSTER,
    });

    expect(result.matches.map((m) => m.responder.name)).toEqual(["Brett Bell"]);
    expect(result.unmatched).toEqual(["Derek Barr"]);
  });

  it("returns the caller's own roster row, so the resolved email is available without a re-lookup", () => {
    const result = matchFieldResponders({
      text: "Kevin Posey",
      role: "superintendent",
      roster: DALLAS_ROSTER,
    });

    expect(result.matches[0].responder.email).toBe("kevin.posey@trockgc.com");
  });
});

// Every distinct free-text value that exists across the 19 office_dallas cards, and who it resolves to.
// This is the backfill's actual output, locked in: the risk being guarded is not "did a rule regress" but
// "did a rule change route a real corrective action to a different real person".
describe("the prod free-text census (19 cards)", () => {
  const SUPERINTENDENT_CENSUS: Array<[text: string, resolved: string[]]> = [
    ["Adnaan Iqbal", []], // INACTIVE
    ["Kevin Posey", ["Kevin Posey"]],
    ["Brett Bell", ["Brett Bell"]],
    ["Eric Burnett", ["Eric Burnett"]],
    ["Brett bell", ["Brett Bell"]],
    ["Brett bell & Robert Sampley", ["Brett Bell", "Robert Sampley"]],
    ["Brett Bell/Robert Sampley", ["Brett Bell", "Robert Sampley"]],
    ["Brett/robert sampley", ["Brett Bell", "Robert Sampley"]],
    ["Chris Higingbotham", ["Chris Higingbotham"]],
    ["Corey mcshane", ["Corey McShane"]],
    ["Kevin posey", ["Kevin Posey"]],
    ["Nick Cheaham", []], // a PM's name in the superintendent field — must not reach Nick Reyes
    ["Nick Reyes", ["Nick Reyes"]],
  ];

  const PM_CENSUS: Array<[text: string | null, resolved: string[]]> = [
    ["Adam Sherwood", ["Adam Sherwood"]],
    ["Nick Cheatham", ["Nick Cheatam"]],
    ["Nick Cheatum", ["Nick Cheatam"]],
    ["Nick Chatham", ["Nick Cheatam"]],
    ["Nick Cheatem", ["Nick Cheatam"]],
    ["Addy", []],
    ["Derek Barr", []],
    ["James helms", []],
    ["Test", []],
    [null, []],
  ];

  for (const [text, resolved] of SUPERINTENDENT_CENSUS) {
    it(`superintendent_name ${JSON.stringify(text)} -> ${resolved.join(", ") || "NOBODY"}`, () => {
      const result = matchFieldResponders({ text, role: "superintendent", roster: DALLAS_ROSTER });
      expect(result.matches.map((m) => m.responder.name)).toEqual(resolved);
      // No prod value is ambiguous today; if one becomes ambiguous the caller must be told, not guessed at.
      expect(result.ambiguous).toEqual([]);
    });
  }

  for (const [text, resolved] of PM_CENSUS) {
    it(`pm_name ${JSON.stringify(text)} -> ${resolved.join(", ") || "NOBODY"}`, () => {
      const result = matchFieldResponders({ text, role: "project_manager", roster: DALLAS_ROSTER });
      expect(result.matches.map((m) => m.responder.name)).toEqual(resolved);
      expect(result.ambiguous).toEqual([]);
    });
  }
});

// The thresholds are calibrated on these exact numbers, so they are asserted directly rather than only
// through the names above — a future tuner needs to see WHICH distances the ladder is standing between.
describe("nameEditDistance (the calibration points)", () => {
  it("holds the four prod spellings of Cheatam within distance 2, and Addy/Adam outside the length floor", () => {
    expect(nameEditDistance("cheatham", "cheatam")).toBe(1);
    expect(nameEditDistance("cheatum", "cheatam")).toBe(1);
    expect(nameEditDistance("cheatem", "cheatam")).toBe(1);
    // The one that forces the long-token cap up to 2.
    expect(nameEditDistance("chatham", "cheatam")).toBe(2);
    // Same distance as the case above over four characters — which is exactly why the gate is not a ratio.
    expect(nameEditDistance("addy", "adam")).toBe(2);
  });

  it("keeps the surnames that must stay apart well clear of the cap", () => {
    // The pair behind the 'Steve Sanders' case: ordinary-looking, similar-shaped, and four edits apart.
    expect(nameEditDistance("sanders", "sanchez")).toBe(4);
    // And the pair behind rule 13 — the length difference alone puts it past the cap for a 5-char surname.
    expect(nameEditDistance("cheaham", "reyes")).toBeGreaterThan(2);
  });
});

// ── Findings from the adversarial pass ─────────────────────────────────────────────────────────────────
// The workflow's four adversary agents all stalled and returned nothing, so `findings: []` recorded the
// ABSENCE of testing rather than the absence of defects — and the repair phase was skipped on that false
// signal. These are the five real misses found by re-running the attack by hand (82 probes across the four
// lenses: wrong-person, role-crossing, multi-person, missed-match).
//
// All five were missed-MATCHES, the cheaper failure direction. Every wrong-person probe held: crossed
// name pairs ("Brett Sampley", "Kevin Bell"), nicknames ("Addy", "Addy Sherwood"), near-surnames
// ("Brett Ball", "Steve Sanders", "Corey Shane"), bare initials ("B Bell", "BB"), role crossing in both
// directions, the inactive member even as the only candidate, and bare first/last names against a roster
// carrying a deliberate collision.
describe("adversarial findings", () => {
  const sup = (text: string) =>
    matchFieldResponders({ text, role: "superintendent", roster: DALLAS_ROSTER });
  const pm = (text: string) =>
    matchFieldResponders({ text, role: "project_manager", roster: DALLAS_ROSTER });
  const names = (result: { matches: Array<{ responder: { name: string } }> }) =>
    result.matches.map((m) => m.responder.name);

  it("treats 'w/' as a separator instead of letting it corrupt the preceding segment", () => {
    // Splitting on the bare "/" first left "Brett Bell w" — an orphan "w" token failed the every-token
    // rule, so Brett Bell was DROPPED while Robert Sampley still resolved. A field that silently
    // half-resolves is worse than one that does not split: a real superintendent goes unnotified and the
    // result still looks successful.
    expect(names(sup("Brett Bell w/ Robert Sampley"))).toEqual(["Brett Bell", "Robert Sampley"]);
  });

  it("splits on a newline, which is an ordinary way to type two people on a phone", () => {
    expect(names(sup("Brett Bell\nRobert Sampley"))).toEqual(["Brett Bell", "Robert Sampley"]);
    expect(names(sup("Brett Bell\r\nRobert Sampley"))).toEqual(["Brett Bell", "Robert Sampley"]);
  });

  it("ignores a parenthesised role annotation appended to the name", () => {
    expect(names(pm("Adam Sherwood (PM)"))).toEqual(["Adam Sherwood"]);
    expect(names(sup("Brett Bell (super)"))).toEqual(["Brett Bell"]);
  });

  it("ignores a trailing dash-role annotation", () => {
    expect(names(pm("Adam Sherwood - PM"))).toEqual(["Adam Sherwood"]);
    expect(names(sup("Brett Bell - Superintendent"))).toEqual(["Brett Bell"]);
  });

  it("ignores a leading honorific", () => {
    expect(names(sup("Mr. Brett Bell"))).toEqual(["Brett Bell"]);
    expect(names(sup("Dr Brett Bell"))).toEqual(["Brett Bell"]);
  });

  it("does NOT strip a generational suffix — Jr may be a different human", () => {
    // Deliberately asymmetric with the honorific case above. "Mr." carries no identity; "Jr" does, and
    // guessing which of two same-named people to email is the exact mistake this matcher exists to avoid.
    expect(sup("Brett Bell Jr").matches).toEqual([]);
    expect(sup("Brett Bell II").matches).toEqual([]);
  });

  it("keeps stripping identity-neutral noise from making a WRONG person reachable", () => {
    // The strips remove tokens; they must never loosen a distance allowance. If they did, the nickname and
    // crossed-name cases would start resolving once wrapped in noise.
    expect(pm("Addy (PM)").matches).toEqual([]);
    expect(sup("Mr. Brett Sampley").matches).toEqual([]);
    expect(sup("Brett Ball - Superintendent").matches).toEqual([]);
    // And rule 13 must survive the noise treatment too.
    expect(sup("Nick Cheaham (super)").matches).toEqual([]);
  });
});
