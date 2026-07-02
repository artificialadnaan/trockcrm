import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { rfpVotes } from "./index.js";

describe("rfp_votes schema", () => {
  it("is registered in the schema barrel", () => {
    expect(rfpVotes).toBeDefined();
  });

  it("declares the rfp_votes table with the contract columns", () => {
    const cfg = getTableConfig(rfpVotes);
    expect(cfg.name).toBe("rfp_votes");
    const cols = cfg.columns.map((c) => c.name).sort();
    expect(cols).toEqual(
      [
        "created_at",
        "deal_id",
        "decision",
        "id",
        "reason",
        "round_event_id",
        "voter_email",
        "voter_user_id",
      ].sort(),
    );
  });

  it("declares the composite unique index (deal_id, round_event_id, voter_user_id)", () => {
    const cfg = getTableConfig(rfpVotes);
    const idxNames = cfg.indexes.map((i) => i.config.name);
    expect(idxNames).toContain("rfp_votes_deal_round_voter_uq");
  });
});
