import { beforeEach, describe, expect, it, vi } from "vitest";

const resendMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(),
}));

vi.stubEnv("FRONTEND_URL", "https://trockcrm.com");

vi.mock("../../../src/lib/resend-client.js", () => resendMocks);

const { sendTaskAssignmentEmail } = await import("../../../src/modules/tasks/notifications.js");

/**
 * A tenantDb whose successive `.select()` calls resolve to the next queued row set.
 *
 * `execute` records the savepoint statements: these reads run inside the caller's open task
 * transaction, so each must be savepointed or a failed read aborts the task write.
 */
function createSequencedDb(rowSets: unknown[][]) {
  let call = 0;
  const executed: string[] = [];
  const db = {
    executed,
    execute: vi.fn(async (statement: unknown) => {
      executed.push(JSON.stringify(statement));
      return { rows: [] };
    }),
    select: vi.fn(() => {
      const rows = rowSets[call++] ?? [];
      return {
        from: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      };
    }),
  };
  return db;
}

describe("task assignment notifications", () => {
  beforeEach(() => {
    resendMocks.sendSystemEmail.mockReset();
    resendMocks.sendSystemEmail.mockResolvedValue(true);
  });

  it("sends task assignment email with subject, body, deep link, and assigner CC", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                id: "assignee-1",
                email: "assignee@example.com",
                displayName: "Alex Assignee",
                firstName: "Alex",
              },
            ]),
          })),
        })),
      })),
    };

    const result = await sendTaskAssignmentEmail(tenantDb as any, {
      task: {
        id: "task-1",
        title: "Review bid packet",
        description: "Check the roof scope and exclusions.",
        dueDate: "2026-05-20",
      },
      assigneeId: "assignee-1",
      assigner: {
        id: "assigner-1",
        displayName: "Morgan Manager",
        email: "morgan@example.com",
      },
    });

    expect(result).toBe(true);
    expect(resendMocks.sendSystemEmail).toHaveBeenCalledWith(
      "assignee@example.com",
      "New task assigned: Review bid packet",
      expect.stringContaining("Hi Alex,"),
      expect.objectContaining({
        cc: "morgan@example.com",
        text: expect.stringContaining("https://trockcrm.com/tasks/task-1"),
      })
    );
    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    expect(html).toContain("Morgan Manager assigned you a task: Review bid packet");
    expect(html).toContain("Due: 2026-05-20");
    expect(html).toContain("Description: Check the roof scope and exclusions.");
    expect(html).toContain("https://trockcrm.com/tasks/task-1");
  });

  it("escapes user-controlled task fields before rendering HTML", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                id: "assignee-1",
                email: "assignee@example.com",
                displayName: "<Alex>",
                firstName: null,
              },
            ]),
          })),
        })),
      })),
    };

    await sendTaskAssignmentEmail(tenantDb as any, {
      task: {
        id: "task-1",
        title: "<script>alert(1)</script>",
        description: "Use <b>bold</b>",
        dueDate: null,
      },
      assigneeId: "assignee-1",
      assigner: {
        id: "assigner-1",
        displayName: "<Morgan>",
        email: "morgan@example.com",
      },
    });

    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Use &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;Morgan&gt; assigned you a task");
  });

  it("names the linked project so the assignee knows what the task is for", async () => {
    // The assignee lookup runs first, the linked-deal lookup second.
    const tenantDb = createSequencedDb([
      [{ id: "assignee-1", email: "derek@trockgc.com", displayName: "Derek Barr", firstName: "Derek" }],
      [{ id: "deal-1", name: "Palm Villas", dealNumber: "HS-324283495135", projectNumber: "DFW-1-12826-AH" }],
    ]);

    await sendTaskAssignmentEmail(tenantDb as any, {
      task: {
        id: "task-1",
        title: "Need Property info",
        description: "Do you have the property and unit information?",
        dueDate: "2026-07-31",
        dealId: "deal-1",
      },
      assigneeId: "assignee-1",
      assigner: { id: "assigner-1", displayName: "Colby Burling", email: "colby@trockgc.com" },
    });

    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    const text = (resendMocks.sendSystemEmail.mock.calls[0][3] as { text: string }).text;
    expect(html).toContain("Project: DFW-1-12826-AH - Palm Villas");
    expect(text).toContain("Project: DFW-1-12826-AH - Palm Villas");
    // The meaningless HubSpot id must never reach the recipient.
    expect(html).not.toContain("HS-324283495135");
  });

  it("falls back to the deal name when the project number is still pending", async () => {
    const tenantDb = createSequencedDb([
      [{ id: "assignee-1", email: "derek@trockgc.com", displayName: "Derek Barr", firstName: "Derek" }],
      [{ id: "deal-1", name: "Palm Villas", dealNumber: "HS-324283495135", projectNumber: null }],
    ]);

    await sendTaskAssignmentEmail(tenantDb as any, {
      task: { id: "task-1", title: "Need Property info", description: null, dueDate: null, dealId: "deal-1" },
      assigneeId: "assignee-1",
      assigner: { id: "assigner-1", displayName: "Colby Burling", email: "colby@trockgc.com" },
    });

    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    expect(html).toContain("Project: Palm Villas");
    expect(html).not.toContain("HS-324283495135");
  });

  it("tells the assignee no project is linked rather than staying silent", async () => {
    const tenantDb = createSequencedDb([
      [{ id: "assignee-1", email: "derek@trockgc.com", displayName: "Derek Barr", firstName: "Derek" }],
    ]);

    await sendTaskAssignmentEmail(tenantDb as any, {
      task: { id: "task-1", title: "Need Property info", description: null, dueDate: null, dealId: null },
      assigneeId: "assignee-1",
      assigner: { id: "assigner-1", displayName: "Colby Burling", email: "colby@trockgc.com" },
    });

    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    expect(html).toContain("Project: No project linked");
  });

  it("rolls back to a savepoint instead of aborting the caller's task transaction", async () => {
    // Codex P1: these reads run inside the OPEN task transaction (routes.ts prepares the email
    // before commitTransaction). A failed SELECT aborts that transaction in PostgreSQL — catching
    // it in JS does not recover it, and the later COMMIT then silently degrades to a ROLLBACK, so
    // the task write is lost while the route still reports success and sends the email.
    const executed: string[] = [];
    const tenantDb = {
      execute: vi.fn(async (statement: unknown) => {
        executed.push(JSON.stringify(statement).toUpperCase());
        return { rows: [] };
      }),
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                { id: "assignee-1", email: "derek@trockgc.com", displayName: "Derek Barr", firstName: "Derek" },
              ],
            }),
          }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                throw new Error("deal lookup exploded");
              },
            }),
          }),
        })),
    };

    const result = await sendTaskAssignmentEmail(tenantDb as any, {
      task: { id: "task-1", title: "Need Property info", description: null, dueDate: null, dealId: "deal-1" },
      assigneeId: "assignee-1",
      assigner: { id: "assigner-1", displayName: "Colby Burling", email: "colby@trockgc.com" },
    });

    expect(result).toBe(true);

    // Assert the ORDER, not just the presence of a rollback: rolling back to a savepoint that was
    // never opened is itself an error in PostgreSQL, so "a ROLLBACK was issued" proves nothing on
    // its own. An open must precede the rollback.
    const isOpen = (s: string) =>
      s.includes("SAVEPOINT") && !s.includes("RELEASE") && !s.includes("ROLLBACK TO");
    const firstOpen = executed.findIndex(isOpen);
    const rollbackAt = executed.findIndex((s) => s.includes("ROLLBACK TO SAVEPOINT"));

    expect(firstOpen).toBeGreaterThanOrEqual(0);
    expect(rollbackAt).toBeGreaterThanOrEqual(0);
    expect(firstOpen).toBeLessThan(rollbackAt);
    // Both reads (assignee + deal) are savepointed, and the successful one released.
    expect(executed.filter(isOpen).length).toBe(2);
    expect(executed.some((s) => s.includes("RELEASE SAVEPOINT"))).toBe(true);
  });

  it("still sends when the linked deal lookup fails", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                { id: "assignee-1", email: "derek@trockgc.com", displayName: "Derek Barr", firstName: "Derek" },
              ],
            }),
          }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                throw new Error("deal lookup exploded");
              },
            }),
          }),
        })),
    };

    const result = await sendTaskAssignmentEmail(tenantDb as any, {
      task: { id: "task-1", title: "Need Property info", description: null, dueDate: null, dealId: "deal-1" },
      assigneeId: "assignee-1",
      assigner: { id: "assigner-1", displayName: "Colby Burling", email: "colby@trockgc.com" },
    });

    expect(result).toBe(true);
    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    expect(html).toContain("Need Property info");
    // A failed lookup must NOT be reported as "this task has no project" — that is the same
    // wrong-by-omission the Project line exists to fix.
    expect(html).toContain("Project: Unavailable — open the task to see it");
    expect(html).not.toContain("Project: No project linked");
  });

  it("does not claim 'no project' when the task's deal row is missing", async () => {
    const tenantDb = createSequencedDb([
      [{ id: "assignee-1", email: "derek@trockgc.com", displayName: "Derek Barr", firstName: "Derek" }],
      [], // deal lookup returns no row
    ]);

    await sendTaskAssignmentEmail(tenantDb as any, {
      task: { id: "task-1", title: "Need Property info", description: null, dueDate: null, dealId: "deal-1" },
      assigneeId: "assignee-1",
      assigner: { id: "assigner-1", displayName: "Colby Burling", email: "colby@trockgc.com" },
    });

    const html = resendMocks.sendSystemEmail.mock.calls[0][2] as string;
    expect(html).toContain("Project: Unavailable — open the task to see it");
    expect(html).not.toContain("Project: No project linked");
  });

  it("removes CRLF characters from the subject line", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                id: "assignee-1",
                email: "assignee@example.com",
                displayName: "Alex Assignee",
                firstName: "Alex",
              },
            ]),
          })),
        })),
      })),
    };

    await sendTaskAssignmentEmail(tenantDb as any, {
      task: {
        id: "task-1",
        title: "Review bid\r\nBcc: attacker@example.com",
        description: null,
        dueDate: null,
      },
      assigneeId: "assignee-1",
      assigner: {
        id: "assigner-1",
        displayName: "Morgan Manager",
        email: "morgan@example.com",
      },
    });

    const subject = resendMocks.sendSystemEmail.mock.calls[0][1] as string;
    expect(subject).toBe("New task assigned: Review bid Bcc: attacker@example.com");
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
