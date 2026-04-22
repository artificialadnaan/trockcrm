# Lead Go/No-Go Approval Handoff Design

## Goal

When a lead reaches `Lead Go/No-Go`, the assigned sales rep should be able to provide recommendation context, but only directors and admins can record the actual approval decision that allows the lead to advance to `Qualified for Opportunity`.

## Design

- Keep `Lead Go/No-Go` as the rep-owned intake stage.
- On transition into `Lead Go/No-Go`, create approval-request tasks and approval-needed notifications for all active director/admin users in the lead's office.
- Split the qualification panel into:
  - rep-visible recommendation fields
  - director/admin-only approval decision fields
- Preserve shared visibility so reps can see approval state and notes at all times.

## Data Model

- Extend `lead_qualification` with:
  - `goRecommendation`
  - `goRecommendationNotes`
- Keep existing `goDecision` and `goDecisionNotes` as the director/admin approval fields.

## Stage Rules

- `Pre-Qual Value Assigned -> Lead Go/No-Go`
  - allowed once the lead-scoping checklist is complete
  - entering the stage emits director/admin approval tasks and notifications
- `Lead Go/No-Go -> Qualified for Opportunity`
  - only `director` or `admin` may perform the move
  - requires `goDecision = "go"`
  - requires `goDecisionNotes`
- Reps may not mutate `goDecision` or `goDecisionNotes`.

## UX

- Qualification panel shows:
  - `Rep Recommendation`
  - `Rep Recommendation Notes`
  - `Approval Status`
  - `Director/Admin Decision`
  - `Director/Admin Decision Notes`
- Reps can edit only the recommendation fields.
- Directors/admins can edit both recommendation visibility and approval controls.
- If a rep tries to advance past `Lead Go/No-Go`, the blocker should state that director/admin approval is required.

## Testing

- Server tests for:
  - approval task/notification creation on entry to `Lead Go/No-Go`
  - rep blockage on approval decision updates
  - rep blockage on moving to `Qualified for Opportunity`
  - director/admin success path
- Client tests for:
  - role-aware qualification panel controls
  - approval-required blocker messaging
