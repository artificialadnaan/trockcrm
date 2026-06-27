# T Rock AI — demo materials

A password-gated viewer asks open-ended questions about **Dallas** CRM data and gets answers + charts,
with **every number computed by SQL, never by the model** (charts are deterministically gated; prose
has a no-grounding backstop). The model reaches the data only through a scoped, read-only MCP server.

## The tools it has (and only these)

| Tool | Returns | Notes for framing |
|---|---|---|
| `get_pipeline_summary(preset)` | `Won / Active / Stalled` rows — each `{segment, count, value}` | `preset` = `mtd \| qtd \| ytd \| last_90d \| all` (default `ytd`). **Won** is windowed by `won_closed_date`; **Active** = open (non-terminal) deals; **Stalled** = the at-risk watchlist (open deals with a missing/past close date) and is a **subset of Active**, not additive. All three are SQL aggregates. |
| `list_deals(stage?, owner?, minValue?, maxValue?, closeDateFrom?, closeDateTo?, limit?)` | `{ rows[], totalMatching, returned, truncated }` | A page of individual deals, **ordered by value (highest first)**, max 25 (cap 100). `totalMatching` is a real SQL `COUNT(*)` of all matches; `truncated` flags a capped page. `stage:"won"` = the canonical Won family. Value = awarded-first best estimate. |
| `get_bid_award_variance` | Per-rep bid→award variance: `n`, `avg`, `median`, `std-dev`, dollar magnitude, a `lowSample` flag (`n<5`), and a coverage caption | The marquee analytic. The caption + `lowSample` exist so a small-sample rep is framed honestly. |
| `describe_capabilities` | What the demo can and cannot answer | The **honest-decline** tool — the model calls it when a question may be out of scope, then answers truthfully instead of fabricating. |

**Not built (the model declines these honestly):** margins / profitability / cost, multi-office or
company-wide (this demo is **single-tenant Dallas**), forecasts / projections, email correspondence
(deliberately excluded — PII), per-rep activity timelines, deal-detail timelines, contacts, photos.

**Charts:** the model emits a number-free Vega-Lite skeleton; the server injects the tool's verbatim
rows as the data. `aggregate`/`timeUnit` are stripped, so a chart can only plot rows a tool already
returned — chart-friendly shapes are the pipeline segments, variance-by-rep, and top-N deals by value.

---

## A. Question bank

Grouped by what each exercises. **Tool** = what it should call; **Strong answer** = what "good" looks like.

### 1. Clean wins — guaranteed-solid openers
1. **"What's our Won pipeline this year — how many deals and how much revenue?"**
   · Tool: `get_pipeline_summary` (ytd) · Strong: a Won count + Won revenue, stated as coming from the data; offers Active/Stalled for context.
2. **"How does Won compare to what's still active and what's stalled?"**
   · Tool: `get_pipeline_summary` · Strong: all three segments; explicitly notes Stalled is a *subset* of Active (a risk lens), not additive.
3. **"What's our Won revenue in the last 90 days?"**
   · Tool: `get_pipeline_summary` (last_90d) · Strong: the windowed Won figure; names the window.
4. **"How many open deals do we have and what are they worth?"**
   · Tool: `get_pipeline_summary` (Active) · Strong: Active count + value; distinguishes from Won.

### 2. Comparisons — show it reasons across windows
5. **"Compare our Won revenue this quarter vs the last 90 days."**
   · Tool: `get_pipeline_summary` (qtd, then last_90d) · Strong: two windowed calls, both numbers, a plain-language delta (no invented %).
6. **"Is most of our pipeline value Won, active, or stuck?"**
   · Tool: `get_pipeline_summary` · Strong: compares the three values; calls out concentration.
7. **"How much of our active pipeline is at risk (stalled)?"**
   · Tool: `get_pipeline_summary` · Strong: Stalled value as a share of Active, framed as the risk lens.

### 3. Deal lists — concrete, drill-in
8. **"List our largest deals by value."**
   · Tool: `list_deals` (default sort) · Strong: top rows with stage + owner; mentions `totalMatching` if truncated.
9. **"Show the biggest deals over $250k."**
   · Tool: `list_deals` (minValue) · Strong: filtered page; honest about the cap.
10. **"What are [rep]'s largest deals?"**
    · Tool: `list_deals` (owner) · Strong: that rep's deals by value; notes it's a page, not the full book, via `totalMatching`.
11. **"How many deals match — not just what's shown?"**
    · Tool: `list_deals` · Strong: uses `totalMatching` (the real SQL count), never the page length.

### 4. The marquee — bid-to-award variance
12. **"Which rep has the most bid-vs-award variance, and is it consistent or erratic?"** ⭐
    · Tool: `get_bid_award_variance` · Strong: names the rep, gives avg **and** median **and** std-dev to distinguish a consistent gap from an erratic one; flags any `lowSample` rep; reads the coverage caption.
13. **"Across the team, are we typically bidding over or under what we win?"**
    · Tool: `get_bid_award_variance` · Strong: direction + magnitude; honest that it's an average over deals with both numbers.
14. **"Which reps don't have enough data to judge their variance yet?"**
    · Tool: `get_bid_award_variance` · Strong: the `lowSample` (n<5) reps, named — shows it won't over-read thin data.

### 5. Chart-generating
15. **"Chart our Won / Active / Stalled pipeline by value."**
    · Tool: `get_pipeline_summary` + chart · Strong: a bar of the three segments; bar heights == the tool's verbatim values.
16. **"Give me a bar chart of bid-to-award variance by rep."** ⭐
    · Tool: `get_bid_award_variance` + chart · Strong: a per-rep bar; the wow moment — every bar is a SQL number, nothing computed in the browser.
17. **"Chart our top 10 deals by value."**
    · Tool: `list_deals` (limit 10) + chart · Strong: a bar per deal; values are verbatim rows.

### 6. Out-of-scope — honest decline (trust-builders)
18. **"What's our gross margin on Won deals?"**
    · Tool: `describe_capabilities` · Strong: declines — no margin/cost data — and says what it *can* show (revenue, counts) instead of guessing.
19. **"How does Dallas compare to Atlanta?"**
    · Tool: `describe_capabilities` · Strong: declines — single-tenant Dallas only — no fabricated cross-office numbers.
20. **"Forecast next quarter's revenue."**
    · Tool: `describe_capabilities` · Strong: declines a forecast (no projection tool); offers the historical Won windows it *can* compute.
21. **"Pull up the email thread with [client]."**
    · Tool: `describe_capabilities` · Strong: declines — correspondence isn't part of this demo — without inventing content.

---

## B. Demo script (~8–10 minutes)

The arc: **guaranteed-clean win → build to the variance-chart wow → honest decline as the trust close.**

1. **(0:00) Frame the guarantee (30s).** "Every number you see is computed by SQL on our live Dallas
   data — the model can't make one up. Watch the tool calls light up under each answer."
2. **(0:30) Clean win — Q1.** "What's our Won pipeline this year — how many deals and how much
   revenue?" Point at the tool-call strip: one `get_pipeline_summary` call, real rows. *Land the
   reliability point first.*
3. **(1:30) Add context — Q2.** "How does that compare to active and stalled?" Note Stalled is a
   subset of Active (a risk lens) — shows the model understands the data model, not just totals.
4. **(2:30) Comparison — Q5.** "Compare Won this quarter vs the last 90 days." Two windowed calls,
   a plain delta. *Shows reasoning across questions.*
5. **(3:30) Concrete drill — Q8/Q10.** "List our largest deals" → then "What are [rep]'s largest
   deals?" Mention `totalMatching` so the audience trusts the page isn't the whole story.
6. **(5:00) Marquee — Q12.** "Which rep has the most bid-vs-award variance, and is it consistent or
   erratic?" **Narrate the sample-size caption out loud:** "it's flagging [rep] as low-sample, so
   we won't over-read that one" — this is what makes a CFO trust the rest.
7. **(6:30) Wow — Q16.** "Now chart bid-to-award variance by rep." The chart renders; say plainly:
   "the model wrote the chart's shape, but every bar height came straight from SQL — it literally
   can't put a number on that chart the database didn't produce."
8. **(8:00) Trust close — Q18 or Q20.** "What's our gross margin?" / "Forecast next quarter." It
   **declines honestly** and offers what it can do. *For a CFO, honest 'I don't have that' beats a
   confident wrong number — close on that.*
9. **(8:30) One-liner on the roadmap (30s):** "Today it's pipeline + variance. Same pattern extends
   to correspondence, rep activity, deal timelines, and scheduled alerts — section C."

**Narration notes**
- Always point at the **tool-call strip** — the grounding is the story.
- For variance: say **median vs std-dev** ("consistent gap" vs "erratic") and read the `lowSample`
  flag. Never present a thin-sample rep as a finding.
- For charts: say "model wrote the *shape*, SQL wrote the *numbers*."
- If a number looks surprising, that's a CRM-data conversation, not a model error — the tool returns
  exactly what the database holds.

---

## C. How to make it more powerful

Prioritized. Effort is rough (S ≈ a day, M ≈ a few days, L ≈ a week+), all additive behind the same
SQL-only seam.

### Near-term tools (same pattern, high demo value)
1. **`get_deal_detail(dealId)`** — one deal with its `activities` + `deal_stage_history` timeline.
   *Effort: M.* Unlocks "walk me through how this deal progressed" — the natural drill-down after
   `list_deals`. Highest bang for the buck.
2. **`get_rep_activity(rep, window)`** — per-rep active time + action/view counts from the usage
   tracker + `activities`. *Effort: M.* Unlocks "how active has [rep] been?" and pairs with variance
   for a coaching narrative. (Tracker spine already exists.)
3. **`get_contacts_for_deal(dealId)`** — contacts/roles via the existing `getContactsForDeal`.
   *Effort: S.* Unlocks "who are the people on this deal?"
4. **Photos** — surface field/CompanyCam photo counts or links per deal (read-only). *Effort: M.*
   Visual proof points; pairs with deal detail.

### Correspondence (deliberately deferred — needs a policy)
5. **`list_email_threads` / `get_email_thread`** — the Outlook/Graph-synced correspondence.
   *Effort: M (tools) + policy.* Unlocks "what's the latest with [client]?" **Gate:** these carry
   full client email bodies (PII) and are never chartable — re-include only behind a redaction/scope
   policy and a clear consent decision. This is why they're out of v1.

### Bigger swings
6. **Scheduled trend-watching / alerts** — a Railway cron that runs the same analytics tools on a
   schedule and emails/Slacks deltas ("Won is down 20% vs last 90 days", "3 deals just went
   stalled"). *Effort: M–L.* Turns the demo from pull (ask) into push (it tells you) — reuses the
   exact SQL-only tools, so the guarantee carries over.
7. **Multi-office** — drop the hardcoded `office_dallas` and let the session token carry the office
   (the spine already validates an office allowlist). *Effort: M.* Unlocks Atlanta + company-wide
   once that data is wanted. **Gate:** confirm Atlanta data quality first (region/classification
   fields are sparser there).
8. **More analytics tools** — win-rate by region/stage, time-in-stage, concentration — each a SQL
   aggregate behind the seam. *Effort: S–M each.* Deepens the analyst story without weakening the
   guarantee.

**Guardrail for all of the above:** every new tool returns SQL-computed rows and is registered in
`ANALYTICS_TOOL_NAMES` only if its output is safe to chart. PII tools (email) stay off the chart path.
