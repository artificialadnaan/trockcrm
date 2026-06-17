// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CRM_ASSIGNABLE_ROLES } from "@trock-crm/shared/types";
import { AddUserDialogBody, AddUserDialog } from "./add-user-dialog";

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

describe("AddUserDialog office default", () => {
  it("adopts the first office once options arrive after mount (no stuck-empty officeId)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = { onCreate: async () => {}, onClose: () => {} };

    // Mount with NO offices loaded yet (officeId starts ""), then rerender with options.
    await act(async () => {
      root.render(createElement(AddUserDialog, { ...props, offices: [] }));
    });
    await act(async () => {
      root.render(createElement(AddUserDialog, { ...props, offices: [{ id: "o9", name: "Atlanta" }] }));
    });

    const officeSelect = container.querySelectorAll("select")[1] as HTMLSelectElement; // [0]=role, [1]=office
    expect(officeSelect.value).toBe("o9");
    // Create is no longer stuck-disabled for want of an office (email/name still required separately).
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
