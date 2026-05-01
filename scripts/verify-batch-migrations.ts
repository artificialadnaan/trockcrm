import pg from "pg";

const TENANTS = ["office_atlanta", "office_dallas", "office_pwauditoffice"];
const MIGRATIONS = [
  "0060_company_verification_rejected.sql",
  "0061_deal_contract_signed_date.sql",
  "0062_deal_signed_commissions.sql",
  "0063_contract_signed_at_and_rfp_opportunity_event.sql",
  "0064_bidboard_stage_v2_seed.sql",
  "0065_bidboard_stage_v2_active_deal_backfill.sql",
];

const STAGE_V2_ACTIVE_SLUGS = [
  "opportunity",
  "estimating",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
];

const STAGE_V2_INACTIVE_ALIAS_SLUGS = [
  "estimate_in_progress",
  "service_estimate_under_review",
  "service_estimate_sent_to_client",
  "sent_to_production",
  "service_sent_to_production",
  "production_lost",
  "service_lost",
  "closed_won",
  "closed_lost",
];

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error("DATABASE_PUBLIC_URL not set");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    let hasFailure = false;

    console.log("=== Migration tracking rows ===");
    const { rows: tracking } = await client.query(
      `SELECT name, executed_at FROM public._migrations
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [MIGRATIONS]
    );
    console.table(tracking);

    const missing = MIGRATIONS.filter(
      (m) => !tracking.find((row: any) => row.name === m)
    );
    if (missing.length > 0) {
      console.error(`MISSING tracking rows: ${missing.join(", ")}`);
      process.exit(1);
    }

    console.log("\n=== Public stage seed checks ===");
    const { rows: activeStageRows } = await client.query(
      `SELECT slug
       FROM public.pipeline_stage_config
       WHERE slug = ANY($1::text[])
         AND is_active_pipeline = true
         AND (
           (slug IN ('won', 'lost') AND is_terminal = true)
           OR (slug NOT IN ('won', 'lost') AND is_terminal = false)
         )
       ORDER BY slug`,
      [STAGE_V2_ACTIVE_SLUGS]
    );
    const activeStageCount = activeStageRows.length;
    const activeStagePass = activeStageCount === STAGE_V2_ACTIVE_SLUGS.length;
    hasFailure ||= !activeStagePass;
    console.log(
      `  0064: stage-v2 active rows: ${activeStageCount}/${STAGE_V2_ACTIVE_SLUGS.length} present + active` +
        (activeStagePass ? " ✓" : " ✗")
    );

    const { rows: inactiveAliasRows } = await client.query(
      `SELECT slug
       FROM public.pipeline_stage_config
       WHERE slug = ANY($1::text[])
         AND is_active_pipeline = false
         AND (
           (slug IN (
             'sent_to_production',
             'service_sent_to_production',
             'production_lost',
             'service_lost',
             'closed_won',
             'closed_lost'
           ) AND is_terminal = true)
           OR (slug IN (
             'estimate_in_progress',
             'service_estimate_under_review',
             'service_estimate_sent_to_client'
           ) AND is_terminal = false)
         )
       ORDER BY slug`,
      [STAGE_V2_INACTIVE_ALIAS_SLUGS]
    );
    const inactiveAliasCount = inactiveAliasRows.length;
    const inactiveAliasPass = inactiveAliasCount === STAGE_V2_INACTIVE_ALIAS_SLUGS.length;
    hasFailure ||= !inactiveAliasPass;
    console.log(
      `  0064: old stage aliases inactive: ${inactiveAliasCount}/${STAGE_V2_INACTIVE_ALIAS_SLUGS.length} present + inactive` +
        (inactiveAliasPass ? " ✓" : " ✗")
    );

    console.log("\n=== Per-tenant column/table existence checks ===");
    for (const schema of TENANTS) {
      console.log(`\n[${schema}]`);

      // 0060: companies.company_verification_status enum should accept 'rejected' value
      // (we check via the per-tenant rejection columns, since 0060 added those too)
      const { rows: rejColumns } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'companies'
           AND column_name IN ('company_verification_rejected_at', 'company_verification_rejected_by')
         ORDER BY column_name`,
        [schema]
      );
      console.log(
        `  0060: companies.company_verification_rejected_{at,by} columns: ${rejColumns.length}/2 present` +
          (rejColumns.length === 2 ? " ✓" : " ✗")
      );
      hasFailure ||= rejColumns.length !== 2;

      // 0061: deals.contract_signed_date column should exist
      const { rows: csdColumn } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'deals'
           AND column_name = 'contract_signed_date'`,
        [schema]
      );
      console.log(
        `  0061: deals.contract_signed_date column: ${csdColumn.length === 1 ? "present ✓" : "MISSING ✗"}`
      );
      hasFailure ||= csdColumn.length !== 1;

      // 0062: deal_signed_commissions table should exist
      const { rows: dscTable } = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'deal_signed_commissions'`,
        [schema]
      );
      console.log(
        `  0062: deal_signed_commissions table: ${dscTable.length === 1 ? "present ✓" : "MISSING ✗"}`
      );
      hasFailure ||= dscTable.length !== 1;

      // 0063: contract/RFP event columns and indexes should exist
      const { rows: eventColumns } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'deals'
           AND column_name IN (
             'contract_signed_at',
             'rfp_approval_requested_at',
             'rfp_approval_request_event_id',
             'rfp_approval_requested_by'
           )
         ORDER BY column_name`,
        [schema]
      );
      console.log(
        `  0063: deals contract/RFP event columns: ${eventColumns.length}/4 present` +
          (eventColumns.length === 4 ? " ✓" : " ✗")
      );
      hasFailure ||= eventColumns.length !== 4;

      const { rows: eventIndexes } = await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = $1
           AND tablename = 'deals'
           AND indexname IN (
             'deals_contract_signed_at_idx',
             'deals_rfp_approval_requested_at_idx'
           )
         ORDER BY indexname`,
        [schema]
      );
      console.log(
        `  0063: deals contract/RFP event indexes: ${eventIndexes.length}/2 present` +
          (eventIndexes.length === 2 ? " ✓" : " ✗")
      );
      hasFailure ||= eventIndexes.length !== 2;

      const { rows: activeLegacyStageDeals } = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${schema}.deals AS d
         JOIN public.pipeline_stage_config AS psc
           ON psc.id = d.stage_id
         WHERE COALESCE(d.is_active, true) = true
           AND psc.slug = ANY($1::text[])`,
        [STAGE_V2_INACTIVE_ALIAS_SLUGS]
      );
      const activeLegacyStageDealCount = activeLegacyStageDeals[0]?.count ?? 0;
      const activeLegacyStageDealPass = activeLegacyStageDealCount === 0;
      hasFailure ||= !activeLegacyStageDealPass;
      console.log(
        `  0065: active deals remaining on old stage slugs: ${activeLegacyStageDealCount}` +
          (activeLegacyStageDealPass ? " ✓" : " ✗")
      );

      const { rows: activeLegacyMirrorDeals } = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${schema}.deals AS d
         WHERE COALESCE(d.is_active, true) = true
           AND d.bid_board_stage_slug = ANY($1::text[])`,
        [STAGE_V2_INACTIVE_ALIAS_SLUGS]
      );
      const activeLegacyMirrorDealCount = activeLegacyMirrorDeals[0]?.count ?? 0;
      const activeLegacyMirrorDealPass = activeLegacyMirrorDealCount === 0;
      hasFailure ||= !activeLegacyMirrorDealPass;
      console.log(
        `  0065: active deals with old bid_board_stage_slug aliases: ${activeLegacyMirrorDealCount}` +
          (activeLegacyMirrorDealPass ? " ✓" : " ✗")
      );
    }

    if (hasFailure) {
      console.error("\nOne or more migration verification checks failed.");
      process.exit(1);
    }
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
