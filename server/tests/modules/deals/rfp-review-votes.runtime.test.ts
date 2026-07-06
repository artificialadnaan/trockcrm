import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/lib/rfpVoteState", async () => import("../../../../shared/src/lib/rfpVoteState.js"));

import { getRfpReviewDetail } from "../../../src/modules/deals/rfp-override-service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const DEAL = U("d01");
const ROUND = U("e01");
const REQ = U("a09");
const SIDNEY = U("a01");
const JAMES = U("a02");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // getRfpReviewDetail runs raw SQL over `deals` + `public.users`; loadRfpVoteDetail reads `rfp_votes` + `users`.
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text,
      rfp_approval_status text, rfp_approval_request_id bigint,
      rfp_approval_request_event_id uuid,
      rfp_approval_requested_at timestamptz, rfp_approval_requested_by uuid,
      rfp_declined_reason text, rfp_declined_at timestamptz,
      rfp_override_reviewed_at timestamptz, rfp_override_reviewed_by uuid,
      rfp_override_decision text, rfp_override_note text,
      rfp_override_state text, rfp_override_error text
    );
    CREATE TABLE rfp_votes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL, round_event_id uuid NOT NULL,
      voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.users (id, display_name, email) VALUES
      ('${REQ}', 'Rep Requester', 'rep@trockgc.com'),
      ('${SIDNEY}', 'Sidney Gibson', 'sidney@trockgc.com'),
      ('${JAMES}', 'James Helms', 'james@trockgc.com');
    INSERT INTO deals (id, name, deal_number, project_number, rfp_approval_status, rfp_approval_request_id,
      rfp_approval_request_event_id, rfp_approval_requested_at, rfp_approval_requested_by,
      rfp_declined_reason, rfp_declined_at)
    VALUES ('${DEAL}', 'Terraces Re-Roof', 'DFW-1-100', 'DFW-1-100', 'declined', NULL,
      '${ROUND}', '2026-07-02T14:00:00Z', '${REQ}',
      'Rejected by vote (2 of 3). sidney@trockgc.com: cost; james@trockgc.com: scope', '2026-07-02T14:25:00Z');
    INSERT INTO rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision, reason, created_at) VALUES
      ('${DEAL}', '${ROUND}', '${SIDNEY}', 'sidney@trockgc.com', 'reject', 'cost', '2026-07-02T14:14:00Z'),
      ('${DEAL}', '${ROUND}', '${JAMES}', 'james@trockgc.com', 'reject', 'scope', '2026-07-02T14:20:00Z');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

describe("getRfpReviewDetail (vote-enriched)", () => {
  it("returns the round's votes alongside the declined-RFP facts", async () => {
    const detail = await getRfpReviewDetail(tdb, DEAL);
    expect(detail).not.toBeNull();
    expect(detail!.rfpApprovalStatus).toBe("declined");
    expect(detail!.votes.map((v) => v.voterEmail)).toEqual(["sidney@trockgc.com", "james@trockgc.com"]);
    expect(detail!.votes.every((v) => v.decision === "reject")).toBe(true);
    expect(detail!.votes[1]).toMatchObject({ voterName: "James Helms", reason: "scope" });
  });
});
