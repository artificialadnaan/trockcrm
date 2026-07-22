# Scorecard Corrective Actions — Design

**Date:** 2026-07-22
**Status:** Draft for review
**Author:** Adnaan (+ Claude)

## 1. Problem & goal

Field/leadership scorecards that come in **below standard** (the existing "Corrective Action Required"
rating band) currently produce only a rating + user-entered action items and a notification to leadership.
Nobody is explicitly asked to *fix* the flagged issues, and there is no record that corrective action was
taken.

This feature closes that loop: when a scorecard trips the corrective-action band, it **opens a corrective-action
stage**, **notifies the project's superintendent and project manager**, and gives them a structured way — in
TRock Cam (if they're a CRM user) or via a token-authed web page (if they're email-only) — to **document the
corrective action per flagged item** with photos + comments. Those responses thread **inline under the original
items** like replies. Once every flagged item has a response, the scorecard **auto-closes** (resolved).

## 2. Decisions (locked with stakeholder)

| Decision | Choice |
|---|---|
| **Trigger** | The existing "Corrective Action Required" rating band: V2 average < 7, or V1 total < 75. No new threshold logic. |
| **Responders / config** | **Hybrid.** Superintendent + PM per deal are either assigned CRM users (respond in TRock Cam) or configured name+email (respond via a token-authed web page). |
| **Closure** | **Auto-close** once **every flagged item** has a response. **Either** the super **or** the PM can complete it — no dual sign-off. |
| **Response granularity** | **Itemized** — one response (photos + comment) per flagged item (each action item and each critical deficiency). |
| **Sequencing** | **One release** — both the in-app path and the tokenized web path ship together. |

## 3. What already exists (reuse)

- **Scorecards** are a single `field_scorecards` table (V1 0–100, V2 1–10 average). Rating bands + the
  `corrective_action` tier are computed today (`shared/src/types/field-scorecard.ts`,
  `mobile/src/scorecards/scoring.ts`). `field_scorecards.status` exists (only `"submitted"` used).
- **Flagged items** already stored: `actionItems text[]`, `criticalDeficiencies text[]` (+ `criticalDeficiencyNotes jsonb`).
- **Super/PM per deal**: `deal_team_members` (role enum includes `superintendent`, `project_manager`), joined
  to `public.users` for email; managed on the deal **Team tab** (`client/src/pages/deals/deal-team-tab.tsx`,
  `server/src/modules/deals/team-service.ts`). Scorecards also carry free-text `superintendentName`/`pmName`.
- **Email**: durable outbox job (`field_scorecard_email`) enqueued in the submit transaction; worker sends via
  Resend with attachments/CC/idempotency (`worker/src/jobs/field-scorecard-email.ts`,
  `worker/src/lib/system-email.ts`).
- **Tokenized external access pattern**: recipient-bound tokens already used for public photo share
  (`public_photo_tokens`) and RFP recipient links — reuse this shape for the web responder.
- **Mobile capture**: `CameraCapture`, `PhotoCaptionEditor`, `VoiceRecorder`, the upload queue, and the
  read-only `ScorecardDetailView` are all reusable.

## 4. Data model

### 4.1 Scorecard status (stages)
`field_scorecards.status` values become: `submitted` | `corrective_action_open` | `corrective_action_closed`.
- On submit, the stage opens to `corrective_action_open` **only when** the rating is the corrective-action
  band **AND** there is at least one flagged item (≥1 action item or critical deficiency). Otherwise the card
  stays `submitted` — including a below-band card with **no** flagged items (nothing to correct itemwise), as
  well as any passing scorecard (unchanged behavior).

### 4.2 New table: `scorecard_corrective_actions` (per-tenant schema)
One row per **flagged item** on a below-band scorecard, seeded `open` at submit.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `scorecard_id` | uuid FK → field_scorecards | |
| `item_type` | text | `action_item` \| `critical_deficiency` |
| `item_ref` | text | deficiency key, or a stable index/hash of the action-item text |
| `item_label` | text | denormalized human label captured at seed time (action text / deficiency label) |
| `status` | text | `open` \| `resolved` (CHECK) |
| `response_comment` | text | the corrective-action narrative |
| `responded_by_user_id` | uuid null | set when a CRM user responds |
| `responder_name` | text null | for email-only responders |
| `responder_email` | text null | for email-only responders |
| `responded_at` | timestamptz null | |
| `created_at` / `updated_at` | timestamptz | |

Unique `(scorecard_id, item_type, item_ref)`.

### 4.3 Response photos
Add nullable `corrective_action_id uuid` to `field_scorecard_photos` (FK → scorecard_corrective_actions),
reusing the existing files/R2/thumbnail plumbing. A response photo has `corrective_action_id` set and
`sectionKey`/`deficiencyKey` null.

### 4.4 Email-only super/PM config
Extend the deal Team surface so `superintendent`/`project_manager` can be an **email-only member**: allow
`deal_team_members.user_id` to be NULL with new `member_name` / `member_email` columns (or a sibling
`deal_external_members` table if we want to keep `deal_team_members` user-only — TBD in the plan; leaning
toward nullable `user_id` + name/email on the same table for one resolution path).

### 4.5 Web responder token
`scorecard_corrective_action_tokens`: `{ id, token_hash, scorecard_id, recipient_email, role, expires_at,
consumed_at? }` — recipient-bound, per (scorecard, recipient). Grants access **only** to that scorecard's
corrective-action flow. Mirrors `public_photo_tokens` handling (hash at rest, expiry, single logical grant).

## 5. Trigger & notification

- In `createFieldScorecard` (`server/src/modules/field/scorecards-service.ts`), after computing the rating:
  if the rating is the corrective-action band **and** there is ≥1 flagged item (see §4.1), set
  `status = corrective_action_open`, seed `scorecard_corrective_actions` rows (one per action item +
  deficiency), and enqueue a durable `scorecard_corrective_action_email` job **in the submit transaction**
  (same outbox pattern as the existing email job).
- Worker handler resolves recipients per deal (hybrid, see §6), mints web tokens for email-only recipients,
  and sends **one email per recipient** (or a shared email with per-recipient links) with: the score/rating,
  the flagged items, and a **link** — a TRock Cam deep link (`trockcam://scorecards/corrective-action/<id>`) for
  CRM users, or the tokenized web URL for email-only. Idempotent per (scorecard, recipient) via an
  `email_sent_at`-style stamp.

## 6. Recipient resolution (hybrid)

Per deal, resolve super + PM in priority order:
1. Assigned CRM users from `deal_team_members` (roles `superintendent`/`project_manager`, active) → user email
   + TRock Cam deep link.
2. Email-only member config (§4.4) → name+email + tokenized web link.
3. Fallback: the scorecard's free-text `superintendentName`/`pmName` has no email, so it is **not** auto-emailed;
   surfaced in the CRM UI so an admin can add the missing email. (No silent drop — logged/visible.)

## 7. Response flows (itemized)

### 7.1 TRock Cam (CRM users)
New screen `mobile/app/(app)/scorecards/corrective-action/[id].tsx` reached by deep link or from the project's
Scorecards list. Lists each flagged item; per item: add photos (reuse CameraCapture) + a comment (reuse
PhotoCaptionEditor/voice). Submitting a per-item response POSTs it and marks that item `resolved`. Auth via the
existing field session; the responder must be the assigned super/PM (or an authorized role).

### 7.2 Web (email-only)
Token-authed mobile-web page (new client route, no login) mirroring the itemized flow: per item, upload photos +
comment. Same server endpoints, authorized by the recipient-bound token instead of a session. Uploads go through
a token-scoped upload endpoint.

### 7.3 Server API
- `GET /field/scorecards/:id/corrective-actions` — the items + any responses (session **or** token auth).
- `POST /field/scorecards/:id/corrective-actions/:itemId` — submit a per-item response (comment + attach
  uploaded photo ids); marks the item `resolved`, stamps responder identity (user id or token recipient).
- Token-scoped photo upload endpoint for the web path.
- All writes run in the deal's office schema; strict scorecard-belongs-to-deal + authz checks (mirror existing
  field-write guards).

## 8. Closure

When the **last** `open` item for a scorecard flips to `resolved`, set `field_scorecards.status =
corrective_action_closed` (in the same transaction as that item's response). Either super or PM can be the one
who completes it; no dual sign-off. A closure is durable and idempotent (re-submitting a resolved item is a
no-op).

## 9. Display (the "thread") + dashboard

- **Web CRM** (`deal-scorecards-tab.tsx`) and **mobile** (`ScorecardDetailView`) render each corrective-action
  response **inline under its original action item / deficiency**, with responder name + timestamp + photos —
  the "reply to the thread." A closed scorecard shows the full before/after.
- **QC dashboard** (`/projects/qc-reports`): add `corrective_action_open` / `corrective_action_closed` as a
  status filter + column so leadership can see what is outstanding vs resolved.
- **PDF**: extend the scorecard PDF to append the corrective actions taken (optional, can be a fast-follow).

## 10. Migrations

- Add `status` values (no enum type change needed — it's a `varchar`; just new allowed values + any CHECK).
- New `scorecard_corrective_actions` table + indexes (per-tenant; use the TENANT_SCHEMA block so new offices
  inherit it).
- `field_scorecard_photos.corrective_action_id` (nullable FK).
- Deal team email-only columns (or sibling table).
- `scorecard_corrective_action_tokens` table.
- Next free migration number at implementation time (0192+), one concern per migration.

## 11. Testing

- Rating→open transition + item seeding (unit + runtime).
- Recipient resolution across all hybrid cases (user / email-only / missing-email fallback).
- Per-item response → resolved; last item → auto-close (either responder); idempotent re-submit.
- Token mint/verify/expiry + token-scoped authz (no cross-scorecard access).
- Mobile: itemized response screen; web: tokenized page.
- Email job: idempotent, correct links per recipient type.

## 12. Deferrals / open items (non-blocking)

- PDF "corrective actions taken" section — can be a fast-follow.
- Reminder/escalation emails if an open corrective action ages (not in v1).
- Whether the notify email itself threads (In-Reply-To) — v1 treats it as a notification; the "thread" is the
  in-app inline display, not the email.
- Exact home for email-only member config (nullable `user_id` on `deal_team_members` vs a sibling table) —
  finalized in the implementation plan.
