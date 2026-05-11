# Stage Drill-down Scope Discovery

Date: 2026-05-11
Issue: #165

## Bug Location

- `client/src/lib/pipeline-scope.ts:20-29`
- `normalizePipelineScope` accepts `requestedScope` but ignores it:
  - rep always resolves to `mine`
  - director always resolves to `team`
  - admin always resolves to `all`

That means an explicit URL scope such as `?scope=all` can be normalized away to the role default.

`useNormalizedStageRoute` currently has local scope logic at `client/src/lib/pipeline-scope.ts:48-76`. It partially preserves explicit stage scopes, but it does not reuse the shared normalizer and test coverage does not cover the full /deals + /leads matrix.

## Role Hierarchy

- rep: valid scope is `mine` only
- director: valid scopes are `mine`, `team`, `all`
- admin: valid scopes are `mine`, `team`, `all`

Current defaults:

- rep: `mine`
- director: `team`
- admin: `all`

## Expected Behavior

- If `?scope=X` is present and valid for the user's role, preserve it.
- If `?scope=X` is missing, use the role default.
- If `?scope=X` is invalid for the role, fall back to the role default.
- Reps must stay constrained to `mine` even when the URL says `team` or `all`.
- The same behavior applies to both `/deals/stages/:stageId` and `/leads/stages/:stageId`.

## Bug

The shared role/scope normalizer overrides explicit scope with the role default. This causes director/admin drill-down routes to disagree with the broader scope selected on the originating list/dashboard page.
