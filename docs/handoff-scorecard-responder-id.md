# Handoff — scorecard-driven corrective-action recipient (ID-based redesign)

## Your task
Finish the feature: **the superintendent/PM a field user PICKS on the T-Rock Cam scorecard dropdown becomes the corrective-action (and completion) email recipient + token holder for that scorecard's card.** This replaces the closed PR #954 (name-only approach) with a clean, ID-based, resolve-at-send-time design.

## Environment
- Repo: `/Users/adnaaniqbal/Developer/trockcrm` (monorepo: `shared`, `server`, `worker`, `client`, `mobile`). `mobile` is Expo/expo-router, NOT an npm workspace.
- **Work in the worktree** `/Users/adnaaniqbal/Developer/trockcrm/.worktrees/scorecard-responder-picker`, branch **`feat/scorecard-responder-id`** (off `origin/main`, already pushed). Never touch the main checkout; the FS is case-insensitive.
- Related merged history + context: memory file `field-responders-roster.md` (#950 roster, #951 scorecard picker, #952 concurrency fixes — all on main; EAS build #30 shipped the picker to TestFlight).

## Why the redesign (don't repeat #954's mistakes)
#954 stored NAME-only and, from inside the scorecard submit/edit transaction, wrote a `deal_team_members` row (assign-from-roster, only-if-unset). Across review rounds the asks **contradicted each other** — "add a `FOR UPDATE` lock" ⇄ "that lock deadlocks vs the Team-tab path"; "restart the notification cycle" ⇄ "the restart deadlocks vs a concurrent edit". Plus a real P1: a field user who *types* an off-roster name that happens to match a roster member gets that member silently assigned + emailed (name-only can't distinguish typed from picked).
**Root causes:** (a) writing to `deal_team_members` from the scorecard txn fights concurrent Team-tab/edit row-locking; (b) name-matching is ambiguous. **The redesign avoids BOTH: capture the picked responder ID, resolve at send time, no deal-team write.**

## Design (Adnaan approved)
- Store WHICH roster person was picked per role on the scorecard (`field_scorecards.superintendent_responder_id` / `pm_responder_id`), separate from the free-text display names.
- **Resolve recipients at SEND time**, no deal-team write. Rule, per role: **scorecard pick WINS → else fall back to the deal's Team-tab super/PM.**
- Applies to all three: the corrective-action email, the completed-scorecard email, AND token authz.

## DONE (1 commit on the branch — verify with `git log origin/main..HEAD`)
- `migrations/0199_field_scorecards_responder_link.sql` — adds `superintendent_responder_id` / `pm_responder_id` (nullable FK → `field_responders(id) ON DELETE SET NULL`), idempotent DO-loop over `office_*` + a `-- TENANT_SCHEMA_START/END` block (provisioner replays the block). **0199 is claimed; if another PR lands 0199 first, `git mv` to renumber.**
- `shared/src/schema/tenant/field-scorecards.ts` — bare `uuid` columns `superintendentResponderId` / `pmResponderId` (FK lives in the migration, per this file's convention).
- `shared/src/types/field-scorecard.ts` — `superintendentResponderId?`/`pmResponderId?` on `ScorecardSubmissionInput` + `ScorecardUpdateInput`.
- `server/src/modules/field/scorecard-submission.ts` — `ParsedScorecardSubmission`/`ParsedScorecardUpdate` gained the two ids; a `uuidOrNull()` helper; both parser return objects emit them (lenient uuid-or-null — the link is optional; the service revalidates).
- shared builds clean (`npm run -s build --workspace shared`); server typecheck clean; `scorecard-submission-parse` test green.

## REMAINING — three chunks

### Chunk 1 — Server storage (low risk)
- Add `superintendentResponderId?`/`pmResponderId?` to `CreateFieldScorecardInput` (`scorecards-service.ts` ~L69-93) and `UpdateFieldScorecardInput` (~L95-110).
- Add a validator, e.g. `resolveValidResponderId(tenantDb, id, role): Promise<string|null>` — returns `id` only if it's an **active** `field_responders` row of the matching role, else null (guards a client sending a stale/mismatched/other-role id). Put it in `field-responders-service.ts`.
- `createFieldScorecard`: resolve each id, store `superintendent_responder_id`/`pm_responder_id` on the insert (values block ~L285-286 alongside `superintendentName`/`pmName`).
- `updateFieldScorecard`: same on the `.set(...)` (note there are TWO `.set` sites with `superintendentName` ~L547-548 and ~L651-653 — read the fn to see which is the scorecard-row update vs a re-insert path; update the scorecard row).
- Route wiring: `server/src/modules/field/routes.ts` — POST scorecards (`createFieldScorecard` call ~L1024) and PUT (`updateFieldScorecard` ~L1112) pass `parsed.superintendentResponderId` / `parsed.pmResponderId`.
- Tests: `field_scorecards` responder columns now come from `tenantSchemaSql([...])` automatically. Any harness whose resolver hits `field_responders` must include `fieldResponders` in its `tenantSchemaSql` list (see how the closed #954 added it to 6 scorecard harnesses — same list edit).

### Chunk 2 — Send-time resolution (SENSITIVE — the 16-round corrective-action/token path)
Read first: `server/src/modules/field/corrective-action-recipients.ts` (`resolveCorrectiveActionRecipients(db, dealId)` + `isAssignedCorrectiveActionResponder`), `server/src/modules/deals/team-service.ts` (`resolveActiveScorecardTeamRows` / `resolveScorecardTeamEmails`), `worker/src/jobs/scorecard-corrective-action-email.ts` (recipient resolution at send time), and the corrective-action token routes/authz (`server/src/modules/field/corrective-action-routes.ts` and `authorizeCorrectiveAction` / verify-time revalidation).
- Make resolution **scorecard-scoped**: for a card (which belongs to a scorecard), for each role, if the scorecard has a `*_responder_id` → resolve that ACTIVE `field_responders` email (userId null → responds via the token web page); else fall back to the existing deal-team resolution. A `resolveCorrectiveActionRecipientsForScorecard(db, scorecardId)` is likely cleaner than mutating the deal-scoped fn (which is shared with token authz — changing it affects both; decide deliberately).
- Completion email (`resolveScorecardTeamEmails`, used in `createFieldScorecard` enqueue + `updateFieldScorecard` payload refresh): prefer the scorecard's picked responder → else deal team.
- Token authz: a token minted for a scorecard-picked (email-only) responder must validate. The verify-time revalidation must re-resolve the SCORECARD's picked responder, not only the deal team. Trace carefully.
- NO deal-team write anywhere in the scorecard path → no advisory locks, no `restartCycleForNewResponder`, no deadlocks.

### Chunk 3 — Mobile (needs EAS build #31)
- `mobile/src/components/ResponderPicker.tsx` — the pure picker's `onChange` (currently `(name)=>...`) should also report the picked responder's `id` (undefined/null when the user types instead of selecting a row). Update the prop type + the wrapper.
- `mobile/src/scorecards/draft.ts` — store `superintendentResponderId`/`pmResponderId` (set on a roster pick; CLEAR when the name is edited to something that isn't the picked person). Add reducer actions.
- Submission payload — include the two ids (mobile submit path / `mobile/src/api`).
- Wire the 3 picker call sites: `mobile/app/(app)/scorecards/[draftId].tsx` `OverviewStep` + `SetupStep`, and `mobile/app/(app)/scorecards/leadership/[draftId].tsx`.
- Validate: `cd mobile && npx tsc -p tsconfig.json --noEmit` (0 errors) + `EXPO_PUBLIC_API_BASE_URL=https://api.test.local npx jest src/components src/scorecards`. (`mobile/node_modules` must be installed — `npm install` in `mobile/` if missing.)
- **EAS build #31** (only after Adnaan says go): `cd mobile && npx eas-cli build --platform ios --profile production --auto-submit --non-interactive --no-wait`. There is NO OTA (`expo-updates` not installed), so the mobile change reaches devices ONLY via this build. The server parts deploy without a rebuild but stay unused until the app sends the ids.

## Validation / process
- Typecheck: `npm run -s typecheck --workspace shared|server|client`. After schema/type edits: `npm run -s build --workspace shared` (do NOT run concurrently with other shared builds).
- Server tests: `npm run -s test --workspace server -- <pattern>`.
- Open the PR against `main`. After every push, trigger `@codex review` + `@coderabbitai review` + `@macroscope-app review`.
- `build-gate` CI runs server+client vitest only (NOT mobile), and GitHub sometimes lags/drops `pull_request:synchronize` on rapid pushes — verify by SHA via `gh api repos/artificialadnaan/trockcrm/commits/<sha>/check-runs` and via `gh run list --branch <branch>`.
- Adnaan runs all prod writes/deploys himself; delegate the EAS build only on his explicit go.
- This touches the hardened corrective-action path — after implementing, run an adversarial verification pass (independent skeptics per fix) before declaring green.
