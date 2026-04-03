import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const OFFICE_SLUG = process.env.OFFICE_SLUG || "dallas";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 100);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const schema = `office_${OFFICE_SLUG}`;
    await client.query(`SET search_path = '${schema}', 'public'`);

    // 1. Get distinct company names
    const { rows: companyNames } = await client.query(
      `SELECT DISTINCT company_name FROM contacts WHERE company_name IS NOT NULL AND company_name != '' ORDER BY company_name`
    );
    console.log(`Found ${companyNames.length} unique companies`);

    // 2. Insert companies
    let created = 0;
    const slugCounts = new Map<string, number>();
    for (const { company_name } of companyNames) {
      let slug = slugify(company_name);
      const count = slugCounts.get(slug) || 0;
      if (count > 0) slug = `${slug}-${count}`;
      slugCounts.set(slug, count + 1);

      await client.query(
        `INSERT INTO companies (name, slug, category) VALUES ($1, $2, 'other') ON CONFLICT (slug) DO NOTHING`,
        [company_name, slug]
      );
      created++;
    }
    console.log(`Created ${created} companies`);

    // 3. Create "Independent / Unknown" company
    await client.query(
      `INSERT INTO companies (name, slug, category) VALUES ('Independent / Unknown', 'independent-unknown', 'other') ON CONFLICT (slug) DO NOTHING`
    );

    // 4. Backfill contact.company_id from company_name
    const { rowCount: linked } = await client.query(`
      UPDATE contacts c
      SET company_id = co.id
      FROM companies co
      WHERE c.company_name = co.name AND c.company_id IS NULL
    `);
    console.log(`Linked ${linked} contacts to companies by name`);

    // 5. Assign remaining contacts to "Independent / Unknown"
    const { rowCount: orphans } = await client.query(`
      UPDATE contacts
      SET company_id = (SELECT id FROM companies WHERE slug = 'independent-unknown')
      WHERE company_id IS NULL
    `);
    console.log(`Assigned ${orphans} contacts to Independent / Unknown`);

    // 6. Backfill deal.company_id from primary contact's company
    const { rowCount: dealLinks } = await client.query(`
      UPDATE deals d
      SET company_id = c.company_id
      FROM contacts c
      WHERE d.primary_contact_id = c.id AND d.company_id IS NULL AND c.company_id IS NOT NULL
    `);
    console.log(`Linked ${dealLinks} deals to companies via primary contact`);

    // Verify
    const { rows: [{ c: nullContacts }] } = await client.query(`SELECT COUNT(*) as c FROM contacts WHERE company_id IS NULL`);
    console.log(`\nContacts without company: ${nullContacts}`);
    console.log("Backfill complete.");
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
