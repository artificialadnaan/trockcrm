import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { emails, contacts, contactDealAssociations, userGraphTokens, emailThreadBindings } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getEmailAssignmentQueue } from "../../../src/modules/email/service.js";

/**
 * The assignment queue's deal candidates must carry `deals.is_change_order`.
 *
 * getEmailCandidateDeals UNIONs two selects — deals reachable via the email's CONTACT, and deals
 * reachable via that contact's COMPANY — then dedupes with "first occurrence wins", spreading the
 * contact list first. Only the company select projected the flag. So for any deal reachable through
 * the contact (the primary path for this queue) the flag-less row won the dedupe and the flag arrived
 * `undefined`, even when the company query would have supplied the very same deal WITH it.
 *
 * That asymmetry is why this test seeds a deal reachable BOTH ways: it fails if the contact branch is
 * missing the column, and it would also have failed for the reverse dedupe order. A fixture that only
 * exercised the company path would have passed throughout the bug's life.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const USER = U("a01");
const COMPANY = U("c01");
const CONTACT = U("b01");
const STAGE = U("f01");
const DEAL_LOOKALIKE = U("d001"); // reachable via BOTH contact and company; is_change_order = FALSE
const DEAL_CO = U("d002"); // reachable via the contact only; is_change_order = TRUE

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);
  await pg.exec(tenantSchemaSql("public", [emails, contacts, contactDealAssociations, userGraphTokens, emailThreadBindings]));
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (
      id uuid PRIMARY KEY, slug text, name text, display_order integer, is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, is_change_order boolean NOT NULL DEFAULT false,
      company_id uuid, stage_id uuid, is_active boolean NOT NULL DEFAULT true,
      property_address text, property_city text, property_state text, property_zip text
    );
  `);
  // A connected mailbox is a precondition of the queue read ("Connect mailbox first").
  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes, status)
    VALUES (${U("e0a")}, ${USER}, 'x', 'x', now(), '{}', 'active')
  `);
  // One statement per execute: the driver parameterises, and a parameterised multi-statement string is
  // a syntax error.
  await tdb.execute(sql`
    INSERT INTO pipeline_stage_config (id, slug, name, display_order)
    VALUES (${STAGE}, 'estimate_in_progress', 'Estimating', 3)
  `);
  await tdb.execute(sql`
    INSERT INTO contacts (id, first_name, last_name, email, category, company_id, company_name)
    VALUES (${CONTACT}, 'Casey', 'Customer', 'casey@example.com', 'client', ${COMPANY}, 'Alpha Roofing')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id, name, deal_number, is_change_order, company_id, stage_id) VALUES
      (${DEAL_LOOKALIKE}, 'Lobby — Change Order 1', 'D-1', false, ${COMPANY}, ${STAGE}),
      (${DEAL_CO}, 'Tides Park Lane — Change Order 2', 'D-2', true, NULL, ${STAGE})
  `);
  // Both deals are reachable through the CONTACT. DEAL_LOOKALIKE is ALSO on the company, so it is the
  // one the dedupe decides between; DEAL_CO is contact-only, so nothing else can supply its flag.
  await tdb.execute(sql`
    INSERT INTO contact_deal_associations (contact_id, deal_id) VALUES
      (${CONTACT}, ${DEAL_LOOKALIKE}), (${CONTACT}, ${DEAL_CO})
  `);
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, contact_id,
       assignment_status, assignment_ambiguity_reason, user_id, sent_at)
    -- assignment_ambiguity_reason must be NOT NULL: that is what puts a message in the "needs a human"
    -- queue at all (see the unassigned branch of getEmailAssignmentQueue).
    VALUES ('m1', 'conv-assign-1', 'inbound', 'casey@example.com', '{}', ${CONTACT},
            'unassigned', 'multiple_candidate_deals', ${USER}, now())
  `);
}, 30000); // PGlite cold-start can exceed the default 10s under parallel runtime suites

afterEach(async () => {
  await pg.close();
});

describe("email assignment queue deal candidates carry deals.is_change_order", () => {
  it("keeps the flag on a deal reachable through the CONTACT, which the dedupe resolves first", async () => {
    const queue = await getEmailAssignmentQueue(tdb, {}, USER, "admin");
    const item = queue.items?.[0] ?? queue[0];
    expect(item).toBeDefined();
    const candidates: Array<{ id: string; name: string; isChangeOrder?: boolean | null }> =
      item.candidateDeals ?? item.dealCandidates;
    expect(candidates.length).toBeGreaterThanOrEqual(2);

    const lookalike = candidates.find((d) => d.id === DEAL_LOOKALIKE);
    const child = candidates.find((d) => d.id === DEAL_CO);

    // The discriminating row: an ordinary deal a human named change-order-shaped. It is on BOTH lists,
    // and the contact list wins the dedupe — so this is `undefined` unless the contact select projects
    // the column, and the picker then relabels a real deal.
    expect(lookalike?.name).toBe("Lobby — Change Order 1");
    expect(lookalike?.isChangeOrder).toBe(false);
    // Contact-only, so no company row exists to cover for a missing projection.
    expect(child?.isChangeOrder).toBe(true);
  });
});
