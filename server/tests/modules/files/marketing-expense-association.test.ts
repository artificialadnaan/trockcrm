// `files/service.ts` refuses an upload that names no entity, BEFORE the database is reached. That guard is
// why the expense-request attachments card could not have worked as a join table: the file row it would
// have joined to could never have been created. These cases pin the service half of the fix — the DB half
// (files_association_check) is proven in the 0232 migration suite.
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { AppError } from "../../../src/middleware/error-handler.js";
import { __filesTestExports } from "../../../src/modules/files/service.js";

const { validateAssociations, buildR2Key, linkedFileCondition } = __filesTestExports;
const dialect = new PgDialect();

describe("validateAssociations", () => {
  it("accepts an upload that names ONLY a marketing expense request", () => {
    expect(() =>
      validateAssociations({ marketingExpenseRequestId: "req-1" }),
    ).not.toThrow();
  });

  it("still refuses an upload that names nothing at all", () => {
    expect(() => validateAssociations({})).toThrow(AppError);
  });

  it("names the expense request in the refusal, so the message lists every real option", () => {
    let message = "";
    try {
      validateAssociations({});
    } catch (err) {
      message = (err as AppError).message;
    }
    expect(message).toContain("expense request");
  });

  it("keeps every pre-existing association working", () => {
    for (const input of [
      { dealId: "d" },
      { leadId: "l" },
      { opportunityId: "o" },
      { contactId: "c" },
      { procoreProjectId: 1 },
      { changeOrderId: "co" },
    ]) {
      expect(() => validateAssociations(input)).not.toThrow();
    }
  });

  // EXCLUSIVITY. A file that claims two owners is a question about which authorization applies, and "both"
  // is not an answer the read paths can express: they are an else-if ladder, so the FIRST matching branch
  // decides and the rest never run. A file carrying both a dealId and a marketingExpenseRequestId is
  // therefore authorized as a deal file — every collaborator on that deal can read a private expense
  // attachment, and edit it after the request was decided.
  it("REFUSES an expense-request upload that also claims a deal", () => {
    expect(() => validateAssociations({ marketingExpenseRequestId: "req-1", dealId: "deal-1" })).toThrow(
      AppError,
    );
  });

  it.each([
    ["lead", { leadId: "lead-1" }],
    ["opportunity", { opportunityId: "opp-1" }],
    ["contact", { contactId: "contact-1" }],
    ["Procore project", { procoreProjectId: 42 }],
    ["change order", { changeOrderId: "co-1" }],
  ])("REFUSES an expense-request upload that also claims a %s", (_label, competing) => {
    expect(() => validateAssociations({ marketingExpenseRequestId: "req-1", ...competing })).toThrow(
      AppError,
    );
  });

  it("says WHY, so the caller is not left guessing which field to drop", () => {
    let message = "";
    try {
      validateAssociations({ marketingExpenseRequestId: "req-1", dealId: "deal-1" });
    } catch (err) {
      message = (err as AppError).message;
    }
    expect(message).toContain("expense request");
    expect(message.toLowerCase()).toContain("only");
  });

  it("still accepts an expense-request upload on its own", () => {
    expect(() => validateAssociations({ marketingExpenseRequestId: "req-1" })).not.toThrow();
  });

  it("leaves every OTHER combination alone — this rule is about expense requests only", () => {
    expect(() => validateAssociations({ dealId: "d", contactId: "c" })).not.toThrow();
    expect(() => validateAssociations({ leadId: "l", contactId: "c" })).not.toThrow();
  });

  it("still honours allowUnassigned", () => {
    expect(() => validateAssociations({ allowUnassigned: true })).not.toThrow();
  });
});

describe("buildR2Key", () => {
  it("files an expense-request document under its own prefix, not under unassociated/", () => {
    const key = buildR2Key("dallas", {
      marketingExpenseRequestId: "req-1",
      category: "proposal",
      systemFilename: "quote.pdf",
    });
    expect(key).toBe("office_dallas/marketing-expense-requests/req-1/proposals/quote.pdf");
  });

  it("still prefers a deal number when both are present", () => {
    const key = buildR2Key("dallas", {
      dealNumber: "TR-1",
      marketingExpenseRequestId: "req-1",
      category: "proposal",
      systemFilename: "quote.pdf",
    });
    expect(key).toContain("/deals/TR-1/");
  });
});

describe("linkedFileCondition('unassigned')", () => {
  it("does not call an expense-request attachment unassigned", () => {
    // The 'unassigned' bucket is defined as "every association column is null". Leaving the new column out
    // of it would list every expense-request attachment in the Files page's Unassigned tab, where any user
    // could re-file it onto a deal.
    const rendered = dialect.sqlToQuery(linkedFileCondition("unassigned")).sql;
    expect(rendered).toContain("marketing_expense_request_id");
    // The other five are still there — this bucket means "no association at all", not "no expense request".
    for (const column of ["deal_id", "lead_id", "contact_id", "procore_project_id", "change_order_id"]) {
      expect(rendered).toContain(column);
    }
  });

  it("does not leak the new column into the other buckets", () => {
    for (const linkedType of ["deal", "lead", "contact", "procore", "change_order"] as const) {
      const rendered = dialect.sqlToQuery(linkedFileCondition(linkedType)).sql;
      expect(rendered).not.toContain("marketing_expense_request_id");
    }
  });
});
