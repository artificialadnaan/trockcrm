# Lead Form Field Batch - In Progress

- Branch: `fix/lead-form-field-batch`
- Base: `origin/main` at `24f9c1c1bfd544af99620f79c87af377dd7ac12d`
- Started: 2026-05-14
- Scope: lead form field UI/validation fixes, dropdown option cleanup, estimated value/budget consolidation, life safety control conversion.
- Files touched list, initial declaration:
  - Lead form components: to be confirmed during discovery; expected `client/src/**/lead*`, shared lead form sections, and tests.
  - Deal scoping form components: only the Opportunity Review dropdowns for Pre-Bid Meeting Completed and Site Visit Decision if confirmed.
  - Shared enum/option constants: possible, if POC role, unanswered sentinel, budget/value, or life safety options are centralized.
  - Server/shared schema: possible, only to deprecate the non-surviving estimated value/budget field and add idempotent startup backfill if needed.
  - Migrations: possible inline/idempotent SQL only; no destructive drop in this PR.
  - Smoke script: `scripts/smoke-lead-form-batch.ts`.
- Permission-system changes: none.
- Estimated merge ETA: after discovery, implementation, review rounds, rebase, deployment, and production smoke; target same-day.

## Coordination Notes

- I will avoid unrelated lead/deal form changes and keep edits to the named field sections.
- If shared dropdown constants are touched, the final file list will be updated here and in `discovery.md`.
- The Estimated Value/Budget decision will be evidence-based from code references and production data counts before implementation.
