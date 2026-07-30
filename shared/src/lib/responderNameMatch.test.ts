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
    name: "1: a person typed into the WRONG role's field still resolves — to themselves",
    text: "Adam Sherwood",
    role: "superintendent",
    // Adam Sherwood is a project_manager. Which of the two name fields he was typed into says nothing about
    // the role he holds, so refusing to resolve him here just loses a real recipient. The caller learns the
    // slot is wrong from roleMatchesQuery, asserted separately below.
    matches: [["Adam Sherwood", "exact"]],
  },
  {
    name: "1: a PERFECT full name from the other role resolves rather than being discarded",
    text: "Nick Cheatam",
    role: "superintendent",
    matches: [["Nick Cheatam", "exact"]],
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
    // Adnaan confirmed the business fact: "Nick Cheaham" IS Nick Cheatam. He is a project_manager and this
    // text sits in a card's SUPERINTENDENT field — a wrong-slot typo, not a different person. The property
    // that still MUST hold is that it does not reach superintendent Nick REYES, and that is enforced by the
    // every-token rule (the surname argues against a bare first-name hit), never by the role filter.
    name: "13 !!: 'Nick Cheaham' in the SUPERINTENDENT field reaches Nick Cheatam, NOT Nick Reyes",
    text: "Nick Cheaham",
    role: "superintendent",
    matches: [["Nick Cheatam", "high"]],
  },
  {
    name: "13 !!: the same text queried as PROJECT_MANAGER resolves identically",
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
    // Nick Cheatam typed into the superintendent field. Resolves to HIM (Adnaan confirmed the identity), and
    // still never to superintendent Nick REYES — the surname token is what rules Reyes out.
    ["Nick Cheaham", ["Nick Cheatam"]],
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
    // Rule 13 through the noise treatment: still Cheatam, still never Reyes.
    expect(names(sup("Nick Cheaham (super)"))).toEqual(["Nick Cheatam"]);
  });
});

// ── Role is a preference, not a filter ─────────────────────────────────────────────────────────────────
// Adnaan's correction: "Nick Cheaham" IS Nick Cheatam. He is a project_manager and that text sits in a
// card's SUPERINTENDENT field, so the field a name was typed into is not evidence of the role the person
// holds — and filtering candidates by role turned a resolvable recipient into a card that reached nobody.
//
// Removing the filter costs no safety, because the every-token rule is what protects identity: "cheaham"
// vs "cheatam" is distance 1, while "cheaham" vs "reyes" is far outside every threshold in either
// direction. The wrong-Nick outcome the filter was credited with preventing was never reachable by the rule.
describe("role preference", () => {
  const sup = (text: string) =>
    matchFieldResponders({ text, role: "superintendent", roster: DALLAS_ROSTER });

  it("flags a cross-role match so the caller writes the person to the RIGHT responder column", () => {
    // This is the load-bearing assertion of the whole change. recipientResolutionSql joins
    // `fr.role = 'superintendent' AND fr.id = sc.superintendent_responder_id`, so putting Cheatam's id in
    // the superintendent slot resolves to NOBODY — the same silent dead end, one step further along.
    const [match] = sup("Nick Cheaham").matches;
    expect(match.responder.name).toBe("Nick Cheatam");
    expect(match.responder.role).toBe("project_manager");
    expect(match.roleMatchesQuery).toBe(false);
  });

  it("reports roleMatchesQuery true for an ordinary in-role match", () => {
    const [match] = sup("Brett Bell").matches;
    expect(match.responder.role).toBe("superintendent");
    expect(match.roleMatchesQuery).toBe(true);
  });

  it("PREFERS the queried role when the same name exists in both", () => {
    // Two real humans who share a name across the two roles is the one case the old filter genuinely
    // handled. Preference keeps that: the superintendent wins a superintendent query, and vice versa.
    const bothRoles = [
      ...DALLAS_ROSTER,
      { id: "pm-brett-bell", name: "Brett Bell", role: "project_manager", isActive: true, email: "pm.brett@trockgc.com" },
    ];
    const asSuper = matchFieldResponders({ text: "Brett Bell", role: "superintendent", roster: bothRoles });
    expect(asSuper.matches[0].responder.id).toBe("brett-bell");
    expect(asSuper.matches[0].roleMatchesQuery).toBe(true);

    const asPm = matchFieldResponders({ text: "Brett Bell", role: "project_manager", roster: bothRoles });
    expect(asPm.matches[0].responder.id).toBe("pm-brett-bell");
    expect(asPm.matches[0].roleMatchesQuery).toBe(true);
  });

  it("still refuses the WRONG person, cross-role search or not", () => {
    // The refusals that matter are unchanged — widening the candidate pool must not have widened these.
    expect(sup("Nick Cheahamm Reyes").matches).toEqual([]); // two surnames, one must go unaccounted
    expect(sup("Brett Sampley").matches).toEqual([]); // one person's first name, another's surname
    expect(sup("Addy").matches).toEqual([]); // nickname, now searched against the PM roster too
    expect(sup("Adnaan Iqbal").matches).toEqual([]); // inactive is STILL absolute
  });

  it("never resolves an INACTIVE person even though role no longer filters", () => {
    // Widening the pool must not have widened this one. Inactive is the only absolute left.
    const onlyInactive = [{ id: "x", name: "Adnaan Iqbal", role: "project_manager", isActive: false, email: "x@y.z" }];
    expect(matchFieldResponders({ text: "Adnaan Iqbal", role: "superintendent", roster: onlyInactive }).matches).toEqual([]);
  });
});

// ── Review findings on the noise-stripping and comma handling ──────────────────────────────────────────
// Three wrong-recipient defects and one resource defect, all introduced by the identity-neutral-noise strip
// and the comma delimiter. Reproduced before fixing, each pinned here.
describe("review findings", () => {
  const sup = (text: string) =>
    matchFieldResponders({ text, role: "superintendent", roster: DALLAS_ROSTER });
  const pm = (text: string) =>
    matchFieldResponders({ text, role: "project_manager", roster: DALLAS_ROSTER });
  const names = (r: { matches: Array<{ responder: { name: string } }> }) =>
    r.matches.map((m) => m.responder.name);

  it("does NOT strip a PARENTHESISED generational suffix", () => {
    // The blanket /\([^)]*\)/ strip deleted "(Jr)" and produced an EXACT match for the senior Brett Bell —
    // removing the one token that distinguishes two family members. The parenthetical pattern is now an
    // enumerated role list, so an unrecognised parenthetical survives as a token and fails every-token.
    expect(sup("Brett Bell (Jr)").matches).toEqual([]);
    expect(sup("Brett Bell (II)").matches).toEqual([]);
    expect(sup("Brett Bell (Sr)").matches).toEqual([]);
    // The role annotations it exists for still strip.
    expect(names(pm("Adam Sherwood (PM)"))).toEqual(["Adam Sherwood"]);
    expect(names(sup("Brett Bell (superintendent)"))).toEqual(["Brett Bell"]);
  });

  it("does not let a surname-first comma become TWO wrong people", () => {
    // "Bell, Robert" split into "Bell" -> Brett Bell (only Bell) and "Robert" -> Robert Sampley (only
    // Robert): two recipients, neither of them the person named, with nothing unmatched to signal it.
    // A comma now separates people only when a side carries more than one token.
    expect(sup("Bell, Robert").matches).toEqual([]);
    // Verbatim, comma included — the recombined "Bell Robert" is the form that gets SCORED, not reported.
    expect(sup("Bell, Robert").unmatched).toEqual(["Bell, Robert"]);
    // The surname-first form for someone who IS on the roster still resolves, as one person.
    expect(names(sup("Sampley, Robert"))).toEqual(["Robert Sampley"]);
    // And a genuine two-person comma list is untouched.
    expect(names(sup("Brett Bell, Robert Sampley"))).toEqual(["Brett Bell", "Robert Sampley"]);
  });

  it("does not let a role annotation manufacture a bare first name that resolves to the wrong Nick", () => {
    // "Nick - PM" had its annotation stripped to bare "Nick", which then matched Nick REYES because he is
    // the only Nick with the queried role — the exact opposite of what the annotation said. A lone token
    // must be unique across the WHOLE roster, so two Nicks make it ambiguous instead.
    expect(sup("Nick - PM").matches).toEqual([]);
    expect(sup("Nick - PM").ambiguous).toHaveLength(1);
    expect(sup("Nick").matches).toEqual([]);
    expect(sup("Nick").ambiguous[0].candidates.map((c) => c.name).sort()).toEqual([
      "Nick Cheatam",
      "Nick Reyes",
    ]);
    // A first name unique across the roster still resolves — the rule is uniqueness, not token count.
    expect(names(sup("Brett"))).toEqual(["Brett Bell"]);
    expect(names(pm("Adam"))).toEqual(["Adam Sherwood"]);
    // And the full-name form of the ambiguous first name is not ambiguous at all.
    expect(names(sup("Nick Cheaham"))).toEqual(["Nick Cheatam"]);
    expect(names(sup("Nick Reyes"))).toEqual(["Nick Reyes"]);
  });

  it("rejects an oversized token in constant time instead of allocating a matrix per character", () => {
    // superintendent_name / pm_name are unbounded text columns and the submission parser caps the NUMBER of
    // fields, never their length, so a pasted blob is persistable and reaches the matcher in a worker or
    // backfill. The old full matrix allocated one array per character of the token.
    // Measured RELATIVE to a small-input baseline rather than against a fixed wall clock: an absolute
    // millisecond bound is a CI flake waiting to happen on a loaded runner, and it would not actually be
    // testing the property we care about. The property is COMPLEXITY — a 200k token must not cost
    // meaningfully more than a short one, because the length-difference bail rejects it before any distance
    // work. Quadratic behaviour blows through this by orders of magnitude; scheduler noise does not.
    const blob = `Brett ${"x".repeat(200_000)}`;
    const baselineStart = Date.now();
    for (let i = 0; i < 50; i++) sup("Brett Bellington");
    const baseline = Math.max(Date.now() - baselineStart, 1);

    const started = Date.now();
    expect(sup(blob).matches).toEqual([]);
    expect(Date.now() - started).toBeLessThan(baseline * 50);
  }, 30_000);

  it("keeps nameEditDistance exact after the two-row rewrite", () => {
    // The calibration points, re-asserted against the new implementation — a memory optimisation that
    // changed any of these would silently retune every threshold.
    expect(nameEditDistance("cheatham", "cheatam")).toBe(1);
    expect(nameEditDistance("chatham", "cheatam")).toBe(2);
    expect(nameEditDistance("addy", "adam")).toBe(2);
    expect(nameEditDistance("sanders", "sanchez")).toBe(4);
    // Symmetric, and the argument swap inside must not change the answer.
    expect(nameEditDistance("cheatam", "chatham")).toBe(2);
    expect(nameEditDistance("", "bell")).toBe(4);
    expect(nameEditDistance("bell", "bell")).toBe(0);
  });
});

// ── Second review round: eight findings, all reproduced before fixing ──────────────────────────────────
// Five were wrong-recipient defects. They cluster on one theme: each of my earlier fixes was correct in
// isolation and wrong in combination with another — role preference vs confidence ranking, the bare-token
// rule vs confidence ranking, the comma rule vs a mixed list, the active filter vs an exact inactive hit.
describe("second review round", () => {
  const R = (id: string, name: string, role: string, isActive = true) => ({ id, name, role, isActive });
  const go = (text: string, role: string, roster: ReturnType<typeof R>[]) =>
    matchFieldResponders({ text, role, roster });
  const names = (r: { matches: Array<{ responder: { name: string } }> }) =>
    r.matches.map((m) => m.responder.name);

  it("ranks CONFIDENCE before role — role only breaks an equal-confidence tie", () => {
    // Filtering to the queried role first discarded a stronger identification: the exact PM was thrown away
    // in favour of a HIGH in-role partial. Role cannot outrank evidence when the premise of this whole
    // matcher is that the field's role is unreliable.
    const roster = [R("pm", "Robert Bell", "project_manager"), R("sup", "Robert Allen Bell", "superintendent")];
    const r = go("Robert Bell", "superintendent", roster);
    expect(names(r)).toEqual(["Robert Bell"]);
    expect(r.matches[0].confidence).toBe("exact");
    expect(r.matches[0].roleMatchesQuery).toBe(false);
  });

  it("still lets role break a tie at EQUAL confidence", () => {
    const roster = [R("pm", "Brett Bell", "project_manager"), R("sup", "Brett Bell", "superintendent")];
    expect(go("Brett Bell", "superintendent", roster).matches[0].responder.id).toBe("sup");
    expect(go("Brett Bell", "project_manager", roster).matches[0].responder.id).toBe("pm");
  });

  it("keeps a BARE token ambiguous whenever more than one person scores, whatever the confidence", () => {
    // Retaining all candidates was not enough: the confidence ranking still picked one outright, so a bare
    // "Nick" resolved to a PM mononym on exact-beats-high while superintendent Nick Reyes matched too. With
    // one token there is no second token to arbitrate, so any contest is ambiguous.
    const roster = [R("mono", "Nick", "project_manager"), R("reyes", "Nick Reyes", "superintendent")];
    const r = go("Nick", "superintendent", roster);
    expect(r.matches).toEqual([]);
    expect(r.ambiguous[0].candidates.map((c) => c.id).sort()).toEqual(["mono", "reyes"]);
  });

  it("does not reinterpret single-token comma pieces because a LATER piece has a full name", () => {
    // The global any-multi-token test split every piece of "Bell, Robert, Adam Sherwood", so the
    // surname-first "Bell, Robert" became two wrong recipients again. Pairing is decided pairwise.
    const roster = [
      R("bbell", "Brett Bell", "superintendent"),
      R("rsampley", "Robert Sampley", "superintendent"),
      R("asherwood", "Adam Sherwood", "project_manager"),
    ];
    const r = go("Bell, Robert, Adam Sherwood", "superintendent", roster);
    expect(names(r)).toEqual(["Adam Sherwood"]);
    expect(r.unmatched).toEqual(["Bell, Robert"]);
  });

  it("lets an EXACT inactive hit block a weaker active alternative", () => {
    // Filtering inactive rows out before scoring turned an exact identification of a former employee into a
    // fuzzy match for a different, current one — who would have received someone else's corrective action.
    const roster = [R("old", "John Smith", "superintendent", false), R("new", "John Smyth", "superintendent")];
    const r = go("John Smith", "superintendent", roster);
    expect(r.matches).toEqual([]);
    expect(r.unmatched).toEqual(["John Smith"]);
    // An equally exact ACTIVE namesake does not simply win either — that is a real doubt, not a weaker
    // alternative, so it surfaces as AMBIGUOUS for a human rather than resolving silently.
    const both = [...roster, R("exact", "John Smith", "project_manager")];
    const tie = go("John Smith", "superintendent", both);
    expect(tie.matches).toEqual([]);
    expect(tie.ambiguous).toHaveLength(1);
  });

  it("reports matchedText and unmatched VERBATIM, annotations included", () => {
    // The contract says verbatim, and a human triaging a backfill has to see the text that drove the
    // decision. Reporting the noise-stripped copy hid the annotation entirely.
    const roster = [R("bbell", "Brett Bell", "superintendent"), R("asherwood", "Adam Sherwood", "project_manager")];
    expect(go("Mr. Brett Bell", "superintendent", roster).matches[0].matchedText).toBe("Mr. Brett Bell");
    expect(go("Adam Sherwood (PM)", "project_manager", roster).matches[0].matchedText).toBe("Adam Sherwood (PM)");
    expect(go("Addy (PM)", "project_manager", roster).unmatched).toEqual(["Addy (PM)"]);
  });

  it("upgrades a duplicated recipient to its STRONGEST confidence, whatever the word order", () => {
    // "Brett/Brett Bell" returned high and "Brett Bell/Brett" returned exact, so a caller gating auto-send
    // on the full-name tier accepted or rejected the same field purely on segment order.
    const roster = [R("bbell", "Brett Bell", "superintendent")];
    for (const text of ["Brett/Brett Bell", "Brett Bell/Brett"]) {
      const r = go(text, "superintendent", roster);
      expect(names(r)).toEqual(["Brett Bell"]);
      expect(r.matches[0].confidence).toBe("exact");
    }
  });

  it("matches a punctuationless spelling of a hyphenated or apostrophised name", () => {
    // The contract claims punctuation-insensitivity, but turning every punctuation run into a boundary meant
    // the joined spelling could account for neither half and the real person went unmatched.
    expect(names(go("MaryJane Smith", "superintendent", [R("mj", "Mary-Jane Smith", "superintendent")])))
      .toEqual(["Mary-Jane Smith"]);
    expect(names(go("Mary Jane Smith", "superintendent", [R("mj", "Mary-Jane Smith", "superintendent")])))
      .toEqual(["Mary-Jane Smith"]);
    expect(names(go("John ONeil", "superintendent", [R("on", "John O'Neil", "superintendent")])))
      .toEqual(["John O'Neil"]);
    expect(names(go("John O'Neil", "superintendent", [R("on", "John O'Neil", "superintendent")])))
      .toEqual(["John O'Neil"]);
    // Adjacent parts only — joining must not staple together unrelated ones.
    expect(go("SmithMary Jane", "superintendent", [R("mj", "Mary-Jane Smith", "superintendent")]).matches)
      .toEqual([]);
  });
});

// ── Third review round ─────────────────────────────────────────────────────────────────────────────────
// Both are interactions BETWEEN earlier fixes, which is now the recurring shape of every defect in this
// file: the comma rule vs the annotation stripper, and the punctuation normalizer vs the character class
// that follows it.
describe("third review round", () => {
  const R = (id: string, name: string, role: string, isActive = true) => ({ id, name, role, isActive });
  const go = (text: string, role: string, roster: ReturnType<typeof R>[]) =>
    matchFieldResponders({ text, role, roster });
  const names = (r: { matches: Array<{ responder: { name: string } }> }) =>
    r.matches.map((m) => m.responder.name);
  const DALLAS = [
    R("bbell", "Brett Bell", "superintendent"),
    R("rsampley", "Robert Sampley", "superintendent"),
    R("asherwood", "Adam Sherwood", "project_manager"),
  ];

  it("counts comma pieces on the STRIPPED text, so an annotation cannot fake a second name token", () => {
    // "Robert (PM)" read as two tokens, so the comma was classed as a people delimiter and the surname-first
    // pair split back into Brett Bell + Robert Sampley — the same two wrong recipients, reached this time
    // through the annotation stripper rather than around it.
    for (const text of ["Bell, Robert (PM)", "Bell, Robert - PM", "Bell (super), Robert"]) {
      const r = go(text, "superintendent", DALLAS);
      expect(r.matches).toEqual([]);
    }
    // The genuine two-person list is still split, annotations and all.
    expect(names(go("Brett Bell, Adam Sherwood (PM)", "superintendent", DALLAS)))
      .toEqual(["Brett Bell", "Adam Sherwood"]);
  });

  it("FOLDS diacritics instead of deleting the letter", () => {
    // The [^a-z0-9] class deleted the accented character outright, so "josé" became "jos" — a DIFFERENT
    // person's entire name. On a roster holding "Jos Smith" that was an exact match for the wrong human,
    // and the ordinary ASCII spelling anyone would type matched nobody at all.
    const accented = [R("jose", "José Smith", "superintendent")];
    expect(names(go("José Smith", "superintendent", accented))).toEqual(["José Smith"]);
    expect(names(go("Jose Smith", "superintendent", accented))).toEqual(["José Smith"]);

    // And the collision it caused is gone: two genuinely different people stay different.
    const both = [R("jose", "José Smith", "superintendent"), R("jos", "Jos Smith", "superintendent")];
    expect(names(go("José Smith", "superintendent", both))).toEqual(["José Smith"]);
    expect(names(go("Jos Smith", "superintendent", both))).toEqual(["Jos Smith"]);
    // The accented spelling must NOT reach the unaccented person when only they are on the roster.
    expect(go("José Smith", "superintendent", [R("jos", "Jos Smith", "superintendent")]).matches).toEqual([]);
  });

  it("normalizes other common diacritics both directions", () => {
    for (const [rosterName, typed] of [
      ["Renée Dubois", "Renee Dubois"],
      ["Nuñez Garcia", "Nunez Garcia"],
      ["Müller Schmidt", "Muller Schmidt"],
      ["Åke Larsson", "Ake Larsson"],
    ] as const) {
      const roster = [R("x", rosterName, "superintendent")];
      expect(names(go(typed, "superintendent", roster))).toEqual([rosterName]);
      expect(names(go(rosterName, "superintendent", roster))).toEqual([rosterName]);
    }
  });
});

// ── Fourth review round ────────────────────────────────────────────────────────────────────────────────
// Five more, and the shape has not changed: every one is an INTERACTION with, or an incomplete case of, a
// fix from an earlier round. Three of them are wrong-recipient defects that the earlier fix introduced.
describe("fourth review round", () => {
  const R = (id: string, name: string, role: string, isActive = true) => ({ id, name, role, isActive });
  const go = (text: string, role: string, roster: ReturnType<typeof R>[]) =>
    matchFieldResponders({ text, role, roster });
  const names = (r: { matches: Array<{ responder: { name: string } }> }) =>
    r.matches.map((m) => m.responder.name);
  const DALLAS = [
    R("bbell", "Brett Bell", "superintendent"),
    R("rsampley", "Robert Sampley", "superintendent"),
  ];

  it("does not let an annotation-only comma piece take part in surname-first pairing", () => {
    // An empty normalized piece still splits to a one-element array, so "(PM)" counted as one token and
    // paired with "Bell", leaving "Robert" to stand alone: Brett Bell + Robert Sampley, two people neither
    // of whom was named. Nameless pieces are dropped before pairing.
    expect(go("Bell, (PM), Robert", "superintendent", DALLAS).matches).toEqual([]);
    expect(go("Bell, (super), Robert", "superintendent", DALLAS).matches).toEqual([]);
    // A real two-person list with an annotation on one of them still splits.
    const withPm = [...DALLAS, R("asherwood", "Adam Sherwood", "project_manager")];
    expect(names(go("Brett Bell, Adam Sherwood (PM)", "superintendent", withPm)))
      .toEqual(["Brett Bell", "Adam Sherwood"]);
  });

  it("counts INACTIVE people in a bare token's contest", () => {
    // They stay non-returnable, but a lone token cannot say which person who answers to it was meant.
    // Narrowing silently to the active ones handed a former employee's corrective action to a colleague.
    const roster = [R("old", "John Smith", "superintendent", false), R("new", "John Smyth", "superintendent")];
    const r = go("John", "superintendent", roster);
    expect(r.matches).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    // A bare token matching only an inactive person is unresolved, not a match.
    expect(go("John", "superintendent", [R("old", "John Smith", "superintendent", false)]).matches).toEqual([]);
  });

  it("folds letters NFD does not decompose, instead of deleting them", () => {
    // NFD leaves đ / ø / ł intact — the diacritic is a stroke, not a combining mark — so the ASCII class
    // deleted the letter and "Đan Nguyen" became "an nguyen": an EXACT match for a different person.
    expect(go("Đan Nguyen", "superintendent", [R("an", "An Nguyen", "superintendent")]).matches).toEqual([]);
    for (const [rosterName, typed] of [
      ["Søren Smith", "Soren Smith"],
      ["Đan Nguyen", "Dan Nguyen"],
      ["Łukasz Nowak", "Lukasz Nowak"],
      ["Ægir Olsen", "Aegir Olsen"],
    ] as const) {
      const roster = [R("x", rosterName, "superintendent")];
      expect(names(go(typed, "superintendent", roster))).toEqual([rosterName]);
      expect(names(go(rosterName, "superintendent", roster))).toEqual([rosterName]);
    }
  });

  it("joins tokens ONLY across a boundary punctuation created", () => {
    // Joining any adjacent pair let bare "Annabell" consume both parts of "Ann Abell" for an exact match on
    // someone never named. A space between two names is a real boundary; a hyphen inside one is not.
    expect(go("Annabell", "superintendent", [R("aa", "Ann Abell", "superintendent")]).matches).toEqual([]);
    expect(go("MarySmith", "superintendent", [R("ms", "Mary Smith", "superintendent")]).matches).toEqual([]);
    expect(go("BrettBell", "superintendent", DALLAS).matches).toEqual([]);
    // The hyphenated case the join exists for still works, both spellings.
    const hyphen = [R("mj", "Mary-Jane Smith", "superintendent")];
    expect(names(go("MaryJane Smith", "superintendent", hyphen))).toEqual(["Mary-Jane Smith"]);
    expect(names(go("Mary Jane Smith", "superintendent", hyphen))).toEqual(["Mary-Jane Smith"]);
  });

  it("refuses to parse an absurd field as a name list rather than scoring every piece", () => {
    // "x/" a few hundred thousand times materialised that many segments and scored each against every roster
    // row. Refusing the whole field beats parsing the first N: a truncated read of a name list is a silent
    // half-answer. The single unmatched entry is excerpted, because echoing the blob is the same problem.
    const blob = "x/".repeat(200_000);
    const r = go(blob, "superintendent", DALLAS);
    expect(r.matches).toEqual([]);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].length).toBeLessThan(200);
    expect(r.unmatched[0]).toContain("not parsed as names");
    // A long single value is refused the same way, and a normal two-person field is untouched.
    expect(go("Brett ".repeat(400), "superintendent", DALLAS).matches).toEqual([]);
    expect(names(go("Brett Bell/Robert Sampley", "superintendent", DALLAS)))
      .toEqual(["Brett Bell", "Robert Sampley"]);
  });
});

// ── Fifth review round ─────────────────────────────────────────────────────────────────────────────────
describe("fifth review round", () => {
  const R = (id: string, name: string, role: string, isActive = true) => ({ id, name, role, isActive });
  const go = (text: string, role: string, roster: ReturnType<typeof R>[]) =>
    matchFieldResponders({ text, role, roster });
  const names = (r: { matches: Array<{ responder: { name: string } }> }) =>
    r.matches.map((m) => m.responder.name);

  it("blocks an inactive person at the BEST tier, not only on an exact hit", () => {
    // The exact-only rule left the fuzzy tie open: "John Smath" scored inactive "John Smith" and active
    // "John Smyth" equally at high, and dropping the inactive one returned Smyth cleanly — a former
    // employee's corrective action sent to a current colleague.
    const roster = [R("old", "John Smith", "superintendent", false), R("new", "John Smyth", "superintendent")];
    const fuzzyTie = go("John Smath", "superintendent", roster);
    expect(fuzzyTie.matches).toEqual([]);
    expect(fuzzyTie.ambiguous).toHaveLength(1);

    // An ACTIVE exact still beats an INACTIVE high — then the inactive is not at the best tier at all.
    const clear = [R("old", "Jon Smith", "superintendent", false), R("new", "John Smith", "superintendent")];
    expect(names(go("John Smith", "superintendent", clear))).toEqual(["John Smith"]);
  });

  it("preserves a letter no transliteration map reached", () => {
    // The map can only ever cover the letters someone thought of. Azerbaijani "Ə" (U+0259) was outside it,
    // so the ASCII-only class deleted it and "Əli Smith" became "li smith": an EXACT match for an unrelated
    // roster member named Li Smith. Keeping the letter makes the worst case a MISS, which is the safe side.
    expect(go("Əli Smith", "superintendent", [R("li", "Li Smith", "superintendent")]).matches).toEqual([]);
    // And the person themselves still resolves.
    expect(names(go("Əli Smith", "superintendent", [R("e", "Əli Smith", "superintendent")]))).toEqual(["Əli Smith"]);
    // A few more scripts, to prove nothing is being silently dropped.
    for (const name of ["Ægir Olsen", "Đan Nguyen", "Łukasz Nowak", "Øyvind Berg"]) {
      expect(names(go(name, "superintendent", [R("x", name, "superintendent")]))).toEqual([name]);
    }
  });

  it("reports the ORIGINAL comma span, not the recombined scoring form", () => {
    const D = [R("bbell", "Brett Bell", "superintendent"), R("rsampley", "Robert Sampley", "superintendent")];
    // Scored as "Sampley Robert"; reported as typed.
    expect(go("Sampley, Robert", "superintendent", D).matches[0].matchedText).toBe("Sampley, Robert");
    expect(go("Bell, Robert", "superintendent", D).unmatched).toEqual(["Bell, Robert"]);
  });
});
