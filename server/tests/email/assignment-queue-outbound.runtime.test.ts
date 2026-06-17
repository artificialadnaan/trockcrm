// Real-types (PGlite) test for the unassigned-bucket relaxation that lets Outlook-sent emails become
// assignable. The reconciliation guarantee: after relaxing direction='inbound' across the queue's SQL
// predicate AND its JS candidate filter (one shared ASSIGNABLE_DIRECTIONS constant), a qualifying OUTBOUND
// email must be both COUNTED and LISTED — count must equal items, never one without the other.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  emails,
  contacts,
  deals,
  contactDealAssociations,
  emailThreadBindings,
  pipelineStageConfig,
  userGraphTokens,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";
import { getEmailAssignmentQueue, isEmailAssignmentQueueCandidate } from "../../src/modules/email/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const USER = U("00aa");
const MAILBOX = U("00bb");

let pg: PGlite;
let tdb: any;

function insEmail(opts: {
  graphId: string;
  direction: "inbound" | "outbound";
  ambiguity: string | null;
  status?: string;
  dealId?: string | null;
}) {
  return pg.exec(
    `INSERT INTO public.emails
       (graph_message_id, direction, from_address, to_addresses, user_id, sent_at, synced_at,
        assignment_status, assignment_ambiguity_reason, deal_id)
     VALUES ('${opts.graphId}', '${opts.direction}', 'rep@trockgc.com', ARRAY['client@acme.com'],
             '${USER}', now(), now(), '${opts.status ?? "unassigned"}',
             ${opts.ambiguity ? `'${opts.ambiguity}'` : "NULL"},
             ${opts.dealId ? `'${opts.dealId}'` : "NULL"})`
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [
      userGraphTokens,
      pipelineStageConfig,
      emails,
      contacts,
      deals,
      contactDealAssociations,
      emailThreadBindings,
    ])
  );
  tdb = drizzle(pg);

  // Active mailbox for the sending user (resolveMailboxAccountIdForCrmUser requires it per queue item).
  await pg.exec(
    `INSERT INTO public.user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes, status)
     VALUES ('${MAILBOX}', '${USER}', 'enc', 'enc', now() + interval '1 hour', ARRAY['Mail.Read'], 'active')`
  );

  // Two QUALIFYING unassigned emails — one inbound, one OUTBOUND (the new case). Both have an ambiguity
  // reason and no concrete assignment → both belong in the assignment queue.
  await insEmail({ graphId: "in-1", direction: "inbound", ambiguity: "multiple_deal_candidates" });
  await insEmail({ graphId: "out-1", direction: "outbound", ambiguity: "multiple_deal_candidates" });
  // Non-qualifying: an ASSIGNED outbound email. It carries an ambiguity reason (so it would qualify on
  // direction+ambiguity) but status='assigned' — so it must be excluded by the STATUS branch specifically,
  // not merely by a null ambiguity. This exercises the assigned-status exclusion the queue relies on.
  await insEmail({
    graphId: "out-assigned",
    direction: "outbound",
    ambiguity: "multiple_deal_candidates",
    status: "assigned",
    dealId: U("0d01"),
  });
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("isEmailAssignmentQueueCandidate (JS site)", () => {
  it("treats an unassigned outbound email with an ambiguity reason as a queue candidate", () => {
    expect(
      isEmailAssignmentQueueCandidate({
        direction: "outbound",
        assignmentAmbiguityReason: "multiple_deal_candidates",
        assignmentStatus: "unassigned",
      })
    ).toBe(true);
  });

  it("excludes an assigned (no-ambiguity) outbound email", () => {
    expect(
      isEmailAssignmentQueueCandidate({
        direction: "outbound",
        assignmentAmbiguityReason: null,
        assignmentStatus: "unassigned",
      })
    ).toBe(false);
  });
});

describe("getEmailAssignmentQueue — count reconciles to items, including outbound", () => {
  it("counts AND lists the qualifying outbound email; total === items.length", async () => {
    const result = await getEmailAssignmentQueue(tdb, {});

    // Reconciliation: the SQL count and the JS-filtered items agree (no direction-only divergence).
    expect(result.pagination.total).toBe(result.items.length);
    expect(result.pagination.total).toBe(2); // the inbound + outbound qualifying emails

    const directions = result.items.map((i: any) => i.email.direction).sort();
    expect(directions).toEqual(["inbound", "outbound"]);

    const graphIds = result.items.map((i: any) => i.email.graphMessageId).sort();
    expect(graphIds).toContain("out-1"); // the sent email is now assignable
    expect(graphIds).not.toContain("out-assigned");
  });
});
