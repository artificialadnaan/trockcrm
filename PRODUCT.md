## Design Context

### Users
Construction company employees at T Rock Construction (commercial general contractor, DFW). Three roles:
- **Sales Reps**: In the field, on phones/tablets. Need fast data entry, pipeline visibility, deal tracking.
- **Directors**: Managing teams. Need dashboards, reports, rep performance at a glance.
- **Admins**: System config, data migration, user management.

Context: Used daily in offices and on job sites. Speed and clarity matter more than flashiness.

### Brand Personality
**Bold. Built. No-BS.**

T Rock is a commercial general contractor — they build things. The CRM should feel like it was built FOR construction, not adapted from generic SaaS. Confident typography, strong visual weight, industrial materials palette.

### Brand Assets
- **Logo**: Angular "TR" monogram in red (#CC0000) and black (#1A1A1A). Sharp edges, no curves.
- **Primary red**: #CC0000 (from logo)
- **Black**: #1A1A1A (from logo)
- **Sidebar**: Dark navy #0F172A (established pattern)
- **Current accent**: Purple #7C3AED (shadcn default — should be replaced with brand red for primary actions)
- **Font**: Geist Variable (current — clean, modern, works well)

### Aesthetic Direction
- **Tone**: Industrial utilitarian — clean but tough. Think construction blueprints meets modern dashboard.
- **Theme**: Dark sidebar + light content area (keep current pattern)
- **Typography**: Strong weight contrast. Bold headings, clean body text. No decorative fonts.
- **Layout**: Data-dense but organized. Tables and lists over cards where possible. Left-aligned, not centered.
- **Color**: Red for primary actions and alerts. Dark navy for structure. Warm grays (not blue-gray) for backgrounds.
- **Icons**: Lucide — clean, consistent line weight.

### Anti-References
- Generic SaaS / HubSpot templates
- Overly playful / startup aesthetics (rounded everything, emoji, toy-like)
- Enterprise bloat / SAP (cluttered dashboards, tiny fonts)
- AI-generated look (gradient text, glassmorphism, generic shadcn defaults)

### Design Principles
1. **Built, not decorated** — Every element earns its place. No decorative flourishes that don't serve the data.
2. **Construction-grade clarity** — Information hierarchy should be obvious at a glance, even on a phone at a job site.
3. **Red means action** — Primary buttons, important badges, and CTAs use brand red. Reserve it for things that need attention.
4. **Speed over beauty** — Interactions should feel instant. Optimize for the rep who has 30 seconds between meetings.
5. **Respect the data** — Numbers, names, and dates are the product. Typography and spacing should make them scannable, not pretty.

## Rep Performance Snapshot — Metric Determinism

Rep performance metrics computed by worker/src/jobs/rep-performance-rollup.ts use
two different filter regimes based on period kind:

**Current-period metrics** (mtd, qtd, ytd, week_8back):
- Use the deal's current stage state (`psc.is_terminal`, `psc.is_active_pipeline`)
- Reflect "as of now" — live dashboard semantics
- Recomputing produces a slightly different answer if the deal's stage has changed

**Historical metrics** (last_month, last_quarter, last_year):
- Use only lifecycle attributes (created_at, close dates)
- Defined as "deals that existed during this period"
- Deterministic — recomputing last_month today and next week produces the same answer
- Does NOT filter on current stage state because that would retroactively
  change historical snapshots

**stale_account_count** (all period kinds):
- Counts accounts (companies and properties) with stale activity timestamps as of period_end
- The stale threshold is configurable per stage; default is 30 days

**Known limitations — NOT period-deterministic:**

stale_account_count is computed from currently-mutable data. Recomputing the
same historical period at a later date may produce a different result. Three
distinct sources of drift:

1. **Activity timestamps are mutable.** companies.last_activity_at and
   properties.last_activity_at advance whenever new activity is logged. If new
   activity happens after period_end on an account that was stale during the
   period, the next recomputation will exclude that account from the historical
   count.

2. **Account ownership is mutable.** stale_account_count attribution uses the
   deal's CURRENT assigned_rep_id. If a deal is reassigned after period_end,
   the stale count for that account moves to the new rep on next recomputation.

3. **Stale cutoff uses session timezone.** The boundary expression
   `($3::date + interval '1 day')::timestamptz` interprets the date in the
   session's TimeZone setting. Environments running in different timezones
   may classify accounts near the threshold differently.

True determinism for this metric would require:
- An activity_history table that snapshots last_activity_at at period boundaries
- A deal_assignment_history table that records ownership changes over time
- An explicit UTC anchor on the cutoff expression

These are tracked in follow-up issue #168:
https://github.com/artificialadnaan/trockcrm/issues/168

For now, the metric is **a current-state snapshot recomputed for historical
periods** — useful as a ballpark indicator but not for audit-grade reporting.

**Why the asymmetry**: the current-period branches answer "what's happening now,"
the historical branches answer "what existed during this period." These are
slightly different product questions by design. Future work could unify them by
adding stage history coverage backfill and deactivation timestamps.
