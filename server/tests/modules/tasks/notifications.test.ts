import { beforeEach, describe, expect, it, vi } from "vitest";

const resendMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(),
}));

vi.stubEnv("FRONTEND_URL", "https://trockcrm.com");

vi.mock("../../../src/lib/resend-client.js", () => resendMocks);

const { sendTaskAssignmentEmail } = await import("../../../src/modules/tasks/notifications.js");

describe("task assignment notifications", () => {
  beforeEach(() => {
    resendMocks.sendSystemEmail.mockReset();
    resendMocks.sendSystemEmail.mockResolvedValue(true);
  });

  it("sends task assignment email with subject, body, deep link, and assigner CC", async () => {
    const tenantDb = {
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

  it("removes CRLF characters from the subject line", async () => {
    const tenantDb = {
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
