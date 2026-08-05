import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { emails, emailThreadBindings, userGraphTokens } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getEmailThread } from "../../../src/modules/email/service.js";

/**
 * The thread payload must carry `deals.is_change_order`, not just the deal's stored name.
 *
 * The visible defect without it: EmailThreadView's deal PICKER renders the front-loaded display name,
 * and the assigned-thread row underneath it renders from `binding.dealName` alone — so choosing a deal
 * showed one label and assigning it showed another. Worse in the other direction, an ORDINARY deal a
 * human named "Lobby — Change Order 1" got silently rewritten to "Change Order 1 — Lobby", because
 * syntax is all the row had to go on.
 *
 * RUNTIME (PGlite) rather than a mocked `execute`: the binding read is a real drizzle select against
 * `deals`, and this asserts the column exists, is projected, and survives into the payload. A mock would
 * only prove the mapper reads a key the test itself invented.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const USER = U("a01");
const MBX = U("e0a");
const DEAL_PLAIN = U("d001"); // human-typed CO-shaped name, is_change_order = false
const DEAL_CO = U("d002"); // generated change-order child, is_change_order = true
const CONV_PLAIN = "conv-co-flag-plain";
const CONV_CO = "conv-co-flag-child";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);

  // emails / email_thread_bindings / user_graph_tokens from the real Drizzle definitions — the binding
  // resolver LEFT JOINs the tokens table to order connected mailboxes first. `deals` stays hand-rolled,
  // since the binding read selects exactly three of its columns and standing up the company/property/
  // lead graph would buy nothing.
  await pg.exec(tenantSchemaSql("public", [emails, emailThreadBindings, userGraphTokens]));
  await tdb.execute(sql`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      name text,
      is_change_order boolean NOT NULL DEFAULT false
    )
  `);
  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes)
    VALUES (${MBX}, ${USER}, 'x', 'x', now(), '{}')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id, name, is_change_order) VALUES
      (${DEAL_PLAIN}, 'Lobby — Change Order 1', false),
      (${DEAL_CO}, 'Tides Park Lane — Change Order 2', true)
  `);
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
    VALUES
      ('m1', ${CONV_PLAIN}, 'inbound', 'sender@example.com', '{}', ${DEAL_PLAIN}, 'assigned', ${USER}, '2026-07-01T00:00:00Z'),
      ('m2', ${CONV_CO}, 'inbound', 'sender@example.com', '{}', ${DEAL_CO}, 'assigned', ${USER}, '2026-07-02T00:00:00Z')
  `);
  await tdb.execute(sql`
    INSERT INTO email_thread_bindings
      (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
    VALUES (${MBX}, 'microsoft_graph', ${CONV_PLAIN}, ${DEAL_PLAIN}, 'manual', 'high'),
           (${MBX}, 'microsoft_graph', ${CONV_CO}, ${DEAL_CO}, 'manual', 'high')
  `);
// 60000, not the config-wide 30000: the FIRST PGlite instance in a worker compiles the Postgres WASM
// module, and beside the other runtime suites on a 4-worker pool that cold start alone has blown the
// 30s hook budget — later cases in this file then ran fine on the warm worker, which is the signature
// of startup cost rather than a hanging query.
//
// This stays `beforeEach` deliberately. The third case UPDATEs the CONV_PLAIN binding, so a shared
// `beforeAll` would leave cases 1-2 passing only by declaration order. Booting once and re-seeding per
// test would recover most of the cost while keeping the isolation, but that is a refactor, not a
// review fix.
}, 60000);

afterEach(async () => {
  await pg.close();
});

describe("getEmailThread binding carries deals.is_change_order", () => {
  it("reports false for an ordinary deal whose NAME merely looks like a change order", async () => {
    // This is the assertion that matters: the name alone says "change order", the row says otherwise,
    // and only the row is authoritative. A payload without the flag leaves the client to guess, and it
    // guesses wrong on exactly this deal.
    const thread = await getEmailThread(tdb, CONV_PLAIN);
    expect(thread.binding).not.toBeNull();
    expect(thread.binding!.dealName).toBe("Lobby — Change Order 1");
    expect(thread.binding!.dealIsChangeOrder).toBe(false);
  });

  it("reports true for a generated change-order child", async () => {
    const thread = await getEmailThread(tdb, CONV_CO);
    expect(thread.binding!.dealIsChangeOrder).toBe(true);
  });

  it("leaves the flag undefined when the binding has no deal, rather than asserting false", async () => {
    // A PROJECT-targeted binding has no deal row to speak for (email_thread_bindings_single_target_chk
    // allows exactly one of deal_id / project_id, so the target is swapped, not just cleared). `false`
    // would be a claim the server cannot make; `undefined` lets the client fall back to reading the
    // name, which is the documented three-state contract of formatDealDisplayName.
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET deal_id = NULL, project_id = ${U("f001")}
      WHERE provider_conversation_id = ${CONV_PLAIN}
    `);
    const thread = await getEmailThread(tdb, CONV_PLAIN);
    expect(thread.binding!.dealId).toBeNull();
    expect(thread.binding!.dealIsChangeOrder).toBeUndefined();
  });
});
