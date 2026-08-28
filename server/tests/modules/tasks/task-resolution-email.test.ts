/**
 * The outcome email — what the person who ASSIGNED a task is told when it is closed.
 *
 * Closing a task already required a written explanation (requireTaskResolutionNote, mandatory since
 * the outcome work landed). Nothing was ever done with it: the complete route enqueued a domain event
 * and an AI refresh, the worker wrote an `activities` row, and the assigner found out by going and
 * looking. This is the delivery half.
 *
 * The note goes IN the email for the same reason the reply body does: worker-written in-app rows never
 * push over SSE and the bell only fetches while its popover is open, so mail is the channel that
 * actually arrives. "Your task was closed" with the answer withheld just moves the round trip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resendMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(),
}));

vi.stubEnv("FRONTEND_URL", "https://trockcrm.com");
vi.mock("../../../src/lib/resend-client.js", () => resendMocks);

const { buildTaskResolutionEmail, prepareTaskResolutionEmail } = await import(
  "../../../src/modules/tasks/notifications.js"
);

const TASK_ID = "61a456fb-05c6-44fb-a888-f970d0733246";
const ASSIGNER_ID = "11111111-1111-4111-8111-111111111111";
const CLOSER_ID = "22222222-2222-4222-8222-222222222222";
const OFFICE_ID = "33333333-3333-4333-8333-333333333333";

const assigner = {
  id: ASSIGNER_ID,
  email: "adam@example.com",
  displayName: "Adam Shaw",
  firstName: "Adam",
};

const base = {
  task: { id: TASK_ID, title: "Stage Move" },
  assigner,
  closerName: "Adnaan Iqbal",
  resolution: "completed" as const,
  resolutionNote: "Moved it back to estimating and re-ran the portfolio sync.",
  resolvedAt: "2026-08-27T19:14:05.000Z",
};

describe("buildTaskResolutionEmail", () => {
  it("names the closer, the verb and the task in the subject", () => {
    expect(buildTaskResolutionEmail(base).subject).toBe("Adnaan Iqbal completed: Stage Move");
  });

  it("uses the dismissal verb when the task was dismissed", () => {
    const email = buildTaskResolutionEmail({ ...base, resolution: "dismissed" });
    expect(email.subject).toBe("Adnaan Iqbal dismissed: Stage Move");
    expect(email.text).toContain("dismissed the task you assigned");
  });

  // A task title is free text typed by a user, and a CR/LF in a Subject header is header injection.
  it("strips newlines from the subject", () => {
    const email = buildTaskResolutionEmail({
      ...base,
      task: { id: TASK_ID, title: "Stage Move\r\nBcc: attacker@example.com" },
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toContain("Bcc: attacker@example.com");
  });

  // THE POINT OF THE EMAIL.
  it("carries the outcome verbatim in both the HTML and the text part", () => {
    const email = buildTaskResolutionEmail(base);
    expect(email.html).toContain("Moved it back to estimating");
    expect(email.text).toContain(base.resolutionNote);
  });

  it("escapes HTML in the outcome rather than rendering it", () => {
    const email = buildTaskResolutionEmail({
      ...base,
      resolutionNote: `<img src=x onerror="alert(1)"> & "quoted"`,
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x");
    expect(email.text).toContain(`<img src=x onerror="alert(1)">`);
  });

  it("preserves line breaks in a multi-line outcome", () => {
    const email = buildTaskResolutionEmail({ ...base, resolutionNote: "line one\nline two" });
    expect(email.html).toMatch(/line one<br\s*\/?>\s*line two/);
  });

  it("greets the assigner by first name", () => {
    expect(buildTaskResolutionEmail(base).text.startsWith("Hi Adam,")).toBe(true);
  });

  // display_name is nullable on public.users, and "  completed: X" reads as a bug.
  it("falls back to a readable actor when the closer has no display name", () => {
    const email = buildTaskResolutionEmail({ ...base, closerName: null });
    expect(email.subject).toBe("The assignee completed: Stage Move");
  });

  it("names the linked project when one was resolved", () => {
    const email = buildTaskResolutionEmail({
      ...base,
      project: {
        kind: "resolved",
        project: { name: "Avela Real Estate Partners Property", dealNumber: null, projectNumber: "DFW-2-18126-ae" },
      } as never,
    });
    expect(email.text).toContain("Project: DFW-2-18126-ae - Avela Real Estate Partners Property");
  });

  /**
   * ⚠️ THE LINK MUST CARRY ?officeId. Office context in this app is URL-driven — lib/api.ts reads the
   * param and sends it as x-office-id — so a bare /tasks/<id> is fetched against the READER's own
   * office and 404s for a recipient sitting somewhere else. Same rule as every other task email.
   */
  it("deep-links to the task, carrying the office when it is known", () => {
    const email = buildTaskResolutionEmail({ ...base, officeId: OFFICE_ID });
    expect(email.link).toBe(`https://trockcrm.com/tasks/${TASK_ID}?officeId=${OFFICE_ID}`);
    expect(email.html).toContain(email.link);
  });

  it("leaves the link bare when the office is unknown", () => {
    expect(buildTaskResolutionEmail(base).link).toBe(`https://trockcrm.com/tasks/${TASK_ID}`);
  });
});

/**
 * A tenantDb whose `.select()` calls resolve to the next queued row set.
 *
 * `where()` is both awaitable and chainable: the people lookup awaits it directly (it wants both
 * rows), while resolveLinkedProject appends `.limit(1)`.
 */
function createDb(rowSets: unknown[][]) {
  let call = 0;
  const executed: string[] = [];
  return {
    executed,
    execute: vi.fn(async (statement: unknown) => {
      executed.push(JSON.stringify(statement));
      return { rows: [] };
    }),
    select: vi.fn(() => ({
      from: () => ({
        where: () => {
          const rows = rowSets[call++] ?? [];
          const result: any = Promise.resolve(rows);
          result.limit = async () => rows;
          return result;
        },
      }),
    })),
  };
}

const activeAssignerRow = { ...assigner, isActive: true };
const closerRow = { id: CLOSER_ID, email: "adnaan@example.com", displayName: "Adnaan Iqbal", firstName: "Adnaan", isActive: true };

const prepareInput = {
  task: { id: TASK_ID, title: "Stage Move", dealId: null, createdBy: ASSIGNER_ID, lastAssignedBy: null },
  closedBy: CLOSER_ID,
  resolution: "completed" as const,
  resolutionNote: "Moved it back to estimating.",
  resolvedAt: "2026-08-27T19:14:05.000Z",
  officeId: OFFICE_ID,
};

describe("prepareTaskResolutionEmail", () => {
  beforeEach(() => {
    resendMocks.sendSystemEmail.mockReset();
    resendMocks.sendSystemEmail.mockResolvedValue(true);
  });

  it("addresses the assigner and carries the outcome", async () => {
    const db = createDb([[activeAssignerRow, closerRow]]);
    const email = await prepareTaskResolutionEmail(db as any, prepareInput);

    expect(email?.to).toBe("adam@example.com");
    expect(email?.subject).toBe("Adnaan Iqbal completed: Stage Move");
    expect(email?.options.text).toContain("Moved it back to estimating.");
  });

  // The reads run inside the caller's OPEN transaction: one failed statement in Postgres poisons the
  // whole thing, and the later COMMIT would silently degrade to a ROLLBACK.
  it("savepoints its reads", async () => {
    const db = createDb([[activeAssignerRow, closerRow]]);
    await prepareTaskResolutionEmail(db as any, prepareInput);

    expect(db.executed.some((s) => s.toUpperCase().includes("SAVEPOINT"))).toBe(true);
  });

  /**
   * THE RECIPIENT IS `last_assigned_by ?? created_by`, NOT `created_by`.
   *
   * After a reassignment those are different people, and the one owed the answer is whoever handed the
   * work over. This is resolveTaskAssignerId — the same rule the awaiting-me bucket and 0240's
   * expression index use. Re-deriving it here as `createdBy` would mail the wrong person on every
   * reassigned task, and every fixture where the two happen to match would still pass.
   */
  it("mails the CURRENT assigner on a task that has changed hands, not its creator", async () => {
    const handedOver = {
      ...activeAssignerRow,
      id: "44444444-4444-4444-8444-444444444444",
      email: "handedover@example.com",
    };
    const db = createDb([[handedOver, closerRow]]);

    const email = await prepareTaskResolutionEmail(db as any, {
      ...prepareInput,
      task: { ...prepareInput.task, createdBy: ASSIGNER_ID, lastAssignedBy: handedOver.id },
    });

    expect(email?.to).toBe("handedover@example.com");
  });

  // --- and the four reasons nobody is mailed. Each on its own, because a single "returns null" case
  // passes with three of the four branches broken. ---

  it("sends nothing when the task has no assigner at all", async () => {
    // created_by IS NULL on every rules-engine and AI-disconnect task. There is nobody to write to.
    const db = createDb([[]]);
    const email = await prepareTaskResolutionEmail(db as any, {
      ...prepareInput,
      task: { ...prepareInput.task, createdBy: null, lastAssignedBy: null },
    });

    expect(email).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("sends nothing when the assigner has been deactivated", async () => {
    // This repo deactivates rather than deletes; mailing a departed employee is the failure mode
    // getTaskLoopDescriptor exists to prevent, and the same rule applies here.
    const db = createDb([[{ ...activeAssignerRow, isActive: false }, closerRow]]);
    expect(await prepareTaskResolutionEmail(db as any, prepareInput)).toBeNull();
  });

  it("sends nothing when the assigner closed the task themselves", async () => {
    const db = createDb([[activeAssignerRow, closerRow]]);
    const email = await prepareTaskResolutionEmail(db as any, {
      ...prepareInput,
      closedBy: ASSIGNER_ID,
    });

    expect(email).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("sends nothing when there is no outcome note", async () => {
    // The system-actor close path (email association, AI-disconnect resolution) is exempt from the
    // note requirement, so there is nothing to report.
    const db = createDb([[activeAssignerRow, closerRow]]);
    expect(
      await prepareTaskResolutionEmail(db as any, { ...prepareInput, resolutionNote: "   " })
    ).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("sends nothing when the assigner has no email address on file", async () => {
    const db = createDb([[{ ...activeAssignerRow, email: "" }, closerRow]]);
    expect(await prepareTaskResolutionEmail(db as any, prepareInput)).toBeNull();
  });
});
