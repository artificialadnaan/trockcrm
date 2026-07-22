import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  mintCorrectiveActionToken,
  verifyCorrectiveActionToken,
} from "../../../src/modules/field/corrective-action-tokens.js";
import { scorecardCorrectiveActionTokens } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const SCORECARD = "11111111-1111-1111-1111-111111111111";

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [scorecardCorrectiveActionTokens]));
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
});

describe("corrective-action web tokens", () => {
  it("mints a raw token, stores only its sha256 hash, and verifies the roundtrip", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    expect(typeof rawToken).toBe("string");
    expect(rawToken.length).toBeGreaterThan(20);

    // The raw token is NOT stored — only its hash.
    const stored = await tdb.execute(
      sql`SELECT token_hash, recipient_email, role FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${SCORECARD}`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).not.toBe(rawToken);
    expect(String(stored.rows[0].token_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].recipient_email).toBe("pm@example.com");

    const verified = await verifyCorrectiveActionToken(tdb, rawToken);
    expect(verified).toEqual({
      scorecardId: SCORECARD,
      recipientEmail: "pm@example.com",
      role: "project_manager",
    });
  });

  it("returns null for an unknown / tampered token", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    expect(await verifyCorrectiveActionToken(tdb, `${rawToken}tampered`)).toBeNull();
    expect(await verifyCorrectiveActionToken(tdb, "totally-made-up")).toBeNull();
  });

  it("returns null for an expired token", async () => {
    await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    // Force the stored row past expiry.
    const raw = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: "super@example.com",
      role: "superintendent",
      ttlDays: 30,
    });
    await tdb.execute(
      sql`UPDATE scorecard_corrective_action_tokens SET expires_at = now() - interval '1 day' WHERE recipient_email = 'super@example.com'`,
    );
    expect(await verifyCorrectiveActionToken(tdb, raw.rawToken)).toBeNull();
  });
});
