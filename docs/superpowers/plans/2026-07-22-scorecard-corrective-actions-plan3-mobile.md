# Scorecard Corrective Actions — Plan 3: TRock Cam Response Screen

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. TDD (jest — mobile) for logic; thin screens; commit per task; do NOT push.

**Goal:** In the TRock Cam app, an assigned superintendent/PM (a CRM user) can open a below-band scorecard's corrective-action flow — via the email deep link or the project's Scorecards list — see each flagged item, attach photos + a comment per item, and submit each response; the server marks the item resolved and auto-closes the scorecard on the last one.

**Architecture:** Builds on Plan 2's server API (`GET /field/scorecards/:id/corrective-actions`, `POST /field/scorecards/:id/corrective-actions/:itemId`). Mobile is Expo/expo-router; logic lives in `mobile/src/**` (jest-tested), screens are thin. Reuses the existing upload queue (to turn captured photos into uploaded `fileId`s), `CameraCapture`, `PhotoCaptionEditor`, `VoiceRecorder`, and `useAuth`.

**Tech Stack:** React Native, Expo Router, @tanstack/react-query, jest (`jest-expo`).

**Spec:** `docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md` §7.1, §7.3.

**Reference reading (verify + adapt — do not blind-paste):**
- Plan 2 server API: `server/src/modules/field/corrective-action-api.ts` + `corrective-action-routes.ts` — the EXACT GET response shape (items: id/itemType/itemRef/itemLabel/status/responseComment/respondedByName/respondedAt + any photos) and the POST body (`{ comment, photoFileIds? }`).
- `mobile/src/api/endpoints.ts` + `mobile/src/api/client.ts` + `mobile/src/api/types.ts` — how mobile API calls + types are declared (e.g. `getProjectPhotos`, `createScorecard`).
- `mobile/src/query/hooks.ts` — `useScorecard`, `useProjectScorecards` query-hook idiom + query keys (`qk`).
- `mobile/src/scorecards/submit.ts` — how a scorecard submit turns draft photos into uploaded files via `enqueueUploads` + `drainUploadQueue` + `getQueuedUploads`; reuse this to upload response photos and collect their `fileId`s.
- `mobile/src/capture/` (`CameraCapture`, `session-photo.ts`, upload queue) + `mobile/src/components/PhotoCaptionEditor.tsx` + `VoiceRecorder.tsx`.
- `mobile/app/(app)/scorecards/view/[id].tsx` + `mobile/app/(app)/scorecards/[draftId].tsx` — screen structure, `useLocalSearchParams`, `useAuth`, navigation.
- `mobile/app/(app)/projects/[id].tsx` — the Scorecards section (to add a "Corrective action required" entry) + how it reads scorecard status.
- `mobile/app/_layout.tsx` / expo-router linking config — for the deep-link route.

---

### Task 1: Mobile API client — read items + submit a response

**Files:**
- Modify: `mobile/src/api/endpoints.ts` (add `getCorrectiveActions`, `submitCorrectiveActionResponse`); `mobile/src/api/types.ts` (add the item type)
- Test: `mobile/src/api/__tests__/corrective-actions.test.ts`

- [ ] **Step 1: Read Plan 2's GET/POST shapes** in `server/.../corrective-action-api.ts` and mirror them EXACTLY in a `CorrectiveActionItem` type + the two client fns. Type sketch (adjust to the real server response):
```ts
export type CorrectiveActionItem = {
  id: string; itemType: "action_item" | "critical_deficiency"; itemLabel: string;
  status: "open" | "resolved"; responseComment: string | null;
  respondedByName: string | null; respondedAt: string | null;
  photos: { id: string; fileId: string; url: string | null; caption: string | null }[];
};
export type CorrectiveActionsResponse = { scorecardId: string; status: string; items: CorrectiveActionItem[] };
```

- [ ] **Step 2: Failing test** with a mock `Fetcher` asserting `getCorrectiveActions(fetcher, id)` GETs `/field/scorecards/:id/corrective-actions` and returns the parsed items, and `submitCorrectiveActionResponse(fetcher, id, itemId, { comment, photoFileIds })` POSTs the right body.

- [ ] **Step 3: Implement** both fns in `endpoints.ts` following the existing endpoint idiom. Run test → pass.

- [ ] **Step 4: Commit** — `feat(trockcam): API client for corrective-action items + responses`

---

### Task 2: Response state + submit orchestration (per item)

**Files:**
- Create: `mobile/src/scorecards/corrective-action.ts` (pure-ish: per-item response draft state + a `submitCorrectiveActionItem` orchestrator that uploads photos then POSTs)
- Test: `mobile/src/scorecards/__tests__/corrective-action.test.ts`

- [ ] **Step 1: Failing tests** for: (a) a small reducer/state that holds, per item, a list of captured response photos + a comment (add photo, set caption, remove photo, set comment); (b) `submitCorrectiveActionItem(fetcher, ownerKey, { scorecardId, itemId, photos, comment })` uploads the photos via the existing queue (`enqueueUploads`→`drainUploadQueue`→collect `fileId`s), then calls `submitCorrectiveActionResponse` with those `photoFileIds`; on a still-pending/failed upload it returns a `photos_pending`/`photos_failed` status (mirror `submit.ts`'s classification), else `resolved`.

- [ ] **Step 2: Implement**, reusing `submit.ts`'s upload pattern (import the same queue fns). Keep it minimal + mirror `scorecardPhotoUploadInput`. Run tests → pass.

- [ ] **Step 3: Commit** — `feat(trockcam): corrective-action per-item response state + upload orchestration`

---

### Task 3: Query hook

**Files:**
- Modify: `mobile/src/query/hooks.ts` (add `useCorrectiveActions(scorecardId)` + a `qk.correctiveActions` key)
- Test: extend an existing hooks test if the repo tests hooks, else skip test (thin wrapper) and note it.

- [ ] **Step 1:** Add `useCorrectiveActions` mirroring `useScorecard` (same `useQuery` idiom, keyed on user + scorecardId, calls `getCorrectiveActions`). Add the query key.
- [ ] **Step 2:** Typecheck (`cd mobile && npx tsc --noEmit -p tsconfig.json`). Commit — `feat(trockcam): useCorrectiveActions query hook`

---

### Task 4: The corrective-action response screen

**Files:**
- Create: `mobile/app/(app)/scorecards/corrective-action/[id].tsx`
- Test: none (thin screen; logic is covered in Tasks 1–2). Manual-QA notes in the PR.

- [ ] **Step 1: Build the screen.** `useLocalSearchParams<{ id, token? }>()`, `useAuth`, `useCorrectiveActions(id)`. Render the scorecard's items: each item shows its label + status; an open item exposes a photo capture (reuse `CameraCapture` + the per-item response state from Task 2) + a comment field (`PhotoCaptionEditor`/plain TextInput + `VoiceRecorder` gated on `useQuery(["transcribe-config"])` like the other screens) + a "Submit response" button that calls `submitCorrectiveActionItem` and, on `resolved`, invalidates `qk.correctiveActions` + the scorecard query. A resolved item renders read-only (comment + photos + responder + date). When all items are resolved, show a "Corrective action complete" state. Match the existing scorecard screens' styling/components (SafeAreaView, ScreenHeader, theme). Gate photo upload states like `[draftId].tsx` (disable submit while `savingPhotos > 0`).

- [ ] **Step 2:** `cd mobile && npx tsc --noEmit -p tsconfig.json` → 0 errors. Commit — `feat(trockcam): corrective-action response screen (itemized photos + comments)`

---

### Task 5: Entry points — deep link + project list affordance

**Files:**
- Modify: expo-router linking config (`mobile/app/_layout.tsx` or wherever `Linking`/`scheme` is configured; check `app.json`/`app.config.ts` for the URL scheme) so `.../scorecards/:id/corrective-action` (and a `token` query param) routes to the Task-4 screen.
- Modify: `mobile/app/(app)/projects/[id].tsx` — in the Scorecards list, when a scorecard's `status === "corrective_action_open"`, show a "Corrective action required" badge/button that routes to the response screen; a `corrective_action_closed` shows a "Resolved" badge.
- Test: none (wiring); verify via typecheck.

- [ ] **Step 1:** Confirm the app's URL scheme (grep `app.config.ts`/`app.json` for `scheme`). Ensure the file-based route `mobile/app/(app)/scorecards/corrective-action/[id].tsx` is reachable by the deep link the email builds (`${FRONTEND_URL}/scorecards/:id/corrective-action?token=...` for web; the app deep link for users — align the email's user deep link with this route; if the email currently builds a web URL for users too, that's fine for v1 as long as the app registers the https route via expo-router universal links — VERIFY what Plan 2's worker builds for the USER deep link and make the app route match it; if misaligned, adjust the worker's user-link builder to the app route).
- [ ] **Step 2:** Add the project-list affordance reading scorecard `status`. `cd mobile && npx tsc --noEmit` + `npx jest` (the mobile suites you touched) → green. Commit — `feat(trockcam): corrective-action deep link + project-list entry`

---

## Self-review (authoring)
- **Spec coverage:** §7.1 in-app itemized response (users) → Tasks 1–4; §7.3 uses the Plan 2 API → Task 1; deep link from the email → Task 5.
- **Type consistency:** `CorrectiveActionItem`/`CorrectiveActionsResponse`, `submitCorrectiveActionItem`, `useCorrectiveActions`, `qk.correctiveActions`, and the `corrective_action_open`/`closed` status strings match the server + Plans 1–2.
- **Deferred to Plan 4:** the email-only web responder page + the Team-tab email-only config UI + inline thread in the deal tab + QC dashboard status. Verify Task 5 aligns the USER deep link with the worker's link builder.
