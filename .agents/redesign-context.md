# Redesign Context — 2026-05-07

> **Critical status note**: The Vite preview files (`client/src/preview/*.tsx`, `client/preview.html`, `client/src/preview-main.tsx`) were created in-session and rendered live at `localhost:5173/preview.html` for design iteration. They were **wiped from disk** when the parallel audit/infra CLI advanced HEAD on this branch (`a710c7c` → `89a4537`, working tree reset at May 7 11:23). The previews must be **re-created** from this spec, OR ported **directly to production** files using the spec as the reference. Design intent is canonical here — the .tsx files were a working scaffold, not the deliverable.
>
> Source-of-truth for the brand/design language: `DESIGN.md` (root, 229 lines, T Rock industrial system) + `PRODUCT.md` (root, brand voice + anti-references) + `.impeccable/design.json` (component recipes).

## 1. Preview pages designed this session

Each entry: route, intent, top-level structure, data dependency, design choices.

### Shell

**`preview-main.tsx` + `preview.html`** — Vite multi-page entry mounting a fake AppShell with `MemoryRouter`. **Light/white sidebar** (final decision after iteration) with dark navy `#0F172A` "T ROCK CRM" logo block at top, lucide nav icons, red-tinted active item, "DIRECTOR" group label section. **Topbar**: search input with `⌘K` chip, bell with red dot, red avatar circle. The redesign keeps the existing AppShell intent but lightens the sidebar from the production dark navy to a Stitch-reference white.

### Dashboards

**`/` Rep Dashboard** (`rep-dashboard-preview.tsx`)
- Hero: red avatar + "Welcome, Brett" black uppercase headline, "Today's work · synced X ago" eyebrow, period pills (Today/Week/MTD/QTD/YTD with YTD active red), BarChart3 / Bell / User icon-only buttons
- 3 metric cards: Active deals (red bottom-edge accent), Active leads (blue accent), Commission YTD (drenched red)
- 2-col main: **Top Deals** table (red avatars, stage pills amber/blue/green, days column red when over SLA, value right-aligned) + sidebar with **Strategic Alerts** dark navy panel + **AI Blind Spots** white panel
- **Funnel strip** — 4-up `text-4xl font-black` count cells (Leads / Qualified / Opportunities / Bid Board)
- **My numbers** card with KpiCell strip — 4 metrics row (Cleanup / Stale leads / Follow-up / Overdue with emphasis="warning"|"danger") + 4-cell activity row (Calls / Emails / Meetings / Notes)
- Bottom: **Performance report** outline + **Open my pipeline** red primary CTAs
- **Production hook**: `useRepDashboard` (already returns most data). Added `fetchedAt: Date | null` for freshness stamp — this edit DID persist to `client/src/hooks/use-dashboard.ts`.

**`/director` Director Dashboard** (`director-dashboard-preview.tsx`)
- Big "DIRECTOR DASHBOARD" headline + 6-period pill bar (MTD/QTD/YTD/Last month/Last quarter/Last year, QTD active red) + Refresh button
- 3 hero metrics: Active pipeline (red), Closed QTD with goal % (blue), At risk count + dollar (drenched red)
- **Forecast vs Goal card**: big `$X / $Y` headline + "Behind goal by X · 6 weeks remaining" + 3 side chips (Pace / Closing this week / Activity total) + 2 stacked progress bars
- 2-col main:
  - Left: **Sales Force Performance** table — Rep (with crown for leader, red "Needs help" pill, amber "Review" pill, both whitespace-nowrap), Closed, Pipeline + deals count, Distribution bar, Win rate with trend arrow + delta pp, At-risk count chip, Activity dot (high/moderate/low), 8-week sparkline (emerald or red), chevron. Click → `/director/rep/:id`
  - Left: **At-Risk Deals** card — 5 deals with rep avatar, stage pill, days/SLA, value, specific risk reason pill ("8 days over SLA", "No touch in 14 days", "Missing decision maker", "Awaiting board approval")
  - Right: **Strategic Alerts** dark navy panel — 4 alerts with severity bars (red/amber/blue) + CTAs ("Open forecast", "Schedule 1:1", "Coaching plan", "Win/loss review")
  - Right: **AI Coaching** white panel with violet sparkles — 3 per-rep coaching prompts: insight + suggestion + action button
- Bottom 2-col: **Activity pulse this week** (per-rep activity bar broken into emerald/blue/violet for calls/emails/meetings) + **Recent closes** (5 wins/losses with green check or red X, value, rep, reason, date)
- **Hook**: extend `useDirectorDashboard`. For perf, write `rep_performance_snapshots` table + cron job (Tier 6 below)

### List pages

All share: big black uppercase headline + eyebrow ("X of Y"), `Mine | Team | All` scope toggle, red "New X" CTA, 3-up metric cards, search + filter chips + table.

**`/deals`** (`deals-preview.tsx`)
- Metrics: Active pipeline (red), Won YTD (blue), At risk (drenched red)
- **Pipeline board** kanban with 7 canonical stages: Opportunity, Estimating, Estimate Under Review, Estimate Sent to Client, Contract, Won, Lost. Cards show name, account, red owner avatar, value, days-in-stage (red over SLA), SLA hint
- View toggle: **Board / Map** (Table dropped per user — bottom search card serves it)
- **Map view**: stylized DFW SVG with red pins per city. Pin size scales with deal count. Hover reveals tooltip with deal list. Stub coords inline; production swaps to Mapbox/Leaflet using existing `propertyLat/propertyLng` on deals
- Search/filter card: stage chips (red selected), table (Deal | Owner avatar | Stage pill | Days/SLA | Value | Last touch | chevron), pagination
- **Hooks**: `useDealBoard`, `useDeals` — already wired

**`/leads`** (`leads-preview.tsx`)
- 3 canonical stages only: New Lead, Qualified Lead, Sales Validation. (User clarified mid-session: Opportunity is the FIRST DEAL stage, not a lead stage)
- 3 metrics: Active leads (blue), Estimated value (green), Stale leads (drenched red)
- Source chips (Referral/Inbound/Outbound/Bid Board/Repeat). Table adds Source column + Phone/Mail/Calendar quick action icons (with stopPropagation)
- **Hooks**: `useLeadBoard`, `useLeads` — already wired

**`/companies`** (`companies-preview.tsx`)
- Industry filter chips (School District / Healthcare / Industrial / Office-Mixed / Retail / Government / Hospitality)
- Table: Company (dark slate logo block + initials) | Industry pill | Properties count | Contacts count | Active deals badge | Pipeline value | Last activity (red when stale 30d+) | Owner avatar
- Footer: "Open in HubSpot" external link
- 3 metrics: Total accounts (red), Active pipeline (blue), Untouched 30d+ (drenched red)
- **Schema deps (Tier 1)**: `industry` enum, `region`, `domain`, `last_activity_at`, `hubspot_id`, `procore_id`

**`/contacts`** (`contacts-preview.tsx`)
- Role filter chips (Decision Maker red / Influencer blue / Gatekeeper slate / Procurement violet / Engineer amber / Owner emerald)
- Table: Contact (red avatar + name + title + ⭐ when primary) | Company | Role pill | Quick actions | Linked deals count | Last touch | Owner | chevron
- 3 metrics: Total contacts (red), Decision makers (blue), Untouched 30d+ (drenched red)
- **Schema deps (Tier 1)**: `role` enum, `is_primary` bool, `linkedin_url`, `hubspot_id`

**`/properties`** (`properties-preview.tsx`)
- "My linked / Team / All" scope toggle (different default — properties are linked-to, not owned)
- Type filter chips (Office / Industrial / Retail / School / Healthcare / Government / Mixed-Use)
- Table: Property (Camera or Building2 icon + name + address with MapPin) | Type pill | Owner company | Sq ft | Engagement status pill with colored dot (Active deal red / Active lead blue / Won project green / No engagement slate) + sub-stage label | Linked value | Last touch
- 3 metrics: Active opportunities + total sq ft (red), Linked pipeline (blue), Untouched 30d+ (drenched red)
- **Schema deps (Tier 1)**: `type` enum, `floors`, `roof_area`, `last_activity_at`, `procore_id`, `companycam_id`

### Detail pages

All share: breadcrumb back link, hero (avatar/icon + identity headline + metadata + actions), 3-up metrics, **DetailTabs** (icon-only tabs with active label strip in slate-50/50 below), 2-col main (tabs card + sidebar metadata).

**Shared `DetailTabs` component** (final iteration after multiple user feedback rounds)
- **Icon-only tab buttons** — text labels removed
- Native `title=` tooltips for hover discoverability
- Active tab gets red bottom border
- **Below tab row**: label strip in slate-50/50 bg showing the active tab's icon + label in red 11px tracked uppercase, `py-3` for breathing room (final spacing)
- All tabs always visible (no More dropdown — icons fit easily at all viewports)

**`/companies/:id`** (`company-detail-preview.tsx`)
- Hero: dark slate logo block with company initials, industry eyebrow, big black uppercase headline, region + domain + HubSpot ID (mono font)
- Actions: Edit / HubSpot / New deal / overflow
- 3 metrics: Active pipeline (red), Properties count (blue), Contacts (drenched red)
- 9 tabs: Overview, Contacts, Properties, Deals & Leads, Email, Recordings, Activity, Notes, Files
- Overview: about paragraph, primary contact card with quick actions, recent activity timeline (vertical line + colored event dots: Phone emerald / Mail blue / Calendar violet / Note amber / Deal red)
- Contacts/Properties/Deals tabs: relational tables, click row → respective detail
- Email tab: `EmailList` shared component
- Recordings tab: `RecordingsList` (red Play button + faux waveform + duration + transcribed pill + transcript snippet + topic chips + direction pills)
- Files tab: `FilesView` with subtab toggle (All / Photos / Documents) — Photos and Documents now consolidated here
- Sidebar: Owner block, Industry / Region / Domain, System IDs (HubSpot, Procore mono)

**`/contacts/:id`** (`contact-detail-preview.tsx`)
- Hero: round red avatar (identity moment), role eyebrow + amber "Primary" pill if primary, big headline, title + clickable company link
- Actions: Call / Email / Schedule (red primary)
- 3 metrics: Linked deals (red), Last touch (blue), Engagement quality (drenched red)
- 7 tabs: Overview, Linked deals, Email, Recordings, Activity, Notes, Files
- Overview: about, contact methods grid (Office phone / Mobile phone / Email — each with colored icon), activity timeline
- Sidebar: Owner / clickable company link / Role / LinkedIn external link / HubSpot ID

**`/properties/:id`** (`property-detail-preview.tsx`)
- Hero: dark slate Building2 icon block, type eyebrow + status pill with red dot, big headline, address (with MapPin) + clickable owner company
- Actions: Edit / CompanyCam / New deal
- 3 metrics: Roof area (red), Photos on file (blue), Active pipeline (drenched red)
- 7 tabs: Overview, Active deal, History (prior projects), Email, Recordings, Activity, Files (Photos + Documents merged per user request)
- Overview: about, building specs 3-up (Sq ft / Floors / Year built), tiny stylized SVG location map with red pin
- History tab: prior-projects table (Year / Type / Summary / Value)
- Sidebar: Owner company link / Address / Type / Year built / Procore + CompanyCam IDs + Procore link

**`/deals/:id`** (`deal-detail-preview.tsx`) — most complex page
- Breadcrumb → "Deals > deal name"
- Hero: dark slate Briefcase icon, stage pill (amber for Estimating) + days-in-stage with red over-SLA indicator, big black headline, clickable account + property links
- Actions: Edit / Procore / **Move stage** (red primary) / overflow
- 3 metrics: Deal value with margin badge (red), Stage age with SLA badge (blue), Close target with "stage X of Y" (drenched red)
- **Bid Board ownership warning banner** (renders when `bidBoardOwned`, i.e. stage ≥ Estimating): amber-200 border on amber-50/40 bg, Lock icon, "Bid Board now owns downstream progression" headline, sync status + Refresh button, 2-col split "Still editable in CRM" (deal details, files, activity, notes) vs "Mirrored from Bid Board" (stage progression, proposal status, estimating progress, estimate amounts, downstream mirror metadata)
- **Pipeline progress card** (final iteration after multiple user adjustments): 6-slot grid `grid-cols-3 sm:grid-cols-6`. Slots:
  1. Opportunity
  2. **Estimating** with alt **Service Estimating** (only one is the actual stage based on workflow_route)
  3. Under Review (shortened from "Estimate Under Review")
  4. Estimate Sent (shortened from "Estimate Sent to Client")
  5. Contract
  6. **Won** with alt **Lost** (only one terminal outcome)
- Each cell: top row `[icon] [primary label]` items-center, bar `mt-3 h-1`, optional bottom row `[icon] [alt label]` mt-3 (only renders when slot has alt). Icons: green CheckCircle2 (complete) / red number badge (current) / empty Circle slate-400 (future). Alt labels always slate-400 with empty-circle icon. Both gaps (top→bar and bar→alt) symmetric. All 6 columns' bars align horizontally because top row is uniform 1-line at typical widths.
- **Bid Board summary card** (also conditional on `bidBoardOwned`): "Bid Board summary" + "Managed by Bid Board" lock pill, sub-text "Read-only project status mirrored from Bid Board", 4 metric cells (Stage / Estimate / Last synced / Assigned PM), red **Open in Bid Board** CTA + outline Resync button
- 8 tabs: Overview, Stage history, Estimate, Email, Recordings, **Photos** (count, dedicated — distinct from Files), Activity, **Files** (count, documents only since photos are dedicated)
- Overview: scope paragraph, key parties grid (clickable primary contact + owner block), recent activity timeline
- Stage history tab: vertical timeline with stage transitions + duration per stage + transition note
- Estimate tab: line-item table with Qty/Rate/Total + estimate total footer row. **Schema dep**: new `estimate_line_items` table needed (Tier 3)
- Photos tab: dedicated CompanyCam-attribution grid with Upload button. Only entity that gets a separate Photos tab
- Files tab: documents-only `FilesView` (passes `photos={[]}`)
- Sidebar: Owner / Account link / Property link / Primary contact link / Procore + HubSpot mono IDs

### Specialized pages

**`/email`** (`email-preview.tsx`) — replaces existing parking-lot + recent-list + separate-detail-page split
- Compact header: "EMAIL" headline + summary line + outline "Connect Microsoft 365" + red "Compose"
- 3 metrics: Unread (red), Today + auto-linked (blue), Need attention (drenched red, replaces "parking lot")
- **Two-pane inbox in single Card**: filter pills (All / Unread / Unassigned / Sent each with count) + search + sender filter dropdown
- Left pane (360px on lg+): scrollable email list. Row: avatar (red external / dark slate "You"), sender, subject (bolder when unread), preview, status pill, attachment chip, time. Selected row red-tinted.
- Right pane: detail view inline (no page nav). Subject headline + sender row + Star/Archive/Delete icons. **Linked-to bar**: when linked shows colored entity chips (deal red / lead blue / contact violet / company amber / property green) clickable; when unassigned shows yellow "Not linked" alert + reason + "Assign" button. **Assign popover** (inline, not modal): AI suggestions strip in blue tint at top + 5 entity-type pills + search field + scrollable result list. Email body in plain prose, attachments in 2-up grid, Reply/Forward bottom bar
- Status pills on every row: green Linked / amber Low confidence / red Unassigned / slate Sent
- **Schema deps (Tier 4)**: `ai_suggestions` JSONB; multi-entity linking via `email_links` junction table

**`/tasks`** (`tasks-preview.tsx`) — replaces endless scroll with grouped/collapsible
- 3 metrics: Overdue (drenched red when >0), Due today (red accent), Completed this week (green)
- Toolbar: search + group-by dropdown + "Expand all"/"Collapse all"
- 5 collapsible sections: Overdue (red eyebrow), Today (amber), This week (blue), Later (slate, default closed), Completed recently (emerald, default closed)
- Each task row: custom checkbox (red on hover, emerald-fill done) + kind icon chip (Phone green / Mail blue / Meeting violet / Follow-up amber / Doc & Review slate) + title (strikethrough done) + priority Flag (red high / amber medium / slate low) + linked record chip + due time (red overdue) + hover-revealed snooze + overflow icons
- Toggling complete moves row between buckets inline
- **Hook**: `useTasks` already wired, no schema changes

**`/files`** (`files-page-preview.tsx`) — centralized cross-entity file repository
- 3 metrics: Storage used (red), Photos count (blue), Recent uploads last 3 days (drenched red)
- Toolbar: tab pills (All / Photos / Documents with counts) + search + Sort dropdown + view toggle (Grid/List)
- Filter row: linked-to chips (Any / Deal / Lead / Contact / Company / Property) + Starred toggle + Clear filters
- Grid view: photos grid (5-up at xl, camera placeholder, starred badge, download on hover) + documents 3-up cards (file icon + name + starred + kind pill + linked chip + uploader/date/size + download)
- List view: dense table (File / Type pill / Linked-to chip / Size / Uploaded / download)
- Footer: filtered count + filtered total size, no infinite scroll
- **Schema deps (Tier 4)**: file `kind` already maps via existing `category` enum. Multi-entity linking via `file_links` junction. `starred_by_user_ids` JSONB or pivot

**`/reports`** (`reports-preview.tsx`)
- 3 metrics: Pinned (red), Scheduled with daily count (blue), Runs this month (drenched red)
- 4 view tabs: Library / My reports / Scheduled / Recent
- **Library**: category pills (All / Sales / Performance / Operations / Analytics) + Pinned section with red dashed-border "Build custom report" sparkles card + 4 categorized sections (Sales red / Performance blue / Operations amber / Analytics violet) each 3-up grid of report cards
- Each card: category-tinted icon block + title + star/pin toggle + category+kind chip + 2-line description + last-run + frequency pill (Daily emerald / Weekly etc) + red Run button (filled play) + Schedule + Export icon buttons
- 16 fixture reports across 4 categories (notable: "Team Lead Weekly Report" in Performance scheduled weekly Mon 7am to 6 recipients)
- Scheduled tab: table view (Report / Frequency pill / Next run / Recipients with Mail icon / Owner)
- Recent tab: compact list with run count, last run, runtime, "Re-run" button
- My reports tab: empty state with "Open builder" sparkles CTA
- **Schema deps (Tier 5, all new)**: `reports`, `report_schedules`, `report_runs` tables. Scheduler tick (existing `node-cron` infra). Execution worker. Builder is a separate v2 feature

**`/commissions`** (`commissions-preview.tsx`) — two views via toggle
- View toggle at top: My commissions / Team commissions

**My view** (rep):
- Period pills (MTD/QTD/YTD/All)
- 3 metrics: Earned drenched red (locked in), In pipeline blue, Total potential green with goal % badge
- **Stage breakdown card** (the user's central vision — "loading bar"): big total + earned/goal inline. Stacked horizontal bar with 5 segments: emerald (Earned/Won) → red (Contract) → blue (Estimate Sent) → amber (Estimating) → slate (Opportunity). Wider segments embed value+label, narrower hover tooltip. 5-up legend below with colored dot + name + dollar + % of total. Goal progress bar with red gradient at bottom
- **Projects contributing card** (final fix: single CSS grid `grid-cols-[minmax(0,1fr)_120px_70px_160px_24px]` used identically for header, stage banners, every deal row, footer total — fixes column drift across stage groups). Stage groups: section banner with stage dot + label + description + group total. Each row: name + account + close-date / contract-signed-at, deal value + commission rate (1.5%), commission dollar. **Delta indicators**: emerald "+$380 since last update" or red "-$120" below commission when deal value moved (live-update signal as user envisioned)

**Team view** (admin/director):
- Same period toggle
- 3 metrics: Team earned (drenched red), Team pipeline (blue), Goal attainment % (green)
- **Rep leaderboard**: avatar with crown on leader / name / region / Earned big number / Pipeline number / **Stage breakdown column** with compact 6px-tall CommissionBar / Active deals count / Win rate with arrow + color (green ≥50% / amber ≥30% / red <30%) / Goal progress mini bar / chevron
- Sortable by Earned / Pipeline / Goal %

- **Hook**: `useRepDashboard` returns `commissionSummary`. Need new per-deal commission breakdown — likely `useCommissionBreakdown` hitting a server view that joins deals + commission rate per stage

### Shared components

- **`preview-shared.tsx`**: `EYEBROW` constant (`text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500`), `USD` / `USD_COMPACT` / `NUMBER_COMPACT` formatters, `MetricCard` (eyebrow / value / badge with tone green|blue|white / caption / drenched red mode / accent red|blue|green bottom edge), `ScopeToggle<T>` (generic options pill toggle), `ActivityTimeline` (flex-based timeline with `renderIcon` callback), `DetailTabs<K>` (icon-only tabs with active label strip)
- **`comms-preview.tsx`**: `EmailRow` type, `EmailList` (avatar + sender + subject bold + preview + attachment chip + relative date + chevron, unread bolder + red dot), `RecordingRow` type, `RecordingsList` (red Play button + faux waveform 40 bars + duration + transcribed pill + transcript italic + topic chips + download)
- **`files-preview.tsx`**: `PhotoItem` + `DocumentItem` types, `FilesView` (subtab toggle All/Photos/Documents + photos grid + documents table with kind pills)

## 2. Production UI mapping

| Preview | Production target | Status | Notes |
|---|---|---|---|
| Shell (FakeSidebar/FakeTopbar) | `client/src/components/layout/{sidebar,topbar,app-shell}.tsx` | extends-existing | Lighten sidebar from dark to white. Topbar: add ⌘K chip |
| `rep-dashboard-preview.tsx` | `client/src/pages/dashboard/rep-dashboard-page.tsx` | already partially ported (this session) | Hook returns most data. Mid-session edits to this file persisted. Continue port |
| `director-dashboard-preview.tsx` | `client/src/pages/director/director-dashboard-page.tsx` | replace-in-place | New sections: Forecast vs Goal, At-Risk Deals, AI Coaching, Activity Pulse, Recent Closes. Needs `rep_performance_snapshots` (Tier 6) |
| `deals-preview.tsx` | `client/src/pages/deals/deal-list-page.tsx` | replace-in-place | Map view requires real geo lib (Mapbox/Leaflet) |
| `leads-preview.tsx` | `client/src/pages/leads/lead-list-page.tsx` | replace-in-place | Drop "opportunity" from canonical lead stages; align to {new_lead, qualified_lead, sales_validation} |
| `companies-preview.tsx` | `client/src/pages/companies/company-list-page.tsx` | replace-in-place | Tier 1 schema |
| `contacts-preview.tsx` | `client/src/pages/contacts/contact-list-page.tsx` | replace-in-place | Tier 1 schema |
| `properties-preview.tsx` | `client/src/pages/properties/property-list-page.tsx` | replace-in-place | Tier 1 schema |
| `company-detail-preview.tsx` | `client/src/pages/companies/company-detail-page.tsx` | replace-in-place | + Email/Recordings/Files tabs. Tier 4 multi-entity linking |
| `contact-detail-preview.tsx` | `client/src/pages/contacts/contact-detail-page.tsx` | replace-in-place | + Email/Recordings/Files tabs |
| `property-detail-preview.tsx` | `client/src/pages/properties/property-detail-page.tsx` | replace-in-place | Photos and Documents merged into Files tab |
| `deal-detail-preview.tsx` | `client/src/pages/deals/deal-detail-page.tsx` | replace-in-place | Photos remains dedicated. Tier 3 `estimate_line_items`. Bid Board banner + summary use existing mirror fields |
| `email-preview.tsx` | `client/src/pages/email/email-inbox-page.tsx` | replace-in-place | Tier 4 multi-entity + `ai_suggestions` JSONB |
| `tasks-preview.tsx` | `client/src/pages/tasks/task-list-page.tsx` | replace-in-place | Existing schema sufficient |
| `files-page-preview.tsx` | `client/src/pages/files/files-page.tsx` | replace-in-place | Tier 4 multi-entity linking |
| `reports-preview.tsx` | `client/src/pages/reports/reports-page.tsx` | replace-in-place | Tier 5 reports infra (3 new tables + scheduler) |
| `commissions-preview.tsx` "My" | `client/src/pages/commissions/rep-commissions-page.tsx` | replace-in-place | |
| `commissions-preview.tsx` "Team" | new admin route OR extend existing | new file needed | Cross-rep leaderboard view |
| `preview-shared.tsx` | `client/src/components/shared/` | new files | MetricCard, ScopeToggle, DetailTabs, ActivityTimeline as production primitives |
| `comms-preview.tsx` | `client/src/components/comms/` | new files | EmailList, RecordingsList |
| `files-preview.tsx` | `client/src/components/files/files-view.tsx` | new file | FilesView with Photos+Documents subtabs |

## 3. Redesign spec discovery (verified by parallel agent earlier)

- **`DESIGN.md`** (root, 229 lines) — full T Rock design system. Tokens (colors as OKLCH-derived hex, typography scale, spacing, rounded radii). Named rules: "The Red Has A Job Rule", "The Pale Shop Floor Rule", "The Dark Alert Rule", "The Numbers Lead Rule", "The Label Discipline Rule", "The Border First Rule", "The No Float Rule". Do/Don't list. **Source of truth.**
- **`PRODUCT.md`** (root, 43 lines) — brand personality "Bold. Built. No-BS.", users (Sales Reps / Directors / Admins), brand assets (T Rock Red `#CC0000`, Ink Navy `#0F172A`), aesthetic direction, anti-references (Generic SaaS / HubSpot templates / Overly playful / Enterprise bloat / AI-generated look), 5 design principles
- **`.impeccable/design.json`** (216 lines) — machine-readable token map + 7 reference component recipes with HTML+CSS: Primary Button, Segmented Range, Metric Card, Strategic Alert Panel, Standard Input, Status Badge, Executive Table
- **`docs/superpowers/plans/`** + **`docs/superpowers/specs/`** (2026-04-19 to 2026-04-22) — paired plan/spec markdown files covering pipeline board, stage page, record detail, role-aware console, dashboard performance pass, shell header uniformity, admin sidebar consolidation. Read for any pre-existing scoped redesigns.
- **`.agents/critique-0[1-6]-*.png`** — visual critique screenshots from earlier passes
- **No `REDESIGN.md` or `UI.md`** at root or `/docs`

## 4. Data layer map

| Hook | File | Return shape |
|---|---|---|
| `useRepDashboard({ range })` | `client/src/hooks/use-dashboard.ts` | `{ data: RepDashboardData, loading, error, fetchedAt: Date \| null, refetch }`. `RepDashboardData`: `activeLeads.count`, `activeDeals.{count,totalValue}`, `contractsSignedYtd.{count,totalValue}`, `contractsSignedMtd.{count,totalValue}`, `tasksToday.{overdue,today}`, `activityThisWeek.{calls,emails,meetings,notes,total}`, `followUpCompliance.{total,onTime,complianceRate}`, `pipelineByStage[]`, `staleLeads.{count,averageDaysInStage,leads[]}`, `leadSnapshot[]`, `dealSnapshot[]`, `myCleanup.{total,byReason[]}`, `crmOwnedProgression[]`, `downstreamBottlenecks[]`, `commissionSummary`, `funnelBuckets[]` |
| `useDealBoard(scope, includeTerminal, dateFilters)` | `client/src/hooks/use-deals.ts` | `{ board: DealBoardResponse, loading, error, refetch }`. Board: `columns[]` of `{ stage: { id, slug, label }, cards: DealCard[] }` |
| `useDeals(filters)` | `client/src/hooks/use-deals.ts` | `{ deals[], total, loading, error, refetch }` |
| `useLeadBoard(scope)` | `client/src/hooks/use-leads.ts` | Same shape as `useDealBoard` with lead stages |
| `useLeads(filters)` | `client/src/hooks/use-leads.ts` | `{ leads[], total, loading, error, refetch }` |
| `useCompanies(filters)` | `client/src/hooks/use-companies.ts` | `{ companies[], total, loading, error, refetch }`. Extend after Tier 1 |
| `useContacts(filters)` | `client/src/hooks/use-contacts.ts` | `{ contacts[], total, loading, error, refetch }`. Extend after Tier 1 |
| `useProperties(filters)` | `client/src/hooks/use-properties.ts` | `{ properties[], total, loading, error, refetch }`. Extend after Tier 1 |
| `useEmails(filters)` | `client/src/hooks/use-emails.ts` | `{ emails[], threads[], loading, error, refetch }`. `assignedEntityType`/`assignedEntityId` (single FK), `assignmentConfidence`. Extend with `linked_records[]` after Tier 4 |
| `useFiles(filters)` | `client/src/hooks/use-files.ts` | `{ files[], total, loading, error, refetch }`. Has `dealId`/`leadId`/`contactId` (single FK each). Extend after Tier 4 |
| `useTasks({ section, limit })` | `client/src/hooks/use-tasks.ts` | `{ tasks[], refetch }`. `type` enum, `priority`, `dueDate`, `status`, owner, polymorphic linked entity |
| `useReports()` | `client/src/hooks/use-reports.ts` | Mostly placeholder; needs Tier 5 schema + extension |
| `useDirectorDashboard()` | `client/src/hooks/use-director-dashboard.ts` | Existing; extend for new sections (forecast vs goal, at-risk, coaching, activity pulse, recent closes) |
| `useRepPerformance()` | `client/src/hooks/use-rep-performance.ts` | Per-rep performance — director dashboard rep table |
| `usePipelineStages()` | `client/src/hooks/use-pipeline-config.ts` | `{ stages[], loading, error }` |
| `useActivities(filters)` | `client/src/hooks/use-activities.ts` | `{ activities[], refetch }` |
| `usePhotoFeed(filters)` | `client/src/hooks/use-photo-feed.ts` | Photo feed for Capture/Feed pages |

Types in `@trock-crm/shared/types`: `ActivityRange`, `RepDashboardData`, `FunnelBucketSummary`, `DealBoardColumn`, `LeadBoardColumn`, `CanonicalLeadStageSlug`, `CanonicalDealStageSlug`, canonical workflow contracts, `WORKFLOW_ROUTES`.

## 5. Schema map

### `companies` (`shared/src/schema/tenant/companies.ts`)
Existing: `id`, `name`, `category` (contact category — different from industry), `created_at`, `updated_at`, verification workflow fields, owner FK. **Tier 1 add**: `industry` enum (`general_contractor | construction_manager | property_owner | property_management | reit | architecture_engineering | consultant | insurance_restoration | other`), `region`, `domain`, `last_activity_at`, `hubspot_id`, `procore_id`.

### `contacts` (`contacts.ts`)
Existing: `id`, `first_name`, `last_name`, `email`, `phone`, `mobile_phone`, `job_title`, `company_id` FK, `last_contacted_at`, source/category enums. **Tier 1 add**: `role` enum (`owner_principal | project_manager | facilities_director | maintenance | procurement | insurance_adjuster | admin_ap | other`), `is_primary` bool, `linkedin_url`, `hubspot_id`.

### `properties` (`properties.ts`)
Existing: `id`, `name`, `address`, `city`, `state`, `zip`, `sqft`, `build_year`, `company_id` FK, lat/lng. **Tier 1 add**: `type` enum (`office | industrial | retail | school | healthcare | government | mixed_use`), `floors`, `roof_area`, `last_activity_at`, `procore_id`, `companycam_id`.

### `deals` (`deals.ts` — ~80 columns)
Existing: `id`, `name`, `stage_id`, `stage_entered_at`, `assigned_rep_id`, `property_id`, `account_id`, `primary_contact_id`, `dd_estimate`, `bid_estimate`, `awarded_amount`, `expected_close_date`, `actual_close_date`, `propertyLat`/`propertyLng`, `workflow_route`, `system_of_record`, `outcome_category`, extensive bid-board mirror fields (procore IDs, RFP, proposal status, estimating progress), HubSpot mirror, CompanyCam, forecast. **Tier 3 add**: new `estimate_line_items` table (`deal_id`, `label`, `qty`, `unit`, `rate`, `total`, `sort_order`).

### `leads`
Existing: `id`, `name`, `stage_id`, `stage_entered_at`, `source`, `source_category`, `assigned_rep_id`, `company_id` FK, `property_id` FK (optional), `estimated_value`, `last_contacted_at`. **Canonical stages** (per `shared/src/types/workflow.ts`): `new_lead | qualified_lead | sales_validation` only. NOTE: `LEGACY_LEAD_STAGE_TO_CANONICAL_STAGE` aliases an old `opportunity` lead stage — should be transitioned out (opportunity is now the first deal stage).

### `emails` (`emails.ts`)
Existing: `id`, `subject`, `from_address`, `to_addresses[]`, `cc_addresses[]`, `bcc_addresses[]`, `body_text`, `body_html`, `received_at`, `graph_message_id`, `graph_conversation_id` (TS field `graphConversationId`), `assigned_entity_type`, `assigned_entity_id` (single FK), `assignment_confidence`, `assignment_ambiguity_reason`, attachments JSONB. **Tier 4 add**: `ai_suggestions` JSONB (array `{type, id, name, confidence}`). New `email_links` junction (`email_id`, `entity_type`, `entity_id`) OR `linked_records` JSONB.

### `files` (`files.ts`)
Existing: `id`, `name`, `category` enum (covers Contract/Proposal/Estimate/RFP/Drawing/Spec/Receipt/Other + photo categories), `size_kb`, `uploaded_by`, `uploaded_at`, `deal_id`/`lead_id`/`contact_id` (single FK each), photo geo (lat/lng/taken_at), intake fields. **Tier 4 add**: `file_links` junction OR `linked_records` JSONB. `user_starred_files` pivot OR `starred_by_user_ids` JSONB.

### `call_recordings` (`call-recordings.ts`)
Existing: `id`, `contact_id` FK, `direction` (`inbound | outbound`), `duration_seconds`, `recorded_at`, `audio_uri`, `transcript_text`, `transcript_summary`, `transcription_state` enum. **Tier 4 add**: `topics` text[] or JSONB array.

### `activities` (`activities.ts`)
Existing: `id`, `type` enum (call/email/meeting/note/etc), `subject`, `body`, `occurred_at`, `rep_id`, `entity_type`, `entity_id` (polymorphic).

### `tasks`
Existing: `id`, `type` enum (TASK_TYPES — call/email/meeting/follow_up/doc/review), `priority` enum (high/medium/low), `title`, `notes`, `due_date`, `status`, `assigned_rep_id`, `entity_type`, `entity_id`. **No schema changes needed** for redesign.

## 6. Tier-by-tier ship plan

| Tier | Work | Unblocks |
|---|---|---|
| **0 (this session)** | Re-create previews from this spec OR skip directly to production port | Either path forward |
| **1** schema (one PR) | companies/contacts/properties field additions | All list pages + detail pages |
| **2** | No schema. Port: rep dashboard (already partial), deals list/board, leads list/board, tasks, files page, contact methods | Most read-only views |
| **3** schema add | `estimate_line_items` table + hook | Deal detail Estimate tab |
| **4** schema refactor | Multi-entity linking (`email_links` + `file_links` junctions OR JSONB). `ai_suggestions` JSONB on emails. `topics text[]` on call_recordings. Files starred pivot | Email page + cross-link chips on every detail page |
| **5** new feature | `reports` + `report_schedules` + `report_runs` tables + scheduler tick + execution worker | Reports page library + scheduled view |
| **6** infra | `rep_performance_snapshots` rollup + worker job + indexes on deals/activities | Director dashboard performance |
| **7** rollout | Feature flag, mobile responsive pass, old code cleanup, T Rock acceptance | Default new UI |

## 7. Coordination state

- **Branch**: `chore/impeccable-design-baseline`
- **Other CLI** is on parallel audit/infra work. Made commits during this session: `805d0ee → a710c7c → 89a4537`. Wiped this session's untracked preview files at May 7 11:23 (working tree reset)
- **Production files modified this session that DID persist**:
  - `client/src/components/dashboard/funnel-bucket-card.tsx` — removed `hover:-translate-y-0.5 hover:shadow-md` float-lift (No Float Rule compliance)
  - `client/src/hooks/use-dashboard.ts` — added `fetchedAt: Date | null` to `useRepDashboard` return for the freshness stamp
  - `client/src/pages/dashboard/rep-dashboard-page.tsx` — full redesign port (distill + colorize + clarify + harden + polish; 642 → ~463 lines)
  - `client/src/pages/dashboard/rep-dashboard-page.test.tsx` — assertions retargeted to new copy
- **Coordination going forward**: maintain `.agents/redesign-status.md` (separate file from this one) with claim/release per task between CLIs
