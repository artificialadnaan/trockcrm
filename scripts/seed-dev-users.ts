import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

async function seed() {
  await client.connect();

  try {
    // Create DFW office
    const officeResult = await client.query(`
      INSERT INTO offices (name, slug, address, phone)
      VALUES ('DFW Office', 'dfw', '1234 Commerce St, Dallas, TX 75201', '(214) 555-0100')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const officeId = officeResult.rows[0].id;
    console.log(`Office created/updated: ${officeId}`);

    // Dev users — one per role
    const devUsers = [
      {
        email: "admin@trock.dev",
        displayName: "Admin User",
        role: "admin",
      },
      {
        email: "director@trock.dev",
        displayName: "Director User",
        role: "director",
      },
      {
        email: "rep@trock.dev",
        displayName: "Sales Rep",
        role: "rep",
      },
    ];

    for (const user of devUsers) {
      const result = await client.query(
        `INSERT INTO users (email, display_name, role, office_id)
         VALUES ($1, $2, $3::user_role, $4)
         ON CONFLICT (email) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role::user_role,
           office_id = EXCLUDED.office_id,
           is_active = TRUE
         RETURNING id, email, role`,
        [user.email, user.displayName, user.role, officeId]
      );
      console.log(`User seeded: ${result.rows[0].email} (${result.rows[0].role})`);
    }

    console.log("\nDev users seeded successfully.");
    console.log("Set DEV_MODE=true on the API service to enable the dev user picker.");
  } catch (err) {
    console.error("Seed failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed();
