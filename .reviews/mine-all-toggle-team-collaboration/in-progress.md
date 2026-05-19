# Mine/All Toggle Team Collaboration - In Progress

- Branch: `feat/mine-all-toggle-team-collaboration`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-mine-all-toggle-team-collaboration`
- Started: 2026-05-18
- Scope:
  - Wire `/deals` and `/leads` Mine/All visibility so reps can opt into same-office teammate records
  - Preserve office boundary and mailbox scoping while expanding collaborator reads
  - Allow collaborator-tier notes, activities, email attachment, file/photo attachment, and detail reads
  - Keep owner-only mutations blocked for edit/stage/won-lost/delete/relationship/commission surfaces
  - Strip or omit commission/private rep-only fields for non-owners
- Explicit avoid-path:
  - `server/src/modules/deals/service.ts`

Coordination notes:
- `feat/cleanup-mode-all-fields-editable` owns cleanup-mode bypass behavior; this branch must not regress that path.
- `fix/file-attachments-expansion` is adjacent to lead/deal file visibility; any upload/read authorization changes here stay narrow to same-office collaborator access.
- Assumption: deal/lead commission/private fields are either absent from the current detail payload or can be safely stripped by deny-list without changing owner responses.
