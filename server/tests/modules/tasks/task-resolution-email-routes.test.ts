/**
 * The outcome email, exercised THROUGH the routes rather than through its builder.
 *
 * There are three ways a task reaches a terminal status and they do not share a code path:
 * `/complete`, `/dismiss`, and `/transition` with a terminal `nextStatus` — which never enters
 * completeTask at all, because `pending -> completed` is an allowed transition. That third path is
 * also the one BOTH the edit dialog's Dismiss button and the resolution dialog take, so a hook wired
 * only into `/complete` would leave the loop silent for most users while every builder test stayed
 * green. This file is what makes "all three" a fact rather than an intention.
 *
 * It also pins the two orderings that matter: the email is PREPARED before the commit (the read runs
 * inside the caller's open transaction) and SENT after it (so a mail failure cannot take a committed
 * close with it), and a preparation failure that leaves the transaction unusable must PROPAGATE
 * rather than be swallowed into a commit that silently rolls back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  completeTask: vi.fn(),
  dismissTask: vi.fn(),
  transitionTaskStatus: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  prepareTaskResolutionEmail: vi.fn(),
  sendPreparedTaskResolutionEmail: vi.fn(),
}));

vi.mock("../../../src/modules/tasks/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/tasks/service.js")>(
    "../../../src/modules/tasks/service.js"
  );
  return {
    ...actual,
    completeTask: serviceMocks.completeTask,
    dismissTask: serviceMocks.dismissTask,
    transitionTaskStatus: serviceMocks.transitionTaskStatus,
  };
});

vi.mock("../../../src/modules/tasks/notifications.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/tasks/notifications.js")>(
    "../../../src/modules/tasks/notifications.js"
  );
  return {
    ...actual,
    prepareTaskResolutionEmail: notificationMocks.prepareTaskResolutionEmail,
    sendPreparedTaskResolutionEmail: notificationMocks.sendPreparedTaskResolutionEmail,
  };
});

const { taskRoutes } = await import("../../../src/modules/tasks/routes.js");
const { TaskTransactionUnusableError } = await import("../../../src/modules/tasks/notifications.js");

const TASK_ID = "61a456fb-05c6-44fb-a888-f970d0733246";
const OFFICE_ID = "33333333-3333-4333-8333-333333333333";

const user = {
  id: "closer-1",
  role: "rep",
  displayName: "Adnaan Iqbal",
  email: "adnaan@example.com",
  officeId: OFFICE_ID,
  activeOfficeId: OFFICE_ID,
};

function closedTask(status: "completed" | "dismissed" | "in_progress") {
  return {
    id: TASK_ID,
    title: "Stage Move",
    status,
    dealId: "deal-9",
    createdBy: "assigner-1",
    lastAssignedBy: null,
    completedAt: status === "in_progress" ? null : new Date("2026-08-27T19:14:05.000Z"),
    originRule: null,
    contactId: null,
    type: "manual",
    dedupeKey: null,
    reasonCode: null,
    entitySnapshot: null,
  };
}

function findRouteHandler(method: "post", routePath: string) {
  const layer = (taskRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

/**
 * Records commit/prepare/send into ONE array, so their relative ORDER is what gets asserted.
 *
 * An earlier version of this file pushed "commit" into one array and "prepare"/"send" into another,
 * then asserted each separately — which pins nothing: swapping the commit and the send in routes.ts
 * left both arrays byte-identical and all ten tests green, while the mail went out inside an
 * uncommitted transaction. Same array or no assertion.
 */
function createRequestContext(body: Record<string, unknown>, order: string[] = []) {
  const req: Record<string, any> = {
    params: { id: TASK_ID },
    query: {},
    body,
    user,
    headers: {},
    tenantDb: {
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      execute: vi.fn(async () => ({ rows: [] })),
    },
    commitTransaction: vi.fn(async () => {
      order.push("commit");
    }),
  };
  return { req, order };
}

async function invoke(routePath: string, body: Record<string, unknown>, order: string[] = []) {
  const handler = findRouteHandler("post", routePath);
  const { req } = createRequestContext(body, order);
  const res: Record<string, any> = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res._resolve?.();
      return res;
    },
  };

  let capturedError: unknown = null;
  await new Promise<void>((resolve, reject) => {
    res._resolve = resolve;
    Promise.resolve(
      handler(req as any, res as any, (err?: unknown) => {
        capturedError = err ?? null;
        resolve();
      })
    ).catch(reject);
  });

  return { req, res, order, error: capturedError };
}

const PREPARED = {
  to: "adam@example.com",
  subject: "Adnaan Iqbal completed: Stage Move",
  html: "<p>done</p>",
  options: { text: "done" },
};

describe("the outcome email is sent from every close path", () => {
  beforeEach(() => {
    serviceMocks.completeTask.mockReset().mockResolvedValue(closedTask("completed"));
    serviceMocks.dismissTask.mockReset().mockResolvedValue(closedTask("dismissed"));
    serviceMocks.transitionTaskStatus.mockReset().mockResolvedValue(closedTask("completed"));
    notificationMocks.prepareTaskResolutionEmail.mockReset().mockResolvedValue(PREPARED);
    notificationMocks.sendPreparedTaskResolutionEmail.mockReset().mockResolvedValue(true);
  });

  it("sends one on POST /:id/complete", async () => {
    await invoke("/:id/complete", { resolutionNote: "Moved it back to estimating." });

    expect(notificationMocks.sendPreparedTaskResolutionEmail).toHaveBeenCalledTimes(1);
    expect(notificationMocks.prepareTaskResolutionEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resolution: "completed",
        resolutionNote: "Moved it back to estimating.",
        closedBy: user.id,
        officeId: OFFICE_ID,
      })
    );
  });

  it("sends one on POST /:id/dismiss", async () => {
    await invoke("/:id/dismiss", { resolutionNote: "Duplicate of the other one." });

    expect(notificationMocks.sendPreparedTaskResolutionEmail).toHaveBeenCalledTimes(1);
    expect(notificationMocks.prepareTaskResolutionEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolution: "dismissed" })
    );
  });

  // THE PATH A HOOK ON completeTask ALONE WOULD MISS, and the one the edit dialog actually uses.
  it("sends one on POST /:id/transition to a terminal status", async () => {
    await invoke("/:id/transition", { nextStatus: "completed", resolutionNote: "Done on site." });

    expect(notificationMocks.sendPreparedTaskResolutionEmail).toHaveBeenCalledTimes(1);
  });

  it("sends nothing on a NON-terminal transition", async () => {
    serviceMocks.transitionTaskStatus.mockResolvedValue(closedTask("in_progress"));

    await invoke("/:id/transition", { nextStatus: "in_progress" });

    expect(notificationMocks.prepareTaskResolutionEmail).not.toHaveBeenCalled();
    expect(notificationMocks.sendPreparedTaskResolutionEmail).not.toHaveBeenCalled();
  });

  /**
   * The same, but WITH a note in the body — and this is the version that actually tests the status
   * check.
   *
   * The case above passes for the wrong reason: no note means no mail regardless of status, so the
   * terminal-status guard could be deleted entirely and nothing would fail. Sending a note alongside
   * a non-terminal `nextStatus` (which nothing in the UI does, but any client can) isolates the guard
   * and makes deleting it observable.
   */
  it("sends nothing on a non-terminal transition even when the body carries a note", async () => {
    serviceMocks.transitionTaskStatus.mockResolvedValue(closedTask("in_progress"));

    await invoke("/:id/transition", { nextStatus: "in_progress", resolutionNote: "Picked this up." });

    expect(notificationMocks.prepareTaskResolutionEmail).not.toHaveBeenCalled();
    expect(notificationMocks.sendPreparedTaskResolutionEmail).not.toHaveBeenCalled();
  });

  /**
   * There is deliberately NO "sends nothing when the body carried no note" case here.
   *
   * It cannot happen through a route: requireTaskResolutionNote 400s a missing, non-string or
   * whitespace-only note before the service returns, and no HTTP handler can pass the `systemActor`
   * that exempts it. Testing it at this layer means stubbing completeTask into RESOLVING on a body
   * the real one rejects — an impossible state, asserting behaviour nothing can reach. The empty-note
   * contract belongs to prepareTaskResolutionEmail and is tested against the real function in
   * task-resolution-email.test.ts, where a direct caller genuinely can reach it.
   */

  it("sends nothing when there is nobody to write to", async () => {
    notificationMocks.prepareTaskResolutionEmail.mockResolvedValue(null);

    await invoke("/:id/complete", { resolutionNote: "Done." });

    expect(notificationMocks.sendPreparedTaskResolutionEmail).not.toHaveBeenCalled();
  });

  /**
   * PREPARE BEFORE THE COMMIT, SEND AFTER IT.
   *
   * The read runs inside the caller's still-open transaction, so it has to happen before the commit;
   * the send must not, or a mail outage becomes a failed close. Asserted as an ordering rather than
   * as two independent "was called" checks, which pass in either arrangement.
   */
  it.each([
    ["/:id/complete", { resolutionNote: "Done." }],
    ["/:id/dismiss", { resolutionNote: "Duplicate." }],
    ["/:id/transition", { nextStatus: "completed", resolutionNote: "Done." }],
  ])("prepares inside the transaction and sends after the commit — %s", async (routePath, body) => {
    const order: string[] = [];
    notificationMocks.prepareTaskResolutionEmail.mockImplementation(async () => {
      order.push("prepare");
      return PREPARED;
    });
    notificationMocks.sendPreparedTaskResolutionEmail.mockImplementation(async () => {
      order.push("send");
      return true;
    });

    await invoke(routePath, body as Record<string, unknown>, order);

    // ONE sequence, so moving the send in front of the commit — mailing from inside a transaction
    // that has not been written yet — fails here.
    expect(order).toEqual(["prepare", "commit", "send"]);
  });

  it("does not fail the close when the mail send throws", async () => {
    notificationMocks.sendPreparedTaskResolutionEmail.mockRejectedValue(new Error("resend down"));

    const { res, error } = await invoke("/:id/complete", { resolutionNote: "Done." });

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
  });

  /**
   * ...but a POISONED TRANSACTION must still take the request down.
   *
   * In Postgres a failed statement aborts the whole transaction and catching it in JS does not
   * recover it: the later COMMIT degrades to a silent ROLLBACK *without throwing*. Swallowing this
   * would return 200 for a close that was never written. Best-effort has exactly one exception and
   * this is it.
   */
  it("propagates a TaskTransactionUnusableError instead of committing", async () => {
    notificationMocks.prepareTaskResolutionEmail.mockRejectedValue(
      new TaskTransactionUnusableError("savepoint failed")
    );

    const { req, error } = await invoke("/:id/complete", { resolutionNote: "Done." });

    expect(error).toBeInstanceOf(TaskTransactionUnusableError);
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(notificationMocks.sendPreparedTaskResolutionEmail).not.toHaveBeenCalled();
  });
});
