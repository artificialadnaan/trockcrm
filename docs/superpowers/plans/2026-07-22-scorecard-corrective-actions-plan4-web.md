# Scorecard Corrective Actions — Plan 4: Web (config, thread, dashboard, tokenized responder)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. TDD; commit per task; do NOT push. This is the FINAL plan; after it, the whole feature is pushed + PR'd.

**Goal:** Finish the client half — (1) a token-scoped photo upload so email-only responders can attach photos with no login; (2) the CRM web client API + hooks; (3) Team-tab UI to configure an email-only superintendent/PM (name+email); (4) inline "reply-thread" rendering of corrective actions under each flagged item on the deal Scorecards tab; (5) QC dashboard open/closed status filter+column; (6) the public tokenized web responder page.

**Architecture:** Builds on Plans 1–3 (branch `feat/scorecard-corrective-actions`). Server adds one token-scoped upload endpoint (reusing the file service); the rest is React (CRM client, `client/`). Reuses the Plan 2 API (`corrective-action-routes.ts`), `resolveCorrectiveActionRecipients`, the token service, and Plan 3's server `status`-on-summary.

**Tech Stack:** React + Vite + @tanstack/react-query (client), Express (server), Vitest (both), Drizzle/PGlite.

**Spec:** `docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md` §4.4, §7.2, §9.

**Reference reading (verify + adapt):**
- Plan 2 server: `server/src/modules/field/corrective-action-routes.ts` + `corrective-action-api.ts` (the auth resolver, GET/POST shapes) + `corrective-action-tokens.ts`.
- File upload: the existing field photo-upload endpoint + `server/src/modules/files/service.ts` (`confirmUpload`) — how a file is created + linked to a deal; the R2/presign flow.
- `server/src/modules/deals/scorecards-service.ts` (the deal-tab scorecards `toSummary` — does NOT emit `status` yet) + `client/src/pages/deals/deal-scorecards-tab.tsx` (inline-thread target) + `client/src/hooks/use-qc-scorecards.ts` (client hook idiom).
- `client/src/pages/deals/deal-team-tab.tsx` + the team API endpoints (`GET/POST /deals/:id/team`) + `server/src/modules/deals/team-service.ts` (does the POST accept an email-only member — `userId` null + name/email? if not, add it).
- `client/src/pages/reports/qc-reports-page.tsx` + `server/src/modules/reports/qc-scorecards-service.ts` (add status filter+column).
- How client routes are declared (the router) + whether a PUBLIC (unauthenticated) route pattern exists (find the public photo-share page if any) — for the tokenized responder page.
- `client/src/lib/` API client + how client calls the server (fetch wrapper, auth header) — and how a TOKEN-authed call omits the session.

---

### Task 1: Server — token-scoped corrective-action photo upload

**Files:** add to `server/src/modules/field/corrective-action-routes.ts` (+ api helper); test `server/tests/modules/field/corrective-action-upload.test.ts`
- [ ] **Step 1: Failing test.** `POST /field/scorecards/:id/corrective-actions/upload` with a valid `?token` (or session) uploads an image and returns `{ fileId }`, the file created on the scorecard's deal; an invalid token → 401; a token for another scorecard → 403. Model the upload on the existing field photo-upload endpoint.
- [ ] **Step 2: Implement** using the SAME auth resolver as Plan 2's routes (session OR token whose scorecardId matches) and the existing file-create/`confirmUpload` service; the returned `fileId` is what the response POST's `photoFileIds` expects (fresh file, not existing evidence — Plan 2 already rejects existing-evidence ids). Run → pass.
- [ ] **Step 3: Commit** — `feat(field): token-scoped corrective-action photo upload`

### Task 2: Client API + hooks

**Files:** `client/src/lib/*` (API fns) + a hook file (e.g. `client/src/hooks/use-corrective-actions.ts`); test `client/src/hooks/use-corrective-actions.test.tsx` (or an API unit test matching the repo's client-test idiom)
- [ ] **Step 1: Failing test** for `getCorrectiveActions(scorecardId, token?)`, `submitCorrectiveActionResponse(scorecardId, itemId, body, token?)`, `uploadCorrectiveActionPhoto(scorecardId, file, token?)` — each hits the right URL and, when `token` is passed, appends `?token=` and omits the session auth header. Mirror the existing client API idiom.
- [ ] **Step 2: Implement** + a `useCorrectiveActions` query hook (session or token mode). Run → pass. Typecheck client.
- [ ] **Step 3: Commit** — `feat(web): client API + hook for corrective actions (session or token)`

### Task 3: Team-tab email-only member config

**Files:** `server/src/modules/deals/team-service.ts` + its route (accept email-only) if needed; `client/src/pages/deals/deal-team-tab.tsx`; tests for both
- [ ] **Step 1: Server — failing test + impl.** Verify whether the team POST accepts an email-only member (role super/PM, `userId` null, `member_name`+`member_email`). If not, extend it (validate: role in {superintendent, project_manager}, a valid email, name required; honor the `deal_team_members_identity_check`). Runtime test: adding an email-only super persists + `resolveCorrectiveActionRecipients` returns it.
- [ ] **Step 2: Client — UI.** In the Team tab's add-member flow, add an "email-only (external)" mode for the superintendent/PM roles capturing name + email (alongside the existing CRM-user picker). List email-only members distinctly. Match the tab's existing components/styling. Client test for the form logic (validation).
- [ ] **Step 3: Commit** — `feat(deals): configure an email-only superintendent/PM on the Team tab`

### Task 4: Inline corrective-action thread on the deal Scorecards tab

**Files:** `server/src/modules/deals/scorecards-service.ts` (include status + corrective-action items/responses in the detail the tab reads) + `client/src/pages/deals/deal-scorecards-tab.tsx`; tests
- [ ] **Step 1: Server — failing test + impl.** The deal-scorecards detail (what the tab expands) must include the scorecard `status` and, for a corrective-action scorecard, its items with any responses (comment, responder, date, photo count/ids). Add it (reuse Plan 2's `getCorrectiveActionItems` or a read in this service). Runtime test.
- [ ] **Step 2: Client — render the thread.** In the expanded scorecard detail, under each original action item / critical deficiency, render its corrective-action response inline (responder name + date + comment + photos) — the "reply to the thread"; show the open/closed status badge. Match the tab's styling. Client test for the render logic.
- [ ] **Step 3: Commit** — `feat(deals): inline corrective-action responses under scorecard items`

### Task 5: QC dashboard open/closed status

**Files:** `server/src/modules/reports/qc-scorecards-service.ts` + `client/src/pages/reports/qc-reports-page.tsx`; tests
- [ ] **Step 1: Server — failing test + impl.** The QC report row includes the scorecard `status`; add a filter (e.g. `?correctiveActionStatus=open|closed`) to the query. Runtime test that the filter narrows correctly.
- [ ] **Step 2: Client — column + filter.** Add a "Corrective Action" status column (Open/Closed/—) + a filter control to the QC reports page. Match the page's existing filter/column patterns (it already filters by rating/superintendent). Client test.
- [ ] **Step 3: Commit** — `feat(reports): corrective-action open/closed status on the QC dashboard`

### Task 6: Public tokenized web responder page

**Files:** a new client route `client/src/pages/scorecards/corrective-action-responder.tsx` (public, token-authed) + route registration; test the page logic
- [ ] **Step 1: Build the page.** Route `/scorecards/:id/corrective-action?token=...`, NO session required. Reads `token` from the query, calls `useCorrectiveActions(id, token)`; renders each open item with a photo upload (Task 1 `uploadCorrectiveActionPhoto` with the token → fileId) + comment, and a per-item submit (`submitCorrectiveActionResponse` with the token). Resolved items read-only; all-resolved shows a completion state. An invalid/expired token → a clear "link expired" message. Match the app's public-page shell (minimal, no nav) — mirror the public photo-share page if one exists.
- [ ] **Step 2: Register the route** in the client router at a PUBLIC (unauthenticated) path so a logged-out email recipient can use it. Client test for the token-mode data flow + the expired-token state.
- [ ] **Step 3: Commit** — `feat(web): public tokenized corrective-action responder page`

---

## Self-review (authoring)
- **Spec coverage:** §4.4 email-only config → Task 3; §7.2 web responder → Tasks 1+2+6; §9 inline thread → Task 4, dashboard status → Task 5.
- **Type consistency:** reuse the Plan 2 API shapes + Plan 3's client types where shared; the token param is optional across the client API; status strings `corrective_action_open`/`closed` are consistent.
- **After this plan:** the whole feature is built (server + mobile + web). Final step (controller, not a task): rebuild + full typecheck/tests across workspaces, push `feat/scorecard-corrective-actions`, open ONE PR, trigger the review bots.
