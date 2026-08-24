// The reply email is the RELIABLE channel in this design, and the tests reflect that.
//
// The in-app notification is written by the worker and worker-written notifications never push over
// SSE (LISTEN crm_events exists only in worker/src/listener.ts), while the bell only fetches while its
// popover is open — so the in-app row is correct-on-open, not live. The email is what actually reaches
// the assigner, which makes "does it carry the reply text" a product requirement rather than a nicety:
// the ask says "tell Adam they replied AND what they replied", and an email that omits the body makes
// Adam open the CRM to read one sentence.
import { describe, expect, it } from "vitest";
import { buildTaskReplyEmail } from "../../../src/modules/tasks/notifications.js";

const TASK_ID = "61a456fb-05c6-44fb-a888-f970d0733246";

const base = {
  task: { id: TASK_ID, title: "Send the roof photos" },
  assigner: { id: "u-1", email: "adam@example.com", displayName: "Adam Shaw", firstName: "Adam" },
  authorName: "Derek Barr",
  replyBody: "Photos are uploaded — the north slope needs a second visit.",
  repliedAt: "2026-05-01T15:04:05.000Z",
};

describe("buildTaskReplyEmail", () => {
  it("names the replier and the task in the subject", () => {
    const email = buildTaskReplyEmail(base);
    expect(email.subject).toBe("Derek Barr replied to: Send the roof photos");
  });

  // A task title is free text typed by a user, and a CR/LF in a Subject header is header injection.
  it("strips newlines from the subject", () => {
    const email = buildTaskReplyEmail({
      ...base,
      task: { id: TASK_ID, title: "Send photos\r\nBcc: attacker@example.com" },
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toContain("Bcc: attacker@example.com");
  });

  // THE POINT OF THE EMAIL.
  it("carries the reply body verbatim in both the HTML and the text part", () => {
    const email = buildTaskReplyEmail(base);
    expect(email.html).toContain("Photos are uploaded");
    expect(email.html).toContain("the north slope needs a second visit.");
    expect(email.text).toContain(base.replyBody);
  });

  it("escapes HTML in the reply body rather than rendering it", () => {
    const email = buildTaskReplyEmail({
      ...base,
      replyBody: `<img src=x onerror="alert(1)"> & "quoted"`,
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x");
    expect(email.html).toContain("&amp;");
    // ...and the text part keeps the original, since there is nothing to escape there.
    expect(email.text).toContain(`<img src=x onerror="alert(1)">`);
  });

  it("preserves line breaks in a multi-line reply", () => {
    const email = buildTaskReplyEmail({ ...base, replyBody: "line one\nline two" });
    expect(email.html).toMatch(/line one<br\s*\/?>\s*line two/);
  });

  // BOTH deep-link to the task, not to the bare list. `task_assigned` links to "/tasks" today, which
  // is the small existing wrong this PR fixes for both types.
  it("offers two CTAs, both deep-linking to the task itself", () => {
    const email = buildTaskReplyEmail(base);
    expect(email.link).toMatch(new RegExp(`/tasks/${TASK_ID}$`));
    expect(email.html).toContain(email.link);
    expect(email.html).toContain(email.completeLink);
    expect(email.completeLink).toContain(`/tasks/${TASK_ID}`);
    expect(email.completeLink).toMatch(/complete=1/);
    expect(email.text).toContain(email.link);
    expect(email.text).toContain(email.completeLink);
  });

  it("greets the assigner by first name and names who replied", () => {
    const email = buildTaskReplyEmail(base);
    expect(email.html).toContain("Hi Adam,");
    expect(email.text).toContain("Hi Adam,");
    expect(email.text).toContain("Derek Barr replied");
  });

  it("falls back to the display name when no first name is recorded", () => {
    const email = buildTaskReplyEmail({
      ...base,
      assigner: { ...base.assigner, firstName: null },
    });
    expect(email.text).toContain("Hi Adam,");
  });

  it("does not render an empty replier when the display name is missing", () => {
    const email = buildTaskReplyEmail({ ...base, authorName: null });
    expect(email.subject).toBe("The assignee replied to: Send the roof photos");
    expect(email.text).toContain("The assignee replied");
  });
});
