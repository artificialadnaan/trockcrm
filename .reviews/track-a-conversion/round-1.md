# Round 1 Review Request

## Scope

Fix lead-to-deal conversion so a successor deal inherits `projectTypeId` from the source lead when conversion input omits it or explicitly sends `null`. Preserve the existing behavior where a non-null conversion input value wins.

## Discovery

See `.reviews/track-a-conversion/discovery.md`.

## Diff Under Review

Review the current working tree diff:

```sh
git diff -- server/src/modules/leads/conversion-service.ts server/tests/modules/leads/conversion-service.test.ts .reviews/track-a-conversion/discovery.md
```

## Verification So Far

Red check before implementation:

```text
npx vitest run server/tests/modules/leads/conversion-service.test.ts
2 failed, 62 passed
- carries lead projectTypeId into the successor deal when conversion input omits it
- preserves lead projectTypeId when conversion input explicitly sends null
```

Green check after implementation:

```text
npx vitest run server/tests/modules/leads/conversion-service.test.ts
1 passed file, 64 passed tests
```

Broader module check:

```text
npx vitest run server/tests/modules/leads server/tests/modules/deals
37 passed files, 6 failed files
480 passed tests, 7 failed tests
```

The failures are outside the modified conversion path:

- `server/tests/modules/leads/reassignment.test.ts`
- `server/tests/modules/deals/board-service.test.ts`
- `server/tests/modules/deals/contract-signed-date.test.ts`
- `server/tests/modules/deals/ownership-service.test.ts`
- `server/tests/modules/deals/pipeline-team-scope.test.ts`
- `server/tests/modules/deals/routing-service.test.ts`

Typecheck:

```text
npm run typecheck
exit 0
```

## Reviewer Checklist

- Verify the implementation matches discovery.
- Confirm tests cover omitted, override, and explicit null conversion input.
- Hunt for behavioral regressions on existing conversion call sites.
- Confirm no frontend change was made.
- Confirm no schema changes or migrations were created.
- Confirm the fix is backend-only and narrow.

# Round 1 Review Response

## Status Per Concern

- Fixed: Implementation matches discovery. `server/src/modules/leads/conversion-service.ts` now uses `input.projectTypeId ?? lead.projectTypeId ?? undefined`, matching the discovery conclusion.
- Fixed: Non-null override still wins. The override test passes `projectTypeId: "project-type-input"` and expects that value on the successor deal.
- Fixed: Omitted and explicit `null` now preserve the source lead value. Covered by the two new regression tests.
- Fixed: Tests would fail before and pass after based on recorded evidence and diff. The pre-fix expression passed only `input.projectTypeId`, so omitted/null inputs reached `createDeal` as null.
- Fixed: Existing conversion call sites look safe. The live dialog path sends no body via `convertLeadToOpportunity`, so it benefits from the lead fallback without frontend changes. The generic conversion APIs already type `projectTypeId?: string | null`.
- Fixed: No frontend change was made. The diff only touches server conversion code, server conversion tests, and review artifacts.
- Fixed: No schema change or migration was made. The tracked diff excludes `shared/src/schema/**` and `migrations/**`.
- Fixed: Type safety and explicit null behavior are sound. `ConvertLeadInput.projectTypeId` now accepts `string | null`, while the value passed into `createDeal` remains `string | undefined` because nullish coalescing removes null. That matches `CreateDealInput.projectTypeId?: string`.

## Blocking Issues

None found.

## Non-Blocking Suggestions

The regression tests are correct but repetitive. A small fixture helper for the base lead and create-deal stub would reduce test maintenance, but this should not block the focused backend fix.
