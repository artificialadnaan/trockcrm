# Redesign A1 Consistency Audit

Generated for PR #155 before merge.

## List/Detail Consistency Sweep

### Companies

| Field | List path | Detail path | Finding |
| --- | --- | --- | --- |
| Base company columns | `listCompanies()` selects `companies.*` | `getCompanyById()` selects `companies.*` | Consistent. Same table row is returned. |
| `contactCount` / `contactsCount` | Batch SQL counts active contacts where `contacts.company_id = c.id AND contacts.is_active = true` | `getCompanyStats()` counts active contacts with the same company/id predicate | Consistent. |
| `dealCount` / `activeDealsCount` | Batch SQL counts active deals where `deals.company_id = c.id AND deals.is_active = true` | `getCompanyStats()` counts active deals with the same company/id predicate | Consistent. |
| `propertiesCount` | Batch SQL counts active properties where `properties.company_id = c.id AND properties.is_active = true` | `getCompanyStats()` counts active properties with the same company/id predicate | Consistent. |
| `pipelineValue` | Batch SQL `SUM(COALESCE(awarded_amount, bid_estimate, dd_estimate, forecast_revenue, 0))::text` over active company deals | `getCompanyStats()` uses the same SQL aggregate over active company deals | Consistent. |
| Sort fields | List sorts by `companies.name` only | Detail has no sort path | Consistent / not applicable. |

### Contacts

| Field | List path | Detail path | Finding |
| --- | --- | --- | --- |
| Base contact columns | `getContacts()` explicitly selects the contact row fields | `getContactById()` explicitly selects the same contact row fields | Consistent. |
| `isPrimary` | `EXISTS` over `contact_deal_associations` for `contact_id` and `is_primary = true` | Same `EXISTS` expression | Consistent. |
| `linkedDealsCount` | Counts associated deals joined through `contact_deal_associations`, filtered to `deals.is_active = true` | Same count expression and active deal filter | Consistent. |
| `lastTouchAt` | `buildContactLastTouchAtSql()` = `GREATEST(last_contacted_at, latest activity, latest email, latest task)` | Same `buildContactLastTouchAtSql()` expression | Consistent. |
| `last_touch_at` sort | `buildContactSortOrder()` orders by `buildContactLastTouchAtSql()` | Detail has no sort path | Consistent / not applicable. |

### Properties

| Field | List path | Detail path | Finding |
| --- | --- | --- | --- |
| Base property columns | `listProperties()` selects the property row and joined company name | `getPropertyDetail()` selects the same property row and joined company name | Consistent. |
| `leadCount` | List counts active leads only: `leads.property_id IN (...) AND leads.is_active = true` | Detail now uses `buildPropertyRelationshipCounts()` and counts active leads only | Consistent after fix. |
| `dealCount` | List counts active deals only: `deals.property_id IN (...) AND deals.is_active = true` | Detail now uses `buildPropertyRelationshipCounts()` and counts active deals only | Consistent after fix. |
| `convertedDealCount` | List counts deals with `source_lead_id IS NOT NULL` | Detail uses `buildPropertyRelationshipCounts()` and counts deals with `sourceLeadId` | Consistent. This intentionally remains independent from active deal count so converted/won linkage still classifies as `won`. |
| `engagementStatus` | `classifyPropertyEngagementStatus()` with converted first, then active deals, then active leads | Same `classifyPropertyEngagementStatus()` using `buildPropertyRelationshipCounts()` | Consistent after fix. |
| `lastActivityAt` | `buildPropertyLastActivityAt(persisted, max lead activity, max deal activity)` | Same `buildPropertyLastActivityAt()` combination over persisted, lead, and deal activity | Consistent. |
| `linkedValue` / `activePipelineValue` | SQL aggregate over active deals: `SUM(COALESCE(awarded_amount, bid_estimate, dd_estimate, forecast_revenue, 0))::text` | Same SQL aggregate over active deals | Consistent. |
| `photosCount` | SQL union of active photo files linked through deals or leads for the property | Same SQL union with the single property predicate | Consistent. |
| Sort fields | List sorts by company name, property name, property address | Detail has no sort path | Consistent / not applicable. |

## Lead/Deal Field Continuity Investigation

The current codebase does not model lead and deal as one physical row. It has `leads` and `deals` tables linked by `deals.source_lead_id`, plus a lineage resolver that lets deal-stage scoping read selected source-lead fields. That is why some fields remain visible in the deal scoping workspace but not in the base deal overview/edit surfaces.

| Reported field | Deals column? | Lead write path | Deal-stage read path | Failure mode |
| --- | --- | --- | --- | --- |
| Bid due date | Yes: `deals.bid_due_date` as `timestamp with time zone`, nullable. Lead has `leads.bid_due_date` as `date`, nullable. | Lead create/edit writes `leads.bidDueDate`; V2 also mirrors `bid_due_date` into `lead_question_answers` when that node exists. Lead conversion does not copy it to `deals.bidDueDate`. | `useDealDetail` does not expose `deal.bidDueDate` on `Deal`. Deal scoping reads `resolved.bidDueDate` from `sourceLead.bidDueDate` via `getResolvedDeal()` and displays it in Opportunity Scope. | Other: separate lead/deal columns exist, but deal-stage continuity depends on the lineage resolver, not the base deal hook. Overview/edit can appear to lose it. |
| Property address / location details | Yes: `deals.property_address` text, `property_city` varchar(255), `property_state` varchar(2), `property_zip` varchar(10), all nullable. Lead stores `property_id`, not address columns; address lives on `properties`. | Lead create/edit writes `leads.propertyId`. Property address is captured on the linked property record. Lead conversion does not snapshot property address into deal columns. | Deal overview reads `deal.propertyAddress` fields from `useDealDetail`; deal scoping reads `resolved.propertyAddress/city/state/zip` from the linked property via `getResolvedDeal()`. | Other: address exists as property data and nullable deal snapshot columns. Deal overview can appear blank when deal snapshot columns were never populated, while scoping still resolves the property address. |
| Project scope / description | Yes: `deals.description` text, nullable. Lead also has `leads.description` text, nullable. | Lead create/edit writes `leads.description`. Conversion passes `lead.description` into `createDeal()`. Deal scoping edits route back to the source lead and compatibility-write through to `deals.description`. | `useDealDetail` exposes `description`; `DealOverviewTab` displays it; deal scoping uses `resolved.description`. | Column exists, written at lead stage, read by deal stage. This field is generally fine. |
| Estimated value / budget | Partially. Deals has `dd_estimate`, `bid_estimate`, `awarded_amount`, `forecast_revenue`, and `budget_status`, all nullable. Lead has `pre_qual_value`, `budget_status`, `qualification_budget_amount`, and `qualification_payload.estimated_value`. | Lead create/edit writes `budgetStatus` and `qualificationPayload.estimated_value`; conversion uses `preQualValue` only for route selection and does not map the lead estimate/budget into deal money columns. | Deal overview/header uses `bestEstimate(deal)` from deal estimate columns; `useDealDetail` exposes `forecastRevenue` and `budgetStatus`, but the UI does not read lead qualification estimate/budget for deal display. | Written to lead columns/JSONB that deal-stage UI does not query. Needs product decision on canonical money field before fixing. |
| Source / referral | Partially. Deals has `source` varchar(100), nullable. Lead has legacy `source`, plus `source_category` enum and `source_detail` text. | V2 lead create/edit writes `sourceCategory/sourceDetail` and intentionally stores legacy `leads.source` as null. Conversion maps only `lead.source` to `deals.source`, so V2 source category/detail are not copied. | `useDealDetail` exposes `source`; `DealOverviewTab` displays `deal.source`. The lineage resolver exposes `sourceCategory/sourceDetail/legacySource`, but the deal overview does not display those resolved values. | Other: V2 source is normalized into lead category/detail, while deal overview reads legacy `deals.source`. This can look like referral/source disappeared. |
| Decision-maker contact | Yes for contact FK: `deals.primary_contact_id` uuid nullable. Also yes for free text: `deals.decision_maker_name` varchar(255) nullable. Lead has `primary_contact_id` and `decision_maker_name`. | Lead form writes `primaryContactId`. The free-text `decisionMakerName` column exists, but the current lead form did not show a direct write path for it. Conversion copies `lead.primaryContactId` to `deals.primaryContactId`. | `useDealDetail` exposes `primaryContactId` and `decisionMakerName`; deal overview does not render the primary contact. The Lead tab fetches and displays the source lead. | Written but not meaningfully exposed in the deal-stage overview. If product means the free-text decision-maker name, that appears to be a dormant column/input gap. |
| Inspection / walkthrough date | No direct `deals` date column found for inspection/walkthrough. Deal scoping stores `preBidMeetingCompleted`, `siteVisitDecision`, and `siteVisitCompleted` in `deal_scoping_intake.section_data` JSONB; lead scoping stores `dateOfWalk` in `lead_scoping_intake.section_data` JSONB. | Lead scoping workspace writes `dateOfWalk` into `lead_scoping_intake.section_data`, not a lead/deal column. Activity logging can also record `site_visit` activities with timestamps, but that is timeline data, not a field. | Deal scoping workspace reads deal `siteVisit*` fields from `deal_scoping_intake.section_data`; it does not query lead scoping `dateOfWalk`. Deal activity/timeline can show site-visit activities separately. | Written to JSONB side-table that deal-stage scoping does not query. Needs schema/lineage decision before fixing. |

### Deal-Only Fields Worth Product Review

| Deal-only field | Current state |
| --- | --- |
| `forecastRevenue` / forecast metadata | Present on both `leads` and `deals`, but the lead form currently focuses on qualification estimate/budget rather than forecast revenue. The deal hook exposes forecast fields. |
| `expectedCloseDate` | Present on deals only and shown in deal edit/overview. No lead create/edit field found. |
| `proposalNotes` / proposal status | Deal-only estimating/proposal fields, shown around estimating stages. No lead-stage input found. |
| Deal scoping `preBidMeetingCompleted`, `siteVisitDecision`, `siteVisitCompleted` | Deal scoping JSONB fields only. Lead scoping has a separate `dateOfWalk` JSONB field, so these are not one continuous field today. |
