import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { geocodeAddress } from "../modules/deals/geocode.js";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

async function backfill() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows: schemas } = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'"
    );

    let total = 0;
    let geocoded = 0;
    let failed = 0;

    for (const { schema_name } of schemas) {
      // Validate schema name to prevent SQL injection
      if (!/^office_[a-z0-9_]+$/.test(schema_name)) continue;

      const { rows: dealsToGeocode } = await client.query(`
        SELECT id, property_address, property_city, property_state, property_zip
        FROM ${schema_name}.deals
        WHERE property_address IS NOT NULL
          AND property_city IS NOT NULL
          AND property_state IS NOT NULL
          AND property_lat IS NULL
          AND is_active = TRUE
      `);

      console.log(`[${schema_name}] ${dealsToGeocode.length} deals to geocode`);
      total += dealsToGeocode.length;

      for (const deal of dealsToGeocode) {
        const result = await geocodeAddress(
          deal.property_address,
          deal.property_city,
          deal.property_state,
          deal.property_zip
        );

        if (result) {
          // schema_name already validated above via regex guard
          await client.query(
            `UPDATE ${schema_name}.deals SET property_lat = $1, property_lng = $2 WHERE id = $3`,
            [result.lat, result.lng, deal.id]
          );
          geocoded++;
          console.log(`  OK: ${deal.property_address}, ${deal.property_city} -> ${result.lat}, ${result.lng}`);
        } else {
          failed++;
          console.log(`  NO MATCH: ${deal.property_address}, ${deal.property_city}`);
        }

        // Rate limit: 1 req/sec
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.log(`\nDone. Total: ${total}, Geocoded: ${geocoded}, No match: ${failed}`);
  } finally {
    await client.end();
  }
}

backfill();
