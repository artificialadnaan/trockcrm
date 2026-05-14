# Scoping Form UX - In Progress

- Branch: `fix/scoping-form-ux`
- Started: 2026-05-14
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-scoping-form-ux`
- Files-touched list (expected; discovery will refine):
  - Deal scoping form root component
  - Deal scoping form sidebar / scoping progress navigation
  - Deal scoping form attachments section
  - Deal scoping form scope section
  - Focused tests for sidebar scroll, optional attachments, scope required validation, and inline scope save behavior
  - `scripts/smoke-scoping-form-ux.ts`
  - `.reviews/scoping-form-ux/discovery.md`
  - `.reviews/scoping-form-ux/final.md`
- Migrations: NONE expected
- Permission-system changes: NONE
- Estimated merge ETA: after discovery, implementation, 3 subagent review rounds, rebase, PR, self-merge, Railway deploy watch, and production smoke.

## Coordination Notes

- Owns: sidebar nav anchor behavior, blocking-item scroll targeting, attachment required-status removal for Scope docs and Site photos, Scope section hierarchy, and scope-item inline save behavior.
- Does not own: Estimator Consultation Notes field internals. `fix/estimator-notes-backspace` owns that field and related input-clobbering/autosave investigation.
- Coordination assumption: if `fix/estimator-notes-backspace` lands first, this branch will rebase and adopt its autosave/state ownership pattern. If this branch lands first, it will document the scope-selection autosave pattern in discovery/final notes.
