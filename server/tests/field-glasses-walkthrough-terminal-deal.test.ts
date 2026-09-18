/**
 * Pins WHICH ACCESS GATE the two glasses-walkthrough routes assert with.
 *
 * A walk is evidence of a site visit that already happened. Its bytes drain long after the visit — a
 * multi-gigabyte recording over a jobsite connection, or a phone that stayed offline, routinely spans
 * hours or days, and the mobile queue keeps retrying the completion for as long as it takes. In that
 * window the deal can move. Both routes used to gate on `getFieldProject`, whose query carries
 * `activeProjectWhere()` — the FIELD BROWSING rule (active pipeline, or Won-family; never Lost/terminal)
 * — so a deal that went Lost after the walk was recorded turned every remaining upload attempt into a
 * 404 and the recording was stranded on the phone until its files were cleaned up. The recording is not
 * retakeable and the stage change says nothing about whether the visit happened.
 *
 * The gate is now `assertAccessibleFieldCaptureTarget`, which is the rule the ordinary field PHOTO upload
 * has always used for the same act (photos-service.ts): existence + `is_active`, unscoped by rep,
 * NOT stage-filtered. So this is not a new, weaker rule invented for glasses — it is the rule this
 * codebase already applies to "a field user is attaching captured evidence to a deal".
 *
 * What is NOT relaxed, and what these cases exist to keep: a terminal deal is still not BROWSABLE (no
 * list, no detail, no photo feed reaches it — none of those go through this gate), the office is still
 * resolved from the deal rather than from the client, and a deal the capture-target gate refuses still
 * gets a 404 with the service never invoked. The sibling runtime suite
 * (field-glasses-walkthrough-deal-access.runtime.test.ts) proves the two gates' predicates differ in
 * exactly one dimension against real SQL; this file proves the ROUTES pick the right one, which is
 * where the defect actually lived.
 */
import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OFFICE = { id: "office-1", slug: "dallas" };
const DEAL = "00000000-0000-4000-8000-000000000001";

const getFieldProjectMock = vi.hoisted(() => vi.fn());
const assertCaptureTargetMock = vi.hoisted(() => vi.fn());
const ingestMock = vi.hoisted(() => vi.fn());
const presignMock = vi.hoisted(() => vi.fn());
/** The completion route's third service call: it resolves the walk's TROCK Scope job type from the deal,
 *  and it READS the db this file deliberately does not stand up. Stubbed for the same reason the other
 *  two are — these cases are about which gate the route asserts with, not about what SQL ran. */
const resolveJobTypeMock = vi.hoisted(() => vi.fn());

vi.mock("../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: () => void) => {
    req.fieldUser = { id: "field-user-1", role: "field_contractor", tenantId: OFFICE.id };
    next();
  },
  requireCrmUser: (_req: any, _res: any, next: () => void) => next(),
}));

// The office resolution and the transaction envelope are canned; everything else in cross-office.js stays
// REAL. `runInOfficeTransaction` hands the handler a db it never touches here — the service calls that
// would use it are stubbed below — so the cases read as "which gate did the route call", not "what SQL ran".
vi.mock("../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/field/cross-office.js")>();
  return {
    ...actual,
    resolveFieldWriteOffice: async () => OFFICE,
    runInOfficeTransaction: async (office: any, _userId: string, run: any) => run({}, office),
  };
});

// Both gates stay importable and both are observable. Stubbing only ONE of them would make "the route
// called the other" indistinguishable from "the route called nothing".
vi.mock("../src/modules/field/projects-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/field/projects-service.js")>();
  return {
    ...actual,
    getFieldProject: getFieldProjectMock,
    assertAccessibleFieldCaptureTarget: assertCaptureTargetMock,
  };
});

// The validators stay REAL, so these cases have to send bodies the endpoints genuinely accept — a stubbed
// validator would let a route that had stopped validating pass here.
vi.mock("../src/modules/walkthrough-capture/glasses-walkthrough-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/modules/walkthrough-capture/glasses-walkthrough-service.js")
  >();
  return {
    ...actual,
    ingestGlassesWalkthrough: ingestMock,
    requestGlassesWalkthroughArtifactUploadUrl: presignMock,
    resolveGlassesWalkthroughJobTypeForDeal: resolveJobTypeMock,
  };
});

vi.mock("../src/modules/walkthrough-capture/glasses-walkthrough-store.js", () => ({
  createGlassesWalkthroughArtifactStore: () => ({
    isConfigured: () => false,
    head: async () => ({}),
    presignUpload: async () => ({ uploadUrl: "mock://put", expiresIn: 300 }),
  }),
}));

const { fieldRoutes } = await import("../src/modules/field/routes.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");
const { AppError } = await import("../src/middleware/error-handler.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/field", fieldRoutes);
  a.use(errorHandler); // the REAL handler, so AppError.statusCode reaches the response
  return a;
}

const completionBody = {
  walkId: "walk-1",
  title: "North wing walkthrough",
  capturedAt: "2026-07-30T15:04:00.000Z",
  artifacts: [
    {
      idempotencyKey: "walk-1:video",
      kind: "video",
      originalFilename: "clip.mp4",
      mimeType: "video/mp4",
      fileSizeBytes: 4096,
      capturedAtMs: 1_700_000_000_000,
    },
  ],
};

const uploadUrlBody = {
  walkId: "walk-1",
  idempotencyKey: "walk-1:video",
  kind: "video",
  mimeType: "video/mp4",
  fileSizeBytes: 4096,
};

beforeEach(() => {
  getFieldProjectMock.mockReset();
  assertCaptureTargetMock.mockReset();
  ingestMock.mockReset();
  presignMock.mockReset();
  resolveJobTypeMock.mockReset();
  resolveJobTypeMock.mockResolvedValue("interior_finish_out");
  // What the deal looks like AFTER it moved to a terminal stage: still a real, active record the office
  // resolver finds, but no longer inside the field's browsable set — so the browsing gate 404s it.
  getFieldProjectMock.mockRejectedValue(new AppError(404, "Project not found"));
  assertCaptureTargetMock.mockResolvedValue({ id: DEAL, type: "deal" });
  ingestMock.mockResolvedValue({ walkId: "walk-1", files: [], forwarding: { status: "queued", jobId: 1 } });
  presignMock.mockResolvedValue({ uploadUrl: "mock://put", r2Key: "k", expiresIn: 300 });
});

describe("glasses-walkthrough routes against a deal that has since gone terminal", () => {
  it("REGRESSION: files a completed walk against a deal that is no longer browsable", async () => {
    const res = await request(app()).post(`/api/field/projects/${DEAL}/glasses-walkthroughs`).send(completionBody);

    expect(res.status).toBe(201);
    expect(ingestMock).toHaveBeenCalledTimes(1);
    // The browsing gate must not be consulted at all — reached, it 404s a walk that already happened.
    expect(getFieldProjectMock).not.toHaveBeenCalled();
    expect(assertCaptureTargetMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dealId: DEAL }));
  });

  it("REGRESSION: presigns an artifact upload for a deal that is no longer browsable", async () => {
    // The presign is the half that runs FIRST and repeats per artifact, so a walk blocked here never even
    // reaches the completion above: the phone burns its five PUT attempts per artifact and reports the
    // site visit as failed.
    const res = await request(app())
      .post(`/api/field/projects/${DEAL}/glasses-walkthroughs/artifacts/upload-url`)
      .send(uploadUrlBody);

    expect(res.status).toBe(200);
    expect(presignMock).toHaveBeenCalledTimes(1);
    expect(getFieldProjectMock).not.toHaveBeenCalled();
    // The POSITIVE half, which only the completion case above was pinning. "The browsing gate was not
    // called" passes just as well if the route asserts NO gate at all — and this is the route that mints
    // a writable R2 capability, so the gate actually running, against the dealId from the PATH rather
    // than anything the body could carry, is the property most worth holding here.
    expect(assertCaptureTargetMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dealId: DEAL }),
    );
  });

  it.each([
    ["completion", `/api/field/projects/${DEAL}/glasses-walkthroughs`, completionBody, ingestMock],
    [
      "upload-url",
      `/api/field/projects/${DEAL}/glasses-walkthroughs/artifacts/upload-url`,
      uploadUrlBody,
      presignMock,
    ],
  ])(
    "GUARD: the %s route still 404s when the capture-target gate refuses, and never reaches the service",
    async (_label, path, body, serviceMock) => {
      // The relaxation is ONE dimension wide. A deleted/archived (is_active = false) deal, or an id in an
      // office this user cannot reach, still fails — and it fails BEFORE anything is presigned or written,
      // which is the property that stops a field user filing evidence against a deal they cannot reach.
      assertCaptureTargetMock.mockRejectedValue(new AppError(404, "Capture target not found"));

      const res = await request(app()).post(path).send(body);

      expect(res.status).toBe(404);
      expect(serviceMock).not.toHaveBeenCalled();
      // NOR THE JOB-TYPE RESOLVER, which READS the deal. "Never reaches the service" has to mean every
      // service call on the route, not the one the case is named after: a lookup that ran before the gate
      // would read a deal this user was just refused.
      expect(resolveJobTypeMock).not.toHaveBeenCalled();
    },
  );

  it("GUARD: still rejects a malformed dealId with a 400 before any office resolution", async () => {
    const res = await request(app()).post("/api/field/projects/not-a-uuid/glasses-walkthroughs").send(completionBody);

    expect(res.status).toBe(400);
    expect(assertCaptureTargetMock).not.toHaveBeenCalled();
    expect(ingestMock).not.toHaveBeenCalled();
  });
});
