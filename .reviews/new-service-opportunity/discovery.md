# New Service Opportunity Discovery

Date: 2026-05-14
Branch: `feat/new-service-opportunity`
Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-new-service-opportunity`

## 1. RFP Eligibility Field / Rule

There is no persisted boolean named `rfpEligible`, `rfp_eligible`, or `isRfpEligible`.

RFP eligibility is determined by the manual trigger path in `server/src/modules/deals/routes.ts`:

- Deal must be in canonical `opportunity` stage.
- `rfp_approval_requested_at` must be null.
- `rfp_approval_status` must be null.
- `is_bid_board_owned` must be false.
- `bid_board_stage_slug` must be null or empty.
- `is_read_only_mirror` must be false.
- `read_only_synced_at` must be null.
- `bid_board_stage_entered_at` must be null.
- `bid_board_mirror_source_entered_at` must be null.
- Assigned rep/admin authorization must pass.
- `evaluateDealScopingReadiness()` must not be `draft` before the trigger can reserve/send the RFP.

For Service opportunities specifically, the critical routing field is:

- `deals.workflow_route = 'service'`

Production read-only comparison showed:

- Converted-from-lead Service opportunity sample: `project_type = 'service'`, `project_type_slug = 'service'`, `workflow_route = 'service'`, stage slug `opportunity`, RFP request fields null before trigger.
- Direct-created stuck Service opportunity sample: `project_type = 'service'`, `project_type_slug = 'service'`, but `workflow_route = 'normal'`, stage slug `opportunity`, RFP request fields null.

Implementation requirement: the new endpoint must create Service opportunities with `workflowRoute: "service"`, Project Type Service, canonical Opportunity stage, and the RFP/Bid Board ownership fields left in their eligible pre-trigger defaults listed above.

## 2. Existing New Deal Form Location / Reuse Decision

Existing direct-create UI:

- Page: `client/src/pages/deals/deal-new-page.tsx`
- Form: `client/src/components/deals/deal-form.tsx`
- Hook: `client/src/hooks/use-deals.ts#createDeal`
- Server route: `POST /api/deals` in `server/src/modules/deals/routes.ts`

Decision: build a fresh slim Service Opportunity form instead of cloning `DealForm`.

Reason: `DealForm` is a broad edit/create form with stage dropdown, project type dropdown, estimates, region, property address, Bid Board lock behavior, and update-mode concerns. The requested UI must hide stage and project type choices, lock Project Type to Service, and create through a dedicated server mode that forces Service workflow routing. Reusing selectors/hooks from `DealForm` is appropriate; cloning the entire component would carry too much unrelated behavior.

## Assumptions

- No migration is required.
- The existing New Deal form, `/deals/new` route, and `POST /api/deals` route remain in place.
- Because `fix/pipeline-display` has uncommitted work, this branch is based on its committed branch head and will rebase/stack again before merge if that branch is still unmerged.
