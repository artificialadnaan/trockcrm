import { describe, it, expect } from "vitest";
import {
  GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS,
  WON_DEAL_STAGE_SLUGS,
} from "@trock-crm/shared/types";
import {
  TERMINAL_STAGE_SLUGS,
  WON_STAGE_SLUGS,
} from "../../src/modules/shared/pipeline-terminal-stages.js";
import { runReportBuilder } from "../../src/modules/reports/report-builder-service.js";

/**
 * WON-FAMILY CONSISTENCY GUARD
 *
 * The authoritative Won stage family is the 6-slug `WON_DEAL_STAGE_SLUGS`
 * (canonical `won` + GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS) defined once in
 * shared/src/types/workflow.ts. Hardcoding a SUBSET of it anywhere silently
 * under-counts Won deals and makes a report/board/field-list disagree with the
 * dashboard (the protected 191 / $9,778,045.90 basis).
 *
 * This file locks the SERVER-side consumers that previously drifted (or could):
 *   1. The field "active projects" terminal exclusion must cover the full Won
 *      family (was a hardcoded subset missing service_scheduled / service_complete).
 *   2. The report-builder must offer the canonical won_closed_date axis so a
 *      "Closed Won" report can window on it (not actual_close_date).
 *
 * See .reviews/accuracy-verification-sweep/won-family-drift-audit.md for the full
 * audit + the codebase-wide no-hardcoded-subset lint rule spec (for ESLint, which
 * this repo does not yet have).
 */

describe("Won-family constant integrity", () => {
  it("the authoritative Won family is exactly the canonical 6 slugs", () => {
    expect([...WON_DEAL_STAGE_SLUGS].sort()).toEqual(
      [
        "closed_won",
        "sent_to_production",
        "service_complete",
        "service_scheduled",
        "service_sent_to_production",
        "won",
      ].sort()
    );
  });

  it("the 5 genuine aliases are all present (none silently dropped)", () => {
    for (const alias of GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS) {
      expect(WON_DEAL_STAGE_SLUGS).toContain(alias);
    }
  });

  it("the server WON_STAGE_SLUGS re-export mirrors the shared constant exactly", () => {
    expect([...WON_STAGE_SLUGS].sort()).toEqual([...WON_DEAL_STAGE_SLUGS].sort());
  });
});

describe("field active-projects exclusion covers the full Won family", () => {
  // projects-service.ts derives TERMINAL_FIELD_STAGE_SLUGS from TERMINAL_STAGE_SLUGS
  // (canonical terminal + full Won + full Lost). If anyone reverts it to a hardcoded
  // subset, a terminal-won deal on an omitted alias stage would leak in as "active".
  it("every Won-family slug is a terminal stage excluded from active projects", () => {
    for (const slug of WON_DEAL_STAGE_SLUGS) {
      expect(TERMINAL_STAGE_SLUGS).toContain(slug);
    }
  });
});

describe("report-builder offers the canonical won_closed_date axis", () => {
  // A stub tenantDb: dateField is validated (assertAllowed) BEFORE any query runs,
  // so an empty-rows execute is enough to exercise the validation path.
  const stubDb = { execute: async () => ({ rows: [] }) } as never;
  const baseInput = {
    dimensions: ["month"],
    measures: ["deal_count"],
    filters: {},
    role: "admin" as const,
    userId: "00000000-0000-0000-0000-000000000000",
  };

  it("accepts dateField=won_closed_date (the canonical Won axis)", async () => {
    await expect(
      runReportBuilder(stubDb, { ...baseInput, dateField: "won_closed_date" })
    ).resolves.toBeDefined();
  });

  it("still rejects an unknown dateField", async () => {
    await expect(
      runReportBuilder(stubDb, { ...baseInput, dateField: "not_a_real_date" })
    ).rejects.toThrow(/Invalid dateField/);
  });
});
