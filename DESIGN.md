---
name: T Rock CRM
description: Construction-grade CRM interface for fast field sales, director oversight, and admin operations.
colors:
  t-rock-red: "#CC0000"
  deep-red: "#990000"
  ink-navy: "#0F172A"
  navy-hover: "#1E293B"
  executive-ink: "#111827"
  slate-text: "#4B5563"
  muted-slate: "#8A95A3"
  steel-line: "#DDE2E8"
  rail-line: "#EEF1F4"
  concrete-white: "#FFFFFF"
  field-surface: "#F5F6F8"
  alert-amber: "#F59E0B"
  action-blue: "#3B82F6"
  success-green: "#22C55E"
typography:
  display:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "3rem"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "normal"
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "normal"
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.16em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.t-rock-red}"
    textColor: "{colors.concrete-white}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-outline:
    backgroundColor: "{colors.concrete-white}"
    textColor: "{colors.executive-ink}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  card-standard:
    backgroundColor: "{colors.concrete-white}"
    textColor: "{colors.executive-ink}"
    rounded: "{rounded.xl}"
    padding: "16px"
  input-standard:
    backgroundColor: "{colors.concrete-white}"
    textColor: "{colors.executive-ink}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 10px"
---

# Design System: T Rock CRM

## 1. Overview

**Creative North Star: "The Jobsite Control Room"**

T Rock CRM should feel like an executive operations board for a construction company: direct, compact, numerically confident, and built for repeated daily work. The director dashboard screenshot is the strongest current reference: hard-working typography, red as the command signal, pale industrial surfaces, compact time controls, and dark alert panels that separate operational risk from routine data.

This is a product interface, not a marketing surface. Design serves fast reading, workflow confidence, and action under time pressure. The system should look like it belongs to T Rock before a user reads the logo: heavy headings, tight labels, red avatars and badges, strong table rows, and a dark sidebar or alert zone that gives the page structure.

It explicitly rejects generic SaaS / HubSpot templates, overly playful startup UI, enterprise bloat, gradient text, glassmorphism, and default purple shadcn styling. If a page looks like it could belong to any CRM vendor after changing the logo, it is not finished.

**Key Characteristics:**
- Dense, scan-first information layout with clear table and list hierarchy.
- Heavy executive typography for major metrics and page titles.
- Brand red used for action, identity, urgency, and selected states.
- Pale concrete backgrounds with white content panels and steel borders.
- Dark navy surfaces reserved for navigation, alerts, and operational command areas.

## 2. Colors

The palette is concrete, steel, ink, and T Rock red. It should feel industrial and operational, not soft SaaS.

### Primary
- **T Rock Red:** The system's command color. Use for primary actions, active segmented controls, user initials, important counts, selected state, and alert emphasis.
- **Deep Red:** Used only as a gradient endpoint or deeper hover state when a red surface needs weight. Never make the whole app red.

### Secondary
- **Ink Navy:** Structural darkness for the sidebar, strategic alert panels, and high-contrast operational surfaces.
- **Action Blue:** A secondary signal for informational state, lead alerts, and neutral system progress. It must stay secondary to T Rock Red.

### Tertiary
- **Alert Amber:** Use for warning icons and moderate-priority review states.
- **Success Green:** Use for positive operational counts, active forecasts, and confirmed status. Keep it quiet.

### Neutral
- **Concrete White:** Main content panels, cards, tables, and inputs.
- **Field Surface:** Page background. Slightly cool and industrial, never beige or cream.
- **Steel Line:** Primary border color for cards, tables, inputs, and panel outlines.
- **Rail Line:** Subtle row dividers and internal separators.
- **Executive Ink:** Main heading and metric color.
- **Slate Text:** Standard body and metadata text.
- **Muted Slate:** Eyebrows, table headers, labels, and secondary descriptors.

### Named Rules

**The Red Has A Job Rule.** Red marks command, identity, selection, or risk. Do not use it as decorative trim.

**The Pale Shop Floor Rule.** Main work surfaces stay pale and clear. Use white panels on a light field background, with steel borders doing most of the separation.

**The Dark Alert Rule.** Dark navy belongs to the sidebar and strategic alert zones. Do not convert normal data cards into dark cards.

## 3. Typography

**Display Font:** Geist Variable with sans-serif fallback
**Body Font:** Geist Variable with sans-serif fallback
**Label/Mono Font:** Geist Variable for labels; system mono only for IDs, logs, and technical references

**Character:** Typography is blunt, compressed, and operational. Headings and metrics carry weight; body text stays small and scannable.

### Hierarchy
- **Display** (900, 3rem, 0.95): Use for major numeric metrics such as pipeline value. This is not for normal page copy.
- **Headline** (800, 1.5rem, 1.1): Use for page titles and major section headings.
- **Title** (700, 1rem, 1.25): Use for card titles, table item names, and list item headings.
- **Body** (400, 0.875rem, 1.45): Use for standard text. Keep long prose rare and cap readable copy around 65-75ch.
- **Label** (700, 0.6875rem, 0.16em tracking): Use for uppercase metadata labels, table headers, and dashboard eyebrows.

### Named Rules

**The Numbers Lead Rule.** Metrics use oversized weight and tight line-height. Labels explain them after the number, not before it.

**The Label Discipline Rule.** Uppercase tracked labels are for dashboard structure only. Do not use them for paragraphs or button text that needs fast recognition.

## 4. Elevation

The system is mostly flat. Depth comes from borders, tonal background shifts, row dividers, dark-vs-light contrast, and occasional low shadows on major panels. Shadows should never become soft decorative atmosphere.

### Shadow Vocabulary
- **Panel Lift** (`box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06)`): Use sparingly on large dashboard panels or dense cards that need separation from the field background.
- **Command Glow** (`box-shadow: 0 3px 0 rgba(204, 0, 0, 0.22)`): Use only on selected or high-value red command surfaces when a tactile bottom edge helps.
- **Focus Ring** (`0 0 0 3px rgba(204, 0, 0, 0.22)`): Use for keyboard focus on actionable controls.

### Named Rules

**The Border First Rule.** Reach for steel borders and tonal panels before shadows.

**The No Float Rule.** Cards sit on the work surface. They do not hover like marketing tiles.

## 5. Components

### Buttons
- **Shape:** Compact rounded rectangle (8px). Icon buttons are square and compact.
- **Primary:** T Rock Red background, white text, 32px height, medium-heavy label. Use for one clear command per region.
- **Hover / Focus:** Darken red or add the red focus ring. Avoid motion beyond subtle transform or color change.
- **Secondary / Ghost / Tertiary:** Outline and ghost controls use white or transparent backgrounds, steel borders, and executive ink text.

### Chips
- **Style:** Pill badges with compact height, strong label weight, and clear tonal meaning.
- **State:** Active or count badges can use red, green, blue, or neutral fills. Keep badge text short.

### Cards / Containers
- **Corner Style:** Strong but controlled rounding (10-12px).
- **Background:** White cards on Field Surface.
- **Shadow Strategy:** Border first, Panel Lift only when needed.
- **Border:** Steel Line outer borders, Rail Line internal dividers.
- **Internal Padding:** 16px standard; 12px for dense subcomponents.

### Inputs / Fields
- **Style:** 32px height, 8px radius, steel border, white or transparent background.
- **Focus:** Red or token ring at 3px with a visible border shift.
- **Error / Disabled:** Error uses red border and pale red background. Disabled uses muted background and lower opacity.

### Navigation
- **Style:** Dark navy vertical sidebar on desktop with white active text, slate inactive text, Lucide icons, and compact rows.
- **Active State:** Use T Rock Red as the selected signal, either through red-tinted background or a small full-height accent. Keep the label legible.
- **Mobile Treatment:** Preserve the hierarchy with compact icon + label actions, not a decorative tab bar.

### Tables
- **Style:** Tables are first-class product surfaces. Use small text, strong row dividers, uppercase headers, right-aligned numeric columns, and tabular figures where possible.
- **State:** Hover rows may use pale muted backgrounds. Avoid heavy zebra striping.

### Strategic Alerts
- **Style:** Dark Ink Navy panels with white labels, muted explanatory copy, and red/blue/amber indicator bars or icons.
- **Purpose:** Use for operational risk only, not everyday card decoration.

## 6. Do's and Don'ts

### Do:
- **Do** use the director dashboard screenshot as the target density and tone for executive surfaces.
- **Do** keep T Rock Red reserved for command, identity, selection, and risk.
- **Do** use tables, compact lists, and KPI bands before decorative card grids.
- **Do** make dashboard numbers bold enough to read in a glance.
- **Do** use Lucide icons with consistent stroke weight inside compact controls.
- **Do** keep the dark navy sidebar and alert panels visually separate from normal white data panels.

### Don't:
- **Don't** make the CRM look like generic SaaS / HubSpot templates.
- **Don't** use overly playful / startup aesthetics, rounded everything, emoji, or toy-like controls.
- **Don't** create enterprise bloat with cluttered dashboards and tiny unreadable text.
- **Don't** use gradient text, glassmorphism, or generic shadcn purple defaults.
- **Don't** use border-left or border-right greater than 1px as a colored side stripe on cards, list items, callouts, or alerts.
- **Don't** turn red into background decoration. If everything is red, nothing is urgent.
