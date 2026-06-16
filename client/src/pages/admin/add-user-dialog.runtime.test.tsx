// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CRM_ASSIGNABLE_ROLES } from "@trock-crm/shared/types";
import { AddUserDialogBody } from "./add-user-dialog";

describe("AddUserDialogBody", () => {
  const offices = [{ id: "o1", name: "Dallas" }];
  it("offers exactly the CRM-assignable roles and never field_contractor", () => {
    const html = renderToStaticMarkup(<AddUserDialogBody offices={offices} />);
    for (const r of CRM_ASSIGNABLE_ROLES) expect(html.toLowerCase()).toContain(r);
    expect(html).not.toContain("field_contractor");
  });
  it("renders the send-invite control", () => {
    const html = renderToStaticMarkup(<AddUserDialogBody offices={offices} />);
    expect(html.toLowerCase()).toContain("invite");
  });
});
