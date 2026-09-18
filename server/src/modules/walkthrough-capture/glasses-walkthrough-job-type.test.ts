// The deal → TROCK Scope work-type-catalog mapping, as a table.
//
// Written as a table rather than as prose assertions because the mapping IS a table: every row is a
// product decision somebody can disagree with, and a disagreement should show up in a diff as one line
// changing rather than as a rewritten test. The table below is the same one the module documents; if the
// two ever disagree, one of them is a lie.
import { describe, expect, it } from "vitest";
import {
  GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE,
  GLASSES_WALKTHROUGH_JOB_TYPES,
  GLASSES_WALKTHROUGH_JOB_TYPE_BY_PROJECT_TYPE_CODE,
  SCOPE_GROUNDABLE_JOB_TYPES,
  isGlassesWalkthroughJobType,
  resolveGlassesWalkthroughJobType,
  scopeForwardableJobType,
  type GlassesWalkthroughJobType,
} from "./glasses-walkthrough-job-type.js";

/** The three signals, with "nobody said" as the baseline every case overrides one field of. */
const NOTHING_STATED = { projectType: null, projectTypeCode: null, workflowRoute: null };

describe("resolveGlassesWalkthroughJobType — the configured project-type code", () => {
  // Every code `project_type_config` actually carries (migration 0069), and what a walk on a deal of
  // that type should be graded against. The `label` column is not asserted on; it is here so a reader
  // of a failure knows which real-world type the digit means without opening the migration.
  const BY_CODE: Array<{ code: string; label: string; expected: GlassesWalkthroughJobType }> = [
    { code: "1", label: "Exterior Renovation", expected: "roofing_envelope" },
    { code: "2", label: "Interior Renovation", expected: "interior_finish_out" },
    { code: "3", label: "Roofing", expected: "roofing_envelope" },
    { code: "4", label: "Service", expected: "service_repair" },
    { code: "5", label: "Commercial", expected: "commercial_ti" },
    { code: "6", label: "Hospitality", expected: "interior_finish_out" },
    { code: "7", label: "Emergency", expected: "service_repair" },
    { code: "8", label: "Development", expected: "interior_finish_out" },
    { code: "9", label: "Residential", expected: "interior_finish_out" },
  ];

  it.each(BY_CODE)("code $code ($label) → $expected", ({ code, expected }) => {
    expect(resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, projectTypeCode: code })).toBe(expected);
  });

  it("covers every code the platform configures, with nothing left over", () => {
    // The mapping and the CRM's own vocabulary must not drift apart in either direction: a code with no
    // row silently becomes `interior_finish_out` (a wrong catalog nobody notices), and a row for a code
    // that does not exist is a decision about nothing.
    expect(Object.keys(GLASSES_WALKTHROUGH_JOB_TYPE_BY_PROJECT_TYPE_CODE).sort()).toEqual(
      BY_CODE.map((row) => row.code).sort()
    );
  });

  it("only ever produces a job type TROCK Scope names", () => {
    for (const jobType of Object.values(GLASSES_WALKTHROUGH_JOB_TYPE_BY_PROJECT_TYPE_CODE)) {
      expect(isGlassesWalkthroughJobType(jobType)).toBe(true);
    }
  });
});

describe("resolveGlassesWalkthroughJobType — precedence between the three signals", () => {
  // The order is `resolveProjectTypeCode`'s, reused rather than reinvented: the text value, then the
  // configured digit, then the workflow route. These cases exist so that reuse is a fact the suite would
  // notice losing, not a comment.
  it("reads the project-type TEXT first when it is a value the platform knows", () => {
    expect(
      resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, projectType: "roofing", projectTypeCode: "2" })
    ).toBe("roofing_envelope");
  });

  it("is decisive in BOTH directions — a roofing deal on the service route is not service work", () => {
    expect(
      resolveGlassesWalkthroughJobType({
        projectType: "roofing",
        projectTypeCode: null,
        workflowRoute: "service",
      })
    ).toBe("roofing_envelope");
  });

  it("falls to the configured digit when the text is absent — the shape roughly half of deals have", () => {
    // 646 of 1,351 active deals carry no `project_type` TEXT at all and are typed ONLY by the FK. A
    // resolver that skipped this tier would answer from `workflow_route` for that whole population.
    expect(resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, projectTypeCode: "1" })).toBe(
      "roofing_envelope"
    );
  });

  it("ignores project-type text that is not a value the platform knows", () => {
    // An imported or hand-edited row can hold anything. Falling through to the digit is right; matching
    // it loosely would let a free-text field pick a catalog.
    expect(
      resolveGlassesWalkthroughJobType({
        ...NOTHING_STATED,
        projectType: "re-roof and paint",
        projectTypeCode: "4",
      })
    ).toBe("service_repair");
  });

  it("falls to the workflow route only when nothing else says anything", () => {
    expect(resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, workflowRoute: "service" })).toBe(
      "service_repair"
    );
  });

  it("does NOT read a route of 'normal' as a statement", () => {
    // `workflow_route` is NOT NULL DEFAULT 'normal' and nothing ever derived it from the project type, so
    // 'normal' has never meant "not service" — it means nobody said, which is the default's job.
    expect(resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, workflowRoute: "normal" })).toBe(
      GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE
    );
  });
});

describe("resolveGlassesWalkthroughJobType — the no-signal answer", () => {
  it("is the default when the deal says nothing", () => {
    expect(resolveGlassesWalkthroughJobType(NOTHING_STATED)).toBe(GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE);
  });

  it("is the same value TROCK Scope applies on its own, so the no-signal path is a no-op", () => {
    // The property that makes this change safe to ship: a deal with no type produces exactly the
    // behaviour of not having sent a job type at all.
    expect(GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE).toBe("interior_finish_out");
  });

  it("survives a code the platform has never configured rather than returning nothing", () => {
    // A legacy `project_type_config` row deactivated by 0069 carries no code at all, and a code added
    // over there before a row is added here would land in exactly this branch. It must be a no-op, not a
    // crash on a walk that is otherwise perfectly filable.
    expect(resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, projectTypeCode: "42" })).toBe(
      GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE
    );
  });

  it("is total — no input produces null", () => {
    for (const projectTypeCode of [null, "", " ", "0", "1", "9", "x"]) {
      expect(resolveGlassesWalkthroughJobType({ ...NOTHING_STATED, projectTypeCode })).toBeTruthy();
    }
  });
});

describe("scopeForwardableJobType — what may actually go on the wire", () => {
  it.each(["interior_finish_out", "roofing_envelope"])("forwards %s, which has a seeded catalog", (jobType) => {
    expect(scopeForwardableJobType(jobType)).toBe(jobType);
  });

  it.each(["commercial_ti", "service_repair"])(
    "WITHHOLDS %s, because TROCK Scope would refuse the walkthrough outright",
    (jobType) => {
      // Not a style preference. That deployment answers 422 `job_type_unavailable` for a job type with no
      // seeded work-type catalog, and the forwarder reads any 4xx as "safe to retry" — so the job loops
      // into the same refusal until the queue dead-letters it and the walk never lands at all. Omitting
      // leaves the walk graded against TROCK Scope's default, which is today's behaviour.
      expect(scopeForwardableJobType(jobType)).toBeNull();
    }
  );

  it("withholds a job type that is not in the vocabulary at all", () => {
    expect(scopeForwardableJobType("exterior")).toBeNull();
  });

  it("withholds null without inventing a default", () => {
    // The forward job omits the field entirely in this case; inventing `interior_finish_out` here would
    // be indistinguishable at the far end from a deal that really is interior finish-out.
    expect(scopeForwardableJobType(null)).toBeNull();
  });

  it("names a groundable set that is a real subset of the vocabulary", () => {
    // Guards the direction that actually hurts: a name in this set that TROCK Scope does not know would
    // be forwarded and refused, which is the exact failure the set exists to prevent.
    for (const jobType of SCOPE_GROUNDABLE_JOB_TYPES) {
      expect(GLASSES_WALKTHROUGH_JOB_TYPES).toContain(jobType);
    }
  });

  it("keeps the default forwardable — otherwise the common case would silently send nothing", () => {
    expect(SCOPE_GROUNDABLE_JOB_TYPES.has(GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE)).toBe(true);
  });
});
