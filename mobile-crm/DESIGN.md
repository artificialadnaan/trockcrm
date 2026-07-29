---
name: T Rock CRM — mobile
description: The dark industrial system the iOS app ships. Diverges from the root DESIGN.md on purpose; this file records why, and what is binding.
platform: ios
mode: operate
---

# Design system: T Rock CRM (mobile)

## 0. Why this file exists

The repository root has a `DESIGN.md`. It describes the **web** client: a dark navy sidebar beside a
pale "concrete" content area, white cards, steel borders. That document is accurate about the web app
and actively wrong about this one, and two of its named rules are contradicted by what mobile ships:

- *"The Dark Alert Rule — dark navy belongs to the sidebar and strategic alert zones. Do not convert
  normal data cards into dark cards."* Every card in this app is a dark card.
- *"Don't use border-left or border-right greater than 1px as a colored side stripe on cards, list
  items, callouts, or alerts."* `DealCard`'s status rail is 3px.

Both divergences are deliberate and both are argued below. Until this file existed the argument lived
only in a docblock at the top of `src/theme/theme.ts`, which is not where anyone auditing the brand
looks. Design authority that describes a product you no longer ship stops being authority — the next
contributor either reverts the dark system or extends it by taste.

**Scope:** this file governs `mobile-crm/` only. The web client is still governed by the root file.
`mobile/` (T-Rock Cam) is a separate app with its own conventions; the two share a font pipeline and
nothing else.

## 1. The mandate: dark, because of where it is used

The web app is read at a desk. This app is read **on roofs, in trucks and in job trailers, by people
wearing gloves**, and it should look like equipment rather than a web dashboard someone shrank. The
palette is built out from the app icon — a red-and-white monogram on black — rather than from a light
default with the colours inverted.

That is the whole justification, and it is a usage-scene argument, not a taste argument. If the scene
changes, revisit it; until then, a mobile screen that arrives styled like the web app is the thing that
is out of place, not this.

**One practical consequence, learned the expensive way:** on a dark UI the contrast failure mode is
quieter than on white. Mid-greys look fine indoors and vanish in daylight. So every text token in
`theme.ts` carries its measured ratio against the surface it is meant for, in a comment, and
`src/__tests__/theme-contrast.test.ts` asserts the pairs **the app actually renders** rather than the
ones we meant to ship. A contrast test over intended combinations is a test of your intentions.

## 2. `theme.ts` is the only source of colour, type and spacing

`src/theme/theme.ts` is not a suggestion layer. Measured across `app/` and `src/components/`: **zero**
hard-coded colours in style values, **13** raw spacing literals (all 1–6pt hairlines) against 260
`theme.space.*` references, and zero `fontWeight`. That discipline is the reason the app could be turned
dark coherently in one change instead of leaving one redesigned screen beside twelve light ones.

Two rules that are not obvious from reading the token list:

**Red that fills is not red that types.** `brandRed` (#E01B24) is 3.7:1 on near-black — enough for a
fill or a rule, not enough for 13–15px text. `redText` (#FF8A8F) is 7.9:1 and is the *only* red allowed
to be type: back chevrons, retry labels, the Call action, inline errors. Splitting the two is what lets
the brand appear in a button, a chevron and the active tab without any of them failing contrast.

**Never re-point a token by name.** `textInverse` reads like "the inverse of the text colour". Its
actual meaning at every call site is "text on a brand fill", and pointing it at the canvas colour once
turned all ten primary buttons — including the login button, the first control anyone touches — into
near-black on red at ~3.2:1. Re-point by **call site**, never by what the name sounds like.

**Raw accents are not text.** `amber`, `blue` and `green` exist for charts, dots and rails. Their
text-safe partners are `amberText`, `redText`, `greenText`. A raw accent used as type can pass contrast
by luck, so no test will catch it; this is a rule you keep by reading it.

## 3. The type scale is binding

`theme.type` is: `display` 34 · `h1` 26 · `h2` 20 · `title` 17 · `body` 15 · `small` 13 regular ·
`label` 13 semibold · `caption` 11 semibold + tracking.

**Use a step. Do not write `fontSize`.** The scale exists because the old UI ran 12/13/14/15 everywhere
with bold-vs-semibold as the only emphasis, so a deal's name and its metadata carried nearly the same
weight and nothing on screen led.

`small` was added late, and its absence is most of why the scale went unadopted for so long: `label` is
13 **semibold** — a field name, something that introduces other content — and secondary prose at the
same size is 13 **regular**. With no such step the only options were `body` at 15, which makes a
subordinate line as large as the main one, or bolding an ordinary sentence. So screens wrote the literal
instead. A scale you have to leave in order to say an ordinary thing is not a scale anyone keeps.

**Named rules.**

- *Numbers lead.* A screen's headline metric uses `display` and the label explains it afterwards, not
  before. The board column total and the home screen's deal count are both this.
- *Caption is structure, not small text.* Uppercase tracked 11px reads as a deliberate label. It is for
  eyebrows, table headers and status chips — never for a sentence, and never for button text that needs
  fast recognition.
- *Uppercase is drawn by style and spoken by label.* `textTransform: "uppercase"` plus an explicit
  mixed-case `accessibilityLabel`, always. On iOS the transform is applied before the attributed string
  is built, so without the label VoiceOver reads the transformed text — "O-N H-O-L-D". Guarded by
  `src/__tests__/uppercase-text-has-accessible-label.test.ts`; the string form is banned outright by
  `no-rendered-touppercase.test.ts`.

**Known debt:** roughly 140 `fontSize` literals remain outside `theme.ts`, concentrated in the detail
screens and the move screen. They are debt, not precedent. Adding another is a regression.

## 4. Surfaces, elevation and the two exemptions

The surface ladder runs `chrome` (#000, nav bars and the tab bar) → `canvas` (the app background) →
`surfaceMuted` (recessed bands) → `surface` (cards, sheets, inputs) → `surfaceRaised` (a card on a card,
pressed states). Luminance is monotonic along that ladder, which is what makes "raised" legible without
a shadow.

**Exemption 1 — everything is a dark card.** The root file's Dark Alert Rule reserves dark surfaces for
the sidebar and alert zones, because on a pale web page a dark card is an interruption. Here there is no
pale page: the ladder above IS the hierarchy, and a light card would be the interruption. The rule
survives in spirit — `chrome` black is still reserved for navigation, and status tints are still
reserved for status.

**Exemption 2 — the 3px status rail.** The root file bans coloured side stripes above 1px because on the
web they are decoration. On a card in a column of twelve, read at arm's length in sunlight, the rail is
the only status encoding legible in peripheral vision — an 11px chip is not. It also encodes status as
**position and colour together**, which is the part a red/green colourblind rep can still use. Same
reasoning as `Badge`'s leading bar. This exemption is specifically about *status at card scale*; it does
not license coloured stripes as trim.

**Elevation is half a recipe.** A black shadow on a near-black canvas is nearly invisible, so separation
takes both a shadow and a lighter border, and the border does most of the work. `theme.elevation.*`
carries only the shadow half — spreading one without also setting a border is what made cards read as
flat rectangles.

## 5. Controls

**44pt, declared.** Every `Pressable` states `minHeight: 44` (or a height at least that) in its style.
Not computed, not estimated from padding plus a guess at the font's line box — *declared*, so it is
exact and visible in a diff. `hitSlop` is welcome and stacks, but it does not substitute: it enlarges the
touch region, and the thing a gloved rep aims at in sunlight is the drawn control. Guarded by
`src/__tests__/touch-targets-declare-a-floor.test.ts`.

**A disabled control says it is disabled.** `disabled` stops the press and changes nothing a screen
reader hears, so every `disabled` is paired with `accessibilityState={{ disabled }}` — plus `busy` when
a mutation is in flight. Guarded by `disabled-controls-announce-disabled.test.ts`. The visual signal
(`opacity: 0.5`) is not a signal to someone who cannot see it.

**One label for a card, or none of it is reachable.** An explicit `accessibilityLabel` on a grouping
Pressable *replaces* the text composed from its children. Anything left out becomes unreachable rather
than merely unannounced. Build the label from the same values the JSX renders, so a line hidden because
it is empty is absent from both.

**Say what changed.** For an outcome that changes what the user does next — a save committing, a write
halting on a duplicate — use `AccessibilityInfo.announceForAccessibility`. `accessibilityLiveRegion` is
Android-only and this app ships to iOS alone; `accessibilityRole="alert"` moves no focus. Key the
announcement on the message text so it fires once per distinct message and stays silent when there is
nothing to say.

**Platform controls where they exist.** Prefer the native date picker, action sheet and share sheet over
a hand-rolled equivalent. A text field asking for `YYYY-MM-DD` is a constraint that belongs in a control.

## 6. Copy

The app's voice is the brand line executed as behaviour: **say what is true, including when it is
inconvenient.**

- Report an indeterminate write as indeterminate. *"No signal — this may or may not have saved. Check
  the property's activity before logging it again."*
- Do not promise a workflow that does not exist. *"Marked as worth a lead. Follow up with the office —
  this doesn't reach them on its own yet."*
- Name the problem **and** the next action. An error that says only what failed is half an error.
- Use the rep's words, not the schema's. Stage slugs, activity types and enum values get mapped to
  labels before they reach a screen.
- Distinguish *never loaded* from *loaded and the refresh failed*. They are different situations and
  they get different UI — see `src/list-state.ts`.

## 7. Do / Don't

**Do**

- Reach for a `theme.type` step, a `theme.color.*` token and a `theme.space.*` value, in that order.
- Declare `minHeight: 44` on anything pressable.
- Pair every `textTransform: "uppercase"` with an `accessibilityLabel`.
- Put a decision that spans more than two pieces of state in a pure function next to its siblings in
  `src/prospect-state.ts` (or the equivalent) and test it, rather than deriving it in JSX.
- Keep one component per object. Two cards for one deal is a promise to keep them in sync; one card is
  a fact.

**Don't**

- Don't write a raw `fontSize`, colour literal, or `fontWeight`.
- Don't re-point an existing token by what its name sounds like. Add a new one.
- Don't use a raw accent (`amber`, `blue`, `green`) as text.
- Don't let `hitSlop` stand in for a declared floor.
- Don't uppercase a rendered string with `.toUpperCase()` — it destroys the mixed-case original at the
  source, and the accessible name cannot be recovered downstream.
- Don't spread `theme.elevation.*` without also setting a border.
