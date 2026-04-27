import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const all = await client.query(
      `SELECT slug, name, display_order, workflow_family, is_terminal
         FROM public.pipeline_stage_config
        WHERE name ILIKE '%sales validation%' OR slug ILIKE '%sales_validation%'
        ORDER BY workflow_family, display_order, slug`
    );
    console.log(`matches in pipeline_stage_config: ${all.rows.length}`);
    for (const r of all.rows) {
      console.log(`  family=${r.workflow_family}  slug=${r.slug}  name=${r.name}  order=${r.display_order}  terminal=${r.is_terminal}`);
    }

    console.log("\nall lead-family stages (for context):");
    const leadStages = await client.query(
      `SELECT slug, name, display_order, workflow_family
         FROM public.pipeline_stage_config
        WHERE workflow_family ILIKE '%lead%'
        ORDER BY display_order, slug`
    );
    for (const r of leadStages.rows) {
      console.log(`  ${r.display_order}  family=${r.workflow_family}  slug=${r.slug}  name=${r.name}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
