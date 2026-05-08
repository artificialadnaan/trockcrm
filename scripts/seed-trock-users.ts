import "dotenv/config";

import { readFile } from "node:fs/promises";
import pg from "pg";
import { assertWriteAllowed } from "./lib/db-safety.js";

type SeedUser = {
  id: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  role: "rep" | "director" | "admin";
  officeSlug: string;
  isActive: boolean;
  source: "hubspot_owner" | "manual_create";
  hubspotOwnerIds: string[];
  notes?: string;
};

type UserSeed = {
  defaultOfficeSlug: string;
  users: SeedUser[];
};

const DEFAULT_SEED_PATH = "migration-snapshot/import-ready/user-seed.json";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");
  assertWriteAllowed(databaseUrl, process.argv, dryRun ? "seed-trock-users:dry-run" : "seed-trock-users");
  const seedPath = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) ?? DEFAULT_SEED_PATH;
  const seed = JSON.parse(await readFile(seedPath, "utf8")) as UserSeed;

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");

    for (const user of seed.users) {
      const officeResult = await client.query<{ id: string }>(
        `
          SELECT id
          FROM public.offices
          WHERE slug = $1 AND is_active = true
          LIMIT 1
        `,
        [user.officeSlug || seed.defaultOfficeSlug],
      );

      const officeId = officeResult.rows[0]?.id;
      if (!officeId) {
        throw new Error(`No active office found for slug ${user.officeSlug || seed.defaultOfficeSlug}`);
      }

      await client.query(
        `
          INSERT INTO public.users (
            id,
            email,
            display_name,
            first_name,
            last_name,
            role,
            office_id,
            is_active,
            notification_prefs,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, now(), now())
          ON CONFLICT (email) DO UPDATE
          SET
            display_name = EXCLUDED.display_name,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            role = EXCLUDED.role,
            office_id = EXCLUDED.office_id,
            is_active = EXCLUDED.is_active,
            updated_at = now()
        `,
        [
          user.id,
          user.email.toLowerCase(),
          user.displayName,
          user.firstName,
          user.lastName,
          user.role,
          officeId,
          user.isActive,
        ],
      );

      for (const hubspotOwnerId of user.hubspotOwnerIds) {
        await client.query(
          `
            INSERT INTO public.hubspot_owner_mappings (
              hubspot_owner_id,
              hubspot_owner_email,
              user_id,
              office_id,
              mapping_status,
              failure_reason_code,
              last_seen_at,
              updated_at,
              created_at
            )
            VALUES ($1, $2, $3, $4, 'mapped', NULL, now(), now(), now())
            ON CONFLICT (hubspot_owner_id) DO UPDATE
            SET
              hubspot_owner_email = EXCLUDED.hubspot_owner_email,
              user_id = EXCLUDED.user_id,
              office_id = EXCLUDED.office_id,
              mapping_status = 'mapped',
              failure_reason_code = NULL,
              last_seen_at = now(),
              updated_at = now()
          `,
          [hubspotOwnerId, user.email.toLowerCase(), user.id, officeId],
        );

        await client.query(
          `
            INSERT INTO public.user_external_identities (
              user_id,
              source_system,
              external_user_id,
              external_email,
              external_display_name,
              last_imported_at,
              created_at,
              updated_at
            )
            VALUES ($1, 'hubspot', $2, $3, $4, now(), now(), now())
            ON CONFLICT (source_system, external_user_id) DO UPDATE
            SET
              user_id = EXCLUDED.user_id,
              external_email = EXCLUDED.external_email,
              external_display_name = EXCLUDED.external_display_name,
              last_imported_at = now(),
              updated_at = now()
          `,
          [user.id, hubspotOwnerId, user.email.toLowerCase(), user.displayName],
        );
      }
    }

    if (dryRun) {
      await client.query("ROLLBACK");
      console.log(`[seed-trock-users] dry run passed for ${seed.users.length} users from ${seedPath}`);
    } else {
      await client.query("COMMIT");
      console.log(`[seed-trock-users] provisioned ${seed.users.length} users from ${seedPath}`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
