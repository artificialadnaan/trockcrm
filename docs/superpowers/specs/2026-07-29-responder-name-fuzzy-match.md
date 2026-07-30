# Responder name fuzzy match — resolving typed scorecard names to the field-responder roster

Date: 2026-07-29
Implements: QC-D (name-to-responder mapping proposal for the backfill)
Unblocks: QC-C (make sure the PM is notified on a corrective action), QC-E (backfill the 4 below-band scorecards)
Code: `shared/src/lib/responderNameMatch.ts` · tests `shared/src/lib/responderNameMatch.test.ts` (75, green)

---

## 1. Why this exists

Corrective-action responders resolve from `field_scorecards.superintendent_responder_id` /
`pm_responder_id`. Those columns are set **only** when the submitter picked a roster row in the mobile
app's `ResponderPicker`. In practice almost nobody picks:

| Signal | office_dallas, 19 cards |
| --- | --- |
| Cards with a superintendent **pick** | 3 |
| Cards with a PM **pick** | **0** |
| `deal_team_members` rows (the only other fallback) | **0 office-wide** — see QC-F |

Both the pick and the fallback are empty, so a below-band card routinely opens a corrective action that
reaches **nobody**. Meanwhile the free-text `superintendent_name` / `pm_name` fields are filled in on 37
of 38 card-slots. The information is there; nothing reads it. This matcher is the last-resort fallback:
given the text that *was* typed, work out who on the roster was meant.

It lives in `shared/`, not beside the server-only `server/src/services/directoryDedup.ts`, because both
the **server** (resolving at read time) and the **worker** (addressing the oversight email) must answer
this question identically. Verified importable from both workspace roots through the built `dist`.

## 2. The safety constraint this inherits

`mobile/src/components/ResponderPicker.tsx:104` deliberately refuses to name-match, and says why:

> Typing is never a pick — always clear the recorded responder, even if the typed text happens to spell a
> roster member exactly. Name-matching is what made the earlier attempt at this feature able to email
> someone the user never chose.

**Matching too eagerly is a bug that has already shipped on this exact feature.** The two failure costs
are not symmetric:

- A **missed** match costs somebody a follow-up. The card shows an unresolved name; a human reads it.
- A **wrong** match emails a real person a corrective action that is not theirs.

So every rule is written to fail towards *unresolved*, and this matcher does **not** relax the picker's
rule — the picker still records `null`, and this runs strictly downstream as a resolution-time fallback
whose output a caller must be able to distrust. `ambiguous` and `unmatched` are the product, not noise.

### The one rule the whole matcher reduces to

> A segment matches a roster person only if **every** token in the segment is accounted for by a
> **distinct** part of that person's name, **at least one** of those accountings is **exact**, and **at
> most one** is fuzzy.

That rule decides whether a person *scores at all*. On top of it sit two arbitration invariants, and the
implementation has an explicit **bare-token branch** for the first — earlier drafts of this document claimed
there was none, and rebuilding from that claim would revive a wrong-recipient defect:

> **Bare-token uniqueness.** A segment that reads as ONE token resolves only if exactly one roster row scores —
> across **every** confidence tier, **both** roles, and **active and inactive alike**. Confidence must not
> arbitrate it (a PM mononym `Nick` scoring *exact* beat superintendent `Nick Reyes` scoring *high*, when
> both people plainly answer to the token), role must not (the slot is unreliable), and neither may active
> status (a bare `John` silently picked active `John Smyth` over inactive `John Smith`). With one token
> there is no second token to arbitrate, so **any** contest is ambiguous.
>
> "Reads as one token" covers the **punctuation-collapsed** reading, not just the plain whitespace split.
> `Mary-Jane` splits into two tokens but names one person, and routing it through full-name arbitration let
> it resolve `Mary-Jane Smith` outright while `MaryJane Jones` — who answers to exactly the same bare name —
> was passed over.

> **Meaningful anchor.** A match needs at least one EXACT accounting on identity-bearing text — two or
> more characters, and not a generational suffix. A one-character initial and a bare `Jr` each selected a
> real person on no personal-name evidence (`Q` → John Q Smith; `Jr` → the sole Brett Bell Jr), and an
> initial could anchor fuzz alongside another token (`Q Smyth` → John Q Smith, first name unspoken).

> **Roster suffixes are required, not optional.** A generational suffix in the ROSTER name must be spoken:
> `Brett Bell` does not resolve a roster holding only `Brett Bell Jr`, or a card for an absent senior
> reaches his son. Checked on the fuzzy and unfuzzed paths alike — guarding only one meant a single typo in
> the base name bypassed it.

> **Best-tier inactive blocking.** For a multi-token segment, if any INACTIVE row ties the best tier
> reached, the segment does not resolve — ambiguous when an active row ties it too, unmatched when the
> inactive row is alone there. An active *exact* still beats an inactive *high*, because the inactive is
> then not at the best tier at all.

> ⚠️ **`ambiguous[].candidates` MAY CONTAIN INACTIVE ROWS.** They are listed so a human can see the
> deactivated namesake that caused the doubt — they are **not selectable**. A caller rendering a picker
> must disable any candidate whose `isActive` is false, or it will hand a corrective action to a former
> employee by way of the very control added to prevent that.

> **The comma is NOT a person delimiter.** It writes one person surname-first (`Bell, Robert`,
> `De La Cruz, Robert`) and it could separate two (`Brett Bell, Robert Sampley`) — and those two shapes are
> identical token-for-token, as `De La Cruz, Mary Jane` (one person) versus `Brett Bell, Robert Sampley`
> (two) proves. Four successive heuristics tried to tell them apart and each shipped a wrong-recipient bug,
> so a comma-delimited run is now ONE person-span. **Accepted cost:** a genuine comma-separated list
> resolves to nobody and lands in `unmatched` for a human. It costs nothing on today's data — every real
> multi-person value uses `/` or `&`, which are unambiguous and still split.

Beyond the bare-token branch, the single rule subsumes the special cases:

- A bare first name is "one token, so it must be exactly right" — which is what makes `"Brett"` safe.
- An **unaccounted token is evidence against a match**, not neutral — which is what makes
  `"Nick Cheaham"` reach Nick Cheatam and never Nick Reyes. This is the whole distinction between
  the two, and §6 works it through.

## 3. Confidence tiers and what a caller must do with each

| Field | Meaning | Caller obligation |
| --- | --- | --- |
| `matches[].confidence === "exact"` | Every token accounted for exactly, whole name consumed | Safe to auto-address |
| `matches[].confidence === "high"` | One fuzzy token, or a bare name that left a surname unspoken | Safe to auto-address, but this is the tier to gate on if a surface ever wants full-name-only |
| `ambiguous[]` | Two or more equally-good people | **Never auto-address.** A human picks |
| `unmatched[]` | A segment named somebody the roster does not hold | Surface the raw text; may indicate a roster gap (§7) |

Four outcomes are distinguishable without re-parsing: blank field (`matches` and `unmatched` both
empty), nobody, one confident person, several candidates, and **partially resolved** — `matches`
populated *alongside* `ambiguous`/`unmatched`.

> **Trap for QC-C / QC-E.** `matches.length > 0` does **not** mean the field is fully resolved. A
> two-person field where only one name lands populates `matches` **and** `unmatched` together. Gating a
> backfill on `matches.length > 0` silently drops the second recipient. There is a test locking this
> shape (`"Brett Bell/Derek Barr"`). Today's corpus happens to have zero partial rows (§5), but the
> next card typed can create one.

**Role is a PREFERENCE, not a filter.** Which of the two name fields someone was typed into is not reliable
evidence of the role they hold — Adnaan confirmed that `"Nick Cheaham"`, sitting in a card's *superintendent*
field, is Nick Cheatam, a **project manager**. Filtering candidates by role made that unresolvable and the
card reached nobody.

1. The whole active roster is searched, and candidates are narrowed in this order:
   **confidence → best evidence → role.** `high` is a COARSE tier, so within it a distance-1 spelling is
   stronger evidence than a distance-2 one, and role — the signal this matcher documents as unreliable —
   must not override that. Role only ever breaks a tie between candidates already equal. Every match
   carries `roleMatchesQuery`.

   Reimplementing this as "confidence, then role" recreates a wrong-recipient defect: a distance-2 in-role
   spelling beat a distance-1 cross-role one, sending the corrective action to the wrong person purely
   because the text sat in a particular field.

   **"Best evidence" is TWO axes, not one number.** Spelling distance and *completeness* — how many parts of
   the roster name the segment left unspoken — are different kinds of doubt, and a candidate is discarded
   only when some rival is at least as good on **both** and better on one. Two candidates that each win an
   axis are incomparable and both survive to the role tie-break, or are reported ambiguous.

   Collapsing the two onto one number is a wrong-recipient defect: a partial match was scored distance 0, so
   for input `John Smith` the cross-role `John Allen Smith` (nothing misspelled, one name unspoken) beat the
   in-role `John Smyth` (whole name spoken, one letter out) and was auto-addressed — role and ambiguity never
   got a look.
1a. **An explicit role annotation outranks the field.** `"Alex Smith (PM)"` is a deliberate statement by the
   person filling in the card; the *slot* is the thing this matcher documents as unreliable. So the
   annotated role, not the queried one, is what breaks the tie at step 1. Stripping the annotation and
   falling back to the slot sent a superintendent-field `"Alex Smith (PM)"` to the superintendent — the one
   person the text explicitly said it did not mean.

   `roleMatchesQuery` still reports the **queried** role, because that is what tells the caller which column
   to write. The two must not be conflated.
2. **`is_active = false` is never returned as a `match`** — but inactive rows are still *scored*, because a hit on
   a deactivated person is a positive identification that must block a weaker active alternative. With
   inactive `John Smith` and active `John Smyth`, filtering the inactive row out early turned an exact
   identification of a former employee into a fuzzy match for a different, current one.

> ### Caller obligation — read this before writing anything
> When `roleMatchesQuery` is `false`, the **person is right and the slot is wrong**. Write them to the
> responder column for `responder.role`, *not* for the role you queried. `recipientResolutionSql` joins
> `fr.role = '<role>' AND fr.id = sc.<role>_responder_id`, so a PM's id in `superintendent_responder_id`
> resolves to nobody — the same silent dead end this matcher exists to remove, one step further along.

Removing the role filter costs no safety, and it is worth being precise about why: the **every-token rule**
protects identity, not the role filter. `cheaham`/`cheatam` is distance 1, while `cheaham` against
superintendent Nick **Reyes** is far outside every threshold in either direction — so the wrong-Nick outcome
the filter was credited with preventing was never reachable by the rule itself.

## 4. Thresholds and why each sits exactly there

Deliberately an **absolute distance ladder, not a similarity ratio**. A ratio is what would let `"Addy"`
become Adam Sherwood: distance 2 over 4 characters reads as a respectable 0.5, and any ratio loose
enough to accept the four real prod spellings of Cheatam is loose enough to accept that too.

| Constant | Value | Why not looser | Why not tighter |
| --- | --- | --- | --- |
| `FUZZY_MIN_TOKEN_LENGTH` | 5 | At 4 chars one edit separates two families — `Ball`/`Bell`. Below this, exact only | Nothing real needs it |
| `FUZZY_MAX_DISTANCE_SHORT` (len 5–6) | 1 | `Casey`/`Corey` is distance 2 at length 5 — a different name, not a typo | — |
| `FUZZY_MAX_DISTANCE_LONG` (len ≥7) | 2 | — | Rule 12 needs 2: `chatham`→`cheatam` is distance 2 |
| Distance measured on | `min(token, part)` | Measuring on the longer lets `Shane` reach `McShane`, or `bob` reach `robertson` | — |

Calibrated against one real person with four prod spellings, and against the pairs that must not
collapse:

```
cheatham / cheatum / cheatem  -> distance 1   accept
chatham                       -> distance 2   accept  <- forces LONG's cap to be 2
addy / adam                   -> distance 2 over 4 chars, below MIN -> exact-only -> reject
```

Both numbers are asserted directly in a `nameEditDistance` describe block, so whoever next tunes this
sees which distances the ladder stands between rather than guessing.

Multi-person fields split on `/ & + ;`, a newline, `w/`, and the word "and" — on the **raw** text before
normalization. Prod holds `"Brett Bell/Robert Sampley"`, `"Brett bell & Robert Sampley"` and
`"Brett/robert sampley"`, so two recipients from one field is normal and must come back **in the order
typed**.

**The comma is deliberately NOT in that list** — see the invariant above. A comma-delimited run is one
person-span, so `"Brett Bell, Robert Sampley"` returns **nobody** and lands in `unmatched`. Anyone
reimplementing from this section must not add it back.

### Levenshtein is single-copy

`server/src/services/directoryDedup.ts`'s private `similarity()` at ~line 428 is now a ratio wrapper
over the shared `nameEditDistance`; its own copy is **deleted**, not duplicated, with a comment at the
site pointing here. `directory-dedup.test.ts` still passes, so the lift is behaviour-preserving. This
codebase has been burned repeatedly by un-linked twin implementations.

`normalizeDirectoryName` was **not** reused, for two reasons: `shared` cannot import `server` (the
stated reason this module lives in shared), and it is actively wrong for this input — it rewrites `&` to
`" and "` and strips company suffixes, where here `&` is a **segment delimiter** and a person's surname
is not a suffix. Documented at both sites.

## 5. The resolved corpus

Every distinct free-text value in `office_dallas.field_scorecards`, run through the built matcher.
Reproduce with `node <scratchpad>/resolve-corpus.mjs` — it hardcodes the roster and corpus, no DB.
"cards" is how many card-slots carry that exact string (19 cards × 2 name fields = 38 slots).

| input                       | role            | cards | matched people + emails                                               | confidence   | ambiguous | unmatched    |
|-----------------------------|-----------------|-------|-----------------------------------------------------------------------|--------------|-----------|--------------|
| Adnaan Iqbal                | superintendent  | 3     | —                                                                     | —            | —         | Adnaan Iqbal |
| Kevin Posey                 | superintendent  | 3     | Kevin Posey <kposey@trockgc.com>                                      | exact        | —         | —            |
| Brett Bell                  | superintendent  | 2     | Brett Bell <bbell@trockgc.com>                                        | exact        | —         | —            |
| Eric Burnett                | superintendent  | 2     | Eric Burnett <eburnett@trockgc.com>                                   | exact        | —         | —            |
| Brett bell                  | superintendent  | 1     | Brett Bell <bbell@trockgc.com>                                        | exact        | —         | —            |
| Brett bell & Robert Sampley | superintendent  | 1     | Brett Bell <bbell@trockgc.com>; Robert Sampley <rsampley@trockgc.com> | exact; exact | —         | —            |
| Brett Bell/Robert Sampley   | superintendent  | 1     | Brett Bell <bbell@trockgc.com>; Robert Sampley <rsampley@trockgc.com> | exact; exact | —         | —            |
| Brett/robert sampley        | superintendent  | 1     | Brett Bell <bbell@trockgc.com>; Robert Sampley <rsampley@trockgc.com> | high; exact  | —         | —            |
| Chris Higingbotham          | superintendent  | 1     | Chris Higingbotham <chigingbotham@trockgc.com>                        | exact        | —         | —            |
| Corey mcshane               | superintendent  | 1     | Corey McShane <cmcshane@trockgc.com>                                  | exact        | —         | —            |
| Kevin posey                 | superintendent  | 1     | Kevin Posey <kposey@trockgc.com>                                      | exact        | —         | —            |
| Nick Cheaham                | superintendent  | 1     | Nick Cheatam <ncheatam@trockgc.com>                                   | high         | —         | —            |
| Nick Reyes                  | superintendent  | 1     | Nick Reyes <nreyes@trockgc.com>                                       | exact        | —         | —            |
| Adam Sherwood               | project_manager | 6     | Adam Sherwood <asherwood@trockgc.com>                                 | exact        | —         | —            |
| Nick Cheatham               | project_manager | 3     | Nick Cheatam <ncheatam@trockgc.com>                                   | high         | —         | —            |
| Nick Cheatum                | project_manager | 3     | Nick Cheatam <ncheatam@trockgc.com>                                   | high         | —         | —            |
| Addy                        | project_manager | 1     | —                                                                     | —            | —         | Addy         |
| Derek Barr                  | project_manager | 1     | —                                                                     | —            | —         | Derek Barr   |
| James helms                 | project_manager | 1     | —                                                                     | —            | —         | James helms  |
| Nick Chatham                | project_manager | 1     | Nick Cheatam <ncheatam@trockgc.com>                                   | high         | —         | —            |
| Nick Cheatem                | project_manager | 1     | Nick Cheatam <ncheatam@trockgc.com>                                   | high         | —         | —            |
| Test                        | project_manager | 1     | —                                                                     | —            | —         | Test         |
| (null)                      | project_manager | 1     | —                                                                     | —            | —         | —            |

```
distinct values: 23   card-slots: 38
fully resolved:      30 card-slots
partially resolved:  0 card-slots
resolved to nobody:  8 card-slots

recipients this yields (distinct people, superintendent + PM):
  ncheatam@trockgc.com             8 card-slot(s)
  bbell@trockgc.com                6 card-slot(s)
  asherwood@trockgc.com            6 card-slot(s)
  kposey@trockgc.com               4 card-slot(s)
  rsampley@trockgc.com             3 card-slot(s)
  eburnett@trockgc.com             2 card-slot(s)
  chigingbotham@trockgc.com        1 card-slot(s)
  cmcshane@trockgc.com             1 card-slot(s)
  nreyes@trockgc.com               1 card-slot(s)
```

**30 of 38 slots resolve, from 3 today.** Zero rows are ambiguous and zero are partial, so on today's
corpus every row is cleanly either a confident set of people or nobody — nothing needs a human tiebreak.
The nine misses are itemised below and **eight of the nine are correct refusals**, not coverage gaps.

**Nick Cheatam is the headline.** Four spellings across 8 card-slots all resolve to one person who,
before this, had **never** been resolvable — zero PM picks exist office-wide.

## 6. Inputs that deliberately do NOT resolve

| input | role | why it must not resolve |
| --- | --- | --- |
| `Adnaan Iqbal` (3) | superintendent | On the roster but **INACTIVE**. A deactivated person must not be emailed a corrective action. Inactive rows ARE scored — see the blocking invariant above — so an exact hit on one blocks a weaker active namesake instead of handing them somebody else's corrective action; nothing inactive is ever returned as a `match` |
| `Addy` (1) | project_manager | Must not become Adam Sherwood. 4 chars is below the fuzzy floor, so exact-only. Ratio-based matchers accept this (`Adam`/`Addy` = distance 2 over 4 chars ≈ 0.5) — that is why the ladder is absolute. **Worth noting: `Addy` reads as Adnaan's own nickname, not a shortening of Adam**, which would make an Adam Sherwood match not merely unsafe but wrong. Adnaan can confirm; either way it stays unresolved |
| `Derek Barr` (1) | project_manager | Real person, real CRM user, **not on the PM roster.** A roster gap, not a matching failure — see §7 |
| `James helms` (1) | project_manager | Same |
| `Test` (1) | project_manager | Test data |
| `(null)` (1) | project_manager | Empty. Returns the empty result, no throw. `""` and `"   "` likewise |

Judgement calls extending past the corpus, each locked as an explicitly-commented test rather than left
to chance — all erring toward *miss*:

| input | resolves to | reasoning |
| --- | --- | --- |
| `Addy Sherwood` | nobody | A corroborating exact surname does not make 4 chars carry 2 edits. The cost asymmetry says miss |
| `Brett Ball` | nobody | One edit at 4 chars separates two families |
| `Corey Shane` | nobody | Distance measured on the shorter token, so `Shane` cannot reach `McShane` |
| `Steve Sanders`, `Samply`, `Brett Bell Jr` | nobody | Surplus/insufficiently-anchored tokens |
| `Chris Higginbotham` | Chris Higingbotham, `high` | The spelling most people reach for, 2 edits. This is what the long cap buys |
| Bare first name, two holders in role | **ambiguous** | Covered with a synthetic roster, not left to prod happening to have no collision. Prod has superintendent Triston Mitchell while Timothy Mitchell is a CRM submitter, so bare `Mitchell` is exactly the shape that collides as the roster grows |

### Known limitation

`unmatched` does not distinguish "nobody by that name" from "that person is deactivated" — `Adnaan
Iqbal` and `Derek Barr` are indistinguishable in the output. Deliberate, to keep one code path for
"do not address this person", and harmless because a caller re-running against the unfiltered roster can
label the reason for display. Worth doing if the QC dashboard ever shows these to a human.

## 7. Follow-ups this surfaces

1. **Two PMs are missing from the roster.** Derek Barr and James Helms are real CRM users typed into
   `pm_name` who hold no `field_responders` row. Until added they are structurally unreachable — no
   matcher can fix that. One roster insert each.
2. **One card names a PM in its superintendent field** (the `Nick Cheaham` card). It now resolves to Nick
   Cheatam with `roleMatchesQuery: false`, so the backfill must write him to `pm_responder_id`. That card's
   *superintendent* remains genuinely unknown and cannot be inferred — it needs a human to read the card, not
   a looser threshold.
3. **QC-F stands.** This is a *fallback for existing text*, not a fix for the empty pick rate. New cards
   should still push submitters toward picking, or the free-text corpus keeps growing.

## 8. Verification

| Check | Result |
| --- | --- |
| `TZ=UTC npx vitest run shared/src/lib/responderNameMatch.test.ts` | **123 passed** — one case per numbered rule, plus a regression test per review finding, each named after the behaviour it protects |
| Shared CI gate config (`test:ci` — the one CI runs) | 29 files / **376 tests** passed, new suite included |
| `npm run check:premerge` (the full gate) | **6,770** server + 2,555 client + 502 worker + 376 shared, zero failures |
| Standalone adversarial harness (4 lenses) | **91 probes**, 0 failures |
| `npm run build --workspace shared`, `typecheck --workspace server`, `typecheck:tests --workspace shared` | clean |
| `server/tests` full run | 6586 passed; 3 pre-existing failures (`startup-order`, two `properties` consistency) unrelated — `directory-dedup.test.ts` passes |
| Importable from server **and** worker through built `dist` | executed from both roots, both returning `[["Brett Bell","high"],["Robert Sampley","exact"]]` for `"Brett/robert sampley"` |
| `shared/package.json` exports `./lib/responderNameMatch` | shape copied from `./lib/correctiveActionApprovers` / `./lib/correctiveActionOrder` |

**Mutation-tested, because 75/75 passing first try proves nothing.** 17 mutants; the first pass found
**four survivors** — the length floor, the exact-anchor rule, the short cap and the min-vs-max distance
basis were all unguarded (the `Addy` case dies at the floor, so it never exercised the caps). Five tests
added; **16/17 now die, each killed by the test named after that behaviour.** The one survivor,
`tokens.length > parts.length`, is a confirmed semantically-equivalent early-out — the every-token rule
rejects the same input anyway — so its comment was reworded to stop claiming to be the enforcer rather
than left in place lying.
