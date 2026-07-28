import { describe, expect, it } from "vitest";
import {
  RFP_ROUND_SCOPED_JOB_TYPES,
  RFP_JOB_TYPES_EXEMPT_FROM_CYCLE_RETIREMENT,
} from "@trock-crm/shared/types";
import { registerAllJobs } from "../../src/jobs/index.js";
import { listRegisteredJobTypes } from "../../src/queue.js";

// ---- "Move back to Opportunity" must cancel EVERY rfp_* job, enforced against the real registry ----
//
// The move-back's cancellation used to be a hand-written `job_type IN (...)` in one SQL statement. It
// covered 3 of the 7 rfp_* job types, and three consecutive review rounds each added exactly one more.
// That is the signature of a list nobody can check: it is correct on the day it is written and drifts
// every time a job is added.
//
// This closes it by construction. The assertion is against the WORKER'S ACTUAL HANDLER REGISTRY — the
// same map the queue dispatches on — not against a source grep. A grep silently passes on input it
// fails to parse, which is fail-open; the registry is the authoritative set, so a newly registered
// rfp_* job fails this test until somebody classifies it as round-scoped or explicitly exempt.
describe("RFP_ROUND_SCOPED_JOB_TYPES covers every registered rfp_* job", () => {
  it("classifies every rfp_* job the worker registers", () => {
    registerAllJobs();
    const registeredRfpJobs = listRegisteredJobTypes()
      .filter((jobType) => jobType.startsWith("rfp_"))
      .sort();

    // Sanity: the registry actually loaded. Without this the filter could be empty and the whole test
    // would pass vacuously — the exact fail-open shape this file exists to avoid.
    expect(registeredRfpJobs.length).toBeGreaterThan(0);

    const classified = [
      ...RFP_ROUND_SCOPED_JOB_TYPES,
      ...RFP_JOB_TYPES_EXEMPT_FROM_CYCLE_RETIREMENT,
    ].sort();

    // Every registered rfp_* job is classified…
    expect(registeredRfpJobs.filter((jobType) => !classified.includes(jobType))).toEqual([]);
    // …and nothing in the constant names a job that no longer exists, so the list cannot rot the other
    // way either (a renamed job type would otherwise leave a dead string cancelling nothing).
    expect(
      RFP_ROUND_SCOPED_JOB_TYPES.filter((jobType) => !registeredRfpJobs.includes(jobType))
    ).toEqual([]);
  });

  it("pins the seven round-scoped job types, so adding one is a deliberate edit", () => {
    expect([...RFP_ROUND_SCOPED_JOB_TYPES].sort()).toEqual([
      "rfp_bidboard_create",
      "rfp_override_approved_email",
      "rfp_reconfirm_denial_email",
      "rfp_rejected_email",
      "rfp_request_delivery",
      "rfp_vote_invitation",
      "rfp_vote_outcome",
    ]);
  });
});
