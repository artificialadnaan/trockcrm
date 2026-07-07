# RFP Vote — Rich Editable Form (emulate SyncHub's approval form) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the CRM 3-voter `/rfp-vote` flow to parity with SyncHub's single-approver RFP approval email + review form — full project info + the same 16 editable fields (incl. estimator + project type) — with a "first YES commits its edits and locks the deal" reconciliation model.

**Architecture:** The vote-cast route (`POST /api/deals/:id/rfp-vote`) gains an optional `editedFields` on an approve decision. On the FIRST approve vote in a round (no prior approve), the handler applies the edits to the deal via a dedicated internal apply (bypassing the RFP scope-lock — this IS the authorized commit point), records the vote, and the deal is thereafter locked (a prior approve exists → later votes are decision-only). The create-from-rfp path is UNCHANGED (`loadRfpPayloadDeal` is DB-authoritative, so the committed deal edits flow into the Bid Board project automatically). The `/rfp-vote` client page renders SyncHub's 16-field form when the round is open and unlocked, read-only when locked, and the invitation email is enriched to SyncHub's ~10 fields.

**Tech Stack:** Express + Drizzle (per-tenant office schemas), React + react-query, Vitest/PGlite runtime tests. Base branch: `feat/rfp-vote-rich-form` off `origin/main`.

**Reference (read these first, in the synchub worktree `/Users/adnaaniqbal/Developer/trocksynchubv3-wt-rfp-create`):** `server/routes/rfp-approval.ts` `renderRfpReviewPage` (the 16-field form, lines ~85–289) + `submitApproval()` JS (editedFields shape) ; `server/rfp-approval.ts` `sendRfpReviewEmails` (email field list, lines ~1050–1128) and how edits apply on approve (`processRfpApproval`, `editedFieldsOverride`).

**SyncHub form field set to replicate (all editable):** `dealname, project_number, amount, project_types` (dropdown 1–9), `estimator` (dropdown), `bid_due_date, company_name, client_email, client_phone, address, city, state, zip, country, description, notes` + add/remove attachments. `approverEmail` is separate (the CRM has the authenticated voter — no email field needed).

---

## Task 0: Reconcile the create payload's project-number source (decision + fix)

**Files:** `server/src/modules/deals/rfp-payload.ts` (`buildNormalizedRfpRequestBody`), `server/src/modules/deals/rfp-enqueue.ts` (`loadRfpPayloadDeal`).

**Context:** The create payload currently sends `projectNumber ← deals.deal_number` (a generated HubSpot id) — NOT `deals.project_number` (the canonical DFW/ATL number). SyncHub's form edits `project_number`. The voter must edit the number that lands in the Bid Board project.

- [ ] **Step 1:** Confirm with the canonical resolver (`shared/src/types/deal-display-number.ts`, see memory `trockcam-project-number`) which column is the real Bid Board project number. Almost certainly `project_number` (canonical), with `deal_number` being the raw HubSpot id.
- [ ] **Step 2:** Change `buildNormalizedRfpRequestBody` to send the canonical resolved project number (via the shared resolver) instead of raw `deal_number`. Add a runtime test asserting the payload's `projectNumber` = the canonical number for a HubSpot-imported deal (deal_number ≠ project_number).
- [ ] **Step 3:** The vote form's "Project Number" field edits `deals.project_number` (canonical). Note this in Task 3's apply.

---

## Task 1: Server — accept `editedFields` on approve + first-YES lock + type-4 guard

**Files:** `server/src/modules/deals/routes.ts` (`POST /:id/rfp-vote`, ~line 1774); `server/src/modules/deals/rfp-vote-service.ts` (`authorizeAndCastRfpVote`, `castRfpVote`); Test: `server/tests/modules/deals/rfp-vote-*.runtime.test.ts`.

- [ ] **Step 1 (test-first):** runtime test — first approve vote WITH `editedFields` applies them to the deal (assert deal columns changed) and records the vote; a SECOND voter's `editedFields` are ignored/rejected (deal unchanged) but their decision still records; a reject with `editedFields` is rejected (400). Lock = "an approve vote already exists in this round".
- [ ] **Step 2:** Extend the route to read `req.body.editedFields` (object, optional). Extend `authorizeAndCastRfpVote`/`castRfpVote` signature to carry it.
- [ ] **Step 3:** Inside the same tally transaction (under the existing `FOR UPDATE`), determine `isFirstApprove = decision==='approve' && no existing approve row for the round`. If `editedFields` present AND not first-approve → 409 `RFP_VOTE_ALREADY_LOCKED` (or ignore edits + proceed; prefer explicit 409 so the client re-fetches the locked state). If first-approve → call `applyRfpVoteEdits` (Task 2) BEFORE inserting the vote row.
- [ ] **Step 4 (type-4 guard, option A):** if `editedFields.project_types === '4'` (or `resolveProjectTypeFromNumber` of an edited number is '4') → reject with 409 `RFP_VOTE_SERVICE_TYPE_BLOCKED` + message "This would make it a Service RFP; cancel and re-trigger it through the service flow." Do this before applying.
- [ ] **Step 5:** Keep the existing round-decided / snapshot-authz / is_active re-read guards (BC2/W2/H3) intact — the edit apply is additive, inside the same lock.

---

## Task 2: Server — `applyRfpVoteEdits` (dedicated commit that bypasses scope-lock) + estimator write path

**Files:** new `server/src/modules/deals/rfp-vote-edits.ts` (or in `rfp-vote-service.ts`); Test alongside.

**Context:** This is the authorized commit point, so it writes ALL 16 fields directly (NOT via the public `updateDeal` PATCH, which enforces `SCOPE_READ_ONLY_AFTER_RFP`). It runs only on the first YES, by an authorized voter, inside the tally txn.

- [ ] **Step 1 (test-first):** runtime test — `applyRfpVoteEdits` writes name, project_number (canonical), project_type(+id), amount (to the right column — see Step 3), company/contact linkage where applicable, address (property_* fields), bid_due_date, description, notes, estimator — even though the deal is in `rfp_approval_status='pending'` (scope-locked to the public PATCH). Assert each column.
- [ ] **Step 2:** Map each SyncHub form field → CRM deal column: `dealname→name`, `project_number→project_number` (canonical), `project_types→project_type`+`project_type_id`, `amount→bid_estimate` (or the field the payload reads first; confirm precedence in `loadRfpPayloadDeal` — awarded/bid/dd — and write the one that wins so the edit sticks), `bid_due_date→bid_due_date`, `company_name→companies.name` via `company_id` (or a deal-level override — decide: editing the company name on the linked company vs a deal override; simplest = only allow re-pointing `company_id`, OR store on deal if the deal has a company-name column), `client_email/phone→contacts.*` (same consideration — likely re-point `primary_contact_id`; editing the contact record is out of scope, so surface these as read-from-contact display + editable only if a deal-level override exists), `address/city/state/zip→property_address/city/state/zip`, `country` (deals hardcode "US" — add a column or accept US-only), `description→description`, `notes→` (deals may lack a notes column — map to description addendum or add a column; decide).
- [ ] **Step 3 (estimator write path):** `deals.estimator` (string) has no writer today. Add writing `estimator` in this apply. Prefer setting `estimator_user_id` (the FK, per memory `estimator-earned-commission`) AND/OR the `estimator` string that the create payload reads (`deals.estimator ?? bid_board_estimator`). Ensure whatever the create payload reads is what gets written. The form's estimator dropdown source = CRM users who are estimators (mirror SyncHub's `estimator_list`, but from CRM `users`).
- [ ] **Step 4:** Company/contact editing nuance: if editing the company/contact *record* fields is too broad, scope this task to re-pointing `company_id`/`primary_contact_id` (a dropdown) + editing the deal-level address/description/amount/dates/estimator/type/number/name. Confirm the final editable set matches SyncHub's intent (correct the project), flag any field reduced to read-only.

---

## Task 3: Server — expose full deal + lock state to the vote page

**Files:** `server/src/modules/deals/rfp-vote-service.ts` or the detail endpoint the page uses (`GET /deals/:id/detail`); `client/src/hooks/use-rfp-vote.ts`.

- [ ] **Step 1:** The `/rfp-vote` page already calls `GET /deals/:id/detail` (all columns). Confirm the payload includes every field the form needs (all address fields, estimator, project_type, company/contact, amount fields, bid_due_date, description, attachments). Add any missing to the detail projection.
- [ ] **Step 2:** Add a derived `rfpVoteLocked` boolean to the vote state (`computeRfpVoteState` or the page payload): true once the round has ≥1 approve vote. The page uses it to switch editable→read-only.
- [ ] **Step 3:** Stop discarding fields in `useRfpVote` — expose the full deal + `rfpVoteLocked` + an estimator-options list.

---

## Task 4: Client — replicate SyncHub's 16-field editable form on `/rfp-vote`

**Files:** `client/src/pages/rfp-vote/rfp-vote-page.tsx`; Test: `client/src/pages/rfp-vote/rfp-vote-page.test.tsx`.

- [ ] **Step 1 (test-first):** component test — when round open + unlocked, all 16 fields render editable (project_types + estimator as selects); when `rfpVoteLocked`, fields render read-only + only the Approve/Reject + reason + Submit show; submitting Approve posts `{ decision:'approve', editedFields:{...16 fields} }`; changing project_types rewrites the project number in place (mirror SyncHub JS, using the shared `replaceProjectTypeInNumber` / resolver); selecting Service(4) shows the inline "cancel & re-trigger as service" warning and disables submit (option A).
- [ ] **Step 2:** Build the form sections mirroring SyncHub (Deal Information / Company & Contact / Location / Details / Attachments). Reuse existing CRM form primitives. Pre-fill from the full deal.
- [ ] **Step 3:** Attachments add/remove UI (mirror SyncHub's `attachmentsOverride` — kept `{name,url}` + new files). If attachment editing is heavy, phase it: v1 = display existing attachments read-only, editing deferred (flag it); the go/no-go value is the field edits.
- [ ] **Step 4:** Locked view: render committed values read-only with a "Locked by <first approver> — vote to confirm" banner.

---

## Task 5: Server/Worker — enrich the vote-invitation email to SyncHub's field set

**Files:** `worker/src/jobs/rfp-vote-invitation.ts` (`buildRfpVoteInvitationEmail`); `server/src/modules/deals/rfp-enqueue.ts` (`enqueueRfpVoteInvitation` payload).

- [ ] **Step 1:** The invitation payload currently carries only dealId/dealNumber/dealName/officeId/roundEventId/recipients. Enrich it (or load the deal in the job) so the email can show SyncHub's ~10 fields: project type, project number (canonical), amount, company, location, estimator, owner, description, attachments.
- [ ] **Step 2:** Rebuild the email body to SyncHub's `rfp_review` layout (label/value rows + banner). Keep the "Cast your vote" CTA. Test the field rendering (unit test on the builder).

---

## Task 6: Wire-up, gate, and pre-PR review

- [ ] **Step 1:** Run the full gate `npm run check:premerge` (build + typecheck:tests:all + test:ci + test:scripts) — see memory `pre-pr-subagent-review` VALIDATION GOTCHA (don't keyword-filter).
- [ ] **Step 2:** Heavy pre-PR adversarial subagent review (memory `pre-pr-subagent-review`): lenses = (a) the first-YES lock race (two concurrent approves — the tally `FOR UPDATE` must serialize so exactly one "first approve" applies edits), (b) scope-lock bypass safety (only this authorized voter path bypasses; the public PATCH stays locked), (c) type-4 guard can't be evaded via an edited project number, (d) create payload uses the committed (edited) deal (DB-authoritative — verify end to end), (e) reconciliation-consistency (email/form/create all use the same field set + canonical number). Fix findings BEFORE opening the PR.
- [ ] **Step 3:** Open the PR; keep it INERT-safe (the flag `ENABLE_RFP_VOTING` is currently false, so this ships dark until Adnaan re-flips).

---

## RESOLVED decisions (Adnaan, 2026-07-06) — build to these

- **Estimator = free-text name only (SyncHub-literal).** Dropdown lists CRM users (reuse `GET /users/sales-reps?purpose=deal-reassignment` = active-office users, `isCrmUserRole` = not field_contractor). On commit, write the selected user's **display name** to `deals.estimator` (the column `buildNormalizedRfpRequestBody` reads: `estimator ?? bid_board_estimator`). **Do NOT** write `estimator_user_id` and **do NOT** call `setDealEstimator` — no commission re-attribution, no bid-board/sales-source guards. The free-text `deals.estimator` is authoritative for the payload.
- **Editable set A.** Editable: `name`, project number (formatted — see below), amount, project type (rewrites the number; Service/`4` blocked), estimator (free-text name), bid due date, address block (`property_address/city/state/zip/country`), `description`. **Read-only context** (display, not editable): company name, primary contact (name/email/phone), attachments. **Omit** notes (no column; description covers it).
- **Project number = the FORMATTED number, NEVER the raw HubSpot id.** Task 0: `buildNormalizedRfpRequestBody` sends `resolveDealDisplayNumber({ projectNumber: deal.projectNumber, dealNumber: deal.dealNumber })` (canonical `project_number` first; bid-board `deal_number` fallback; HS ids guarded out by `isHubspotImportedDealNumber` → `null`/Pending, never the HS id). The vote form's "Project Number" field shows/edits `deals.project_number` (canonical).

### Column-write map (discovery-confirmed, `shared/src/schema/tenant/deals.ts`)
- `name` → `deals.name`
- project number → `deals.project_number` (canonical; edited value). Payload reads via resolver above.
- amount → **`deals.bid_estimate`** (RFP = a bid; `awarded_amount` is null pre-award so `bid_estimate` wins the payload COALESCE `awarded_amount→bid_estimate→dd_estimate→forecast_revenue`; semantically correct + edit sticks). Do NOT write `awarded_amount`.
- project type → `deals.project_type` (+ rewrite `deals.project_number` type digit via `buildIntendedProjectNumber`); block Service (`4`). `project_type_id` left as-is (no numeric 1–9 PK; the "id" is the code string).
- estimator → `deals.estimator` (free-text display name; see above).
- bid due date → `deals.bid_due_date` (timestamptz).
- address → `deals.property_address / property_city / property_state / property_zip / property_country`.
- description → `deals.description`.
- READ-ONLY (never written by the apply): company (`company_id`→companies.name), contact (`primary_contact_id`→contacts.name/email/phone), attachments.
- FROZEN (never touched): `deal_number`, `sourceLeadId`, `workflowRoute`, `estimator_user_id`.

### Detail-payload gap to close (Task 3)
`getDealDetail` does NOT project `contacts.email` / `contacts.phone` — add them to the contacts leftJoin so the read-only contact context can render. Everything else the form needs is already in the payload (all deals columns via `getTableColumns`).
