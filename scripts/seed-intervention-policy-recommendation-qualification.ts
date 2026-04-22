import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { seedInterventionPolicyRecommendationQualificationData } from "../server/src/modules/ai-copilot/intervention-policy-recommendation-seed-service.js";
import {
  generateInterventionPolicyRecommendationsSnapshot,
  getInterventionPolicyRecommendationsView,
} from "../server/src/modules/ai-copilot/intervention-service.js";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const OFFICE_SLUG = process.env.OFFICE_SLUG?.trim() || "dallas";
const ACTOR_EMAIL = process.env.POLICY_RECOMMENDATION_FIXTURE_ACTOR_EMAIL?.trim() || "admin@trock.dev";
const SEED_KEY = process.env.POLICY_RECOMMENDATION_FIXTURE_SEED_KEY?.trim() || "policy-recommendation-fixture";
const ENVIRONMENT = process.env.NODE_ENV?.trim() || "development";

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const publicDb = drizzle(client, { schema });
    const officeRows = await publicDb
      .select({ id: schema.offices.id, slug: schema.offices.slug })
      .from(schema.offices)
      .where(sql`${schema.offices.slug} = ${OFFICE_SLUG}`)
      .limit(1);
    const office = officeRows[0];
    if (!office) {
      throw new Error(`Office slug ${OFFICE_SLUG} was not found`);
    }

    const actorRows = await publicDb
      .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users)
      .where(sql`${schema.users.officeId} = ${office.id} AND ${schema.users.email} = ${ACTOR_EMAIL}`)
      .limit(1);
    const actor = actorRows[0];
    if (!actor) {
      throw new Error(`Actor ${ACTOR_EMAIL} was not found for office ${OFFICE_SLUG}`);
    }

    const tenantSchema = `office_${office.slug}`;
    await client.query(`SET search_path = '${tenantSchema}', 'public'`);
    const tenantDb = drizzle(client, { schema });
    const now = new Date();
    const snapshotId = crypto.randomUUID();
    const seeded = await client.query("BEGIN").then(async () => {
      const seededResult = await seedInterventionPolicyRecommendationQualificationData(tenantDb as any, {
        officeId: office.id,
        actorUserId: actor.id,
        environment: ENVIRONMENT,
        allowedOfficeIds: [office.id],
        seedKey: SEED_KEY,
      });

      await tenantDb.execute(sql`
        INSERT INTO ai_policy_recommendation_snapshots (
          id, office_id, status, requested_by_user_id, supersedes_snapshot_id, generated_at, stale_at, created_at, updated_at
        )
        VALUES (
          ${snapshotId},
          ${office.id},
          'pending',
          ${actor.id},
          ${null},
          ${now},
          ${now},
          ${now},
          ${now}
        )
      `);

      const generatedResult = await generateInterventionPolicyRecommendationsSnapshot(tenantDb as any, {
        officeId: office.id,
        snapshotId,
        now,
      });
      const viewResult = await getInterventionPolicyRecommendationsView(tenantDb as any, {
        officeId: office.id,
        viewerUserId: actor.id,
        now,
      });
      await client.query("COMMIT");

      return {
        seededResult,
        generatedResult,
        viewResult,
      };
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw error;
    });

    console.log(
      JSON.stringify(
        {
          officeSlug: office.slug,
          officeId: office.id,
          actorEmail: actor.email,
          seedKey: seeded.seededResult.seedKey,
          patternsCreated: seeded.seededResult.patternsCreated,
          generated: {
            snapshotId,
            status: seeded.generatedResult.status,
            recommendationCount: seeded.generatedResult.recommendations.length,
            taxonomies: seeded.generatedResult.recommendations.map((row) => row.taxonomy),
          },
          viewStatus: seeded.viewResult.status,
          renderedRecommendations: seeded.viewResult.recommendations?.map((row) => ({
            id: row.id,
            taxonomy: row.taxonomy,
            title: row.title,
            applyEligible: row.applyEligibility.eligible,
          })),
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("Policy recommendation qualification seed failed:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
