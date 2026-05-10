# Deal Detail Card Display Discovery

Date: 2026-05-10
Branch: fix/deal-detail-card-display

## Files Read

- `client/src/pages/deals/deal-detail-page.tsx`
- `client/src/pages/deals/deal-detail-page.test.tsx`
- `client/src/hooks/use-deals.ts`
- `server/src/modules/deals/service.ts`
- `server/src/modules/deals/routes.ts`
- `shared/src/schema/tenant/deals.ts`
- `shared/src/schema/public/project-type-config.ts`

## Findings

The deal detail sidebar is rendered by `DealRightRail` inside `client/src/pages/deals/deal-detail-page.tsx`.

Project type display currently uses `formatDealType(deal)`, which returns `deal.projectType` directly when present. The React rendering layer does not call `.toLowerCase()` for this field. The lowercase value is coming from server-side deal data: `server/src/modules/deals/service.ts` normalizes project type names to lowercase in update paths, and `getDealDetail` currently selects raw deal columns without joining `public.project_type_config` for the proper-cased label.

The current identifier rail section is:

```tsx
<DetailRailSection title="Deal number">
  <DetailRailItem label="Deal" value={<span className="font-mono">{deal.dealNumber}</span>} />
  ...
  <DetailRailItem label="Close target" value={formatDate(deal.expectedCloseDate)} />
</DetailRailSection>
```

The current `System IDs` section starts with HubSpot, then Procore project, Procore company, Procore bid, and Bid Board #. There is no separate row for the CRM deal ID / `dealNumber`.

The tenant deals schema has both `dealNumber` (`deal_number`) and `projectNumber` (`project_number`). `getDealDetail` uses `getTableColumns(deals)`, so the API response already includes `projectNumber`, but the frontend `Deal` type does not declare it and the sidebar does not render it.

## Implementation Scope

- Add `projectNumber` to the frontend deal type.
- Join `project_type_config` in `getDealDetail` and select `projectType` from the config name when available, preserving proper casing on the detail page.
- Replace the rail section with a `Project number` section that prefers `deal.projectNumber` and falls back to muted `deal.dealNumber` with a `Not yet assigned` caption.
- Add `Deal ID` as the first row in `System IDs`.
- Preserve `Close target` in the same rail section.

