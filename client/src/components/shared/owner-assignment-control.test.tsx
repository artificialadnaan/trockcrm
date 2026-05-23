// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerAssignmentControl } from "./owner-assignment-control";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

async function renderControl(props: Partial<ComponentProps<typeof OwnerAssignmentControl>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <OwnerAssignmentControl
        ownerUserId="inactive-owner-1"
        currentUser={{ id: "director-1", role: "director" }}
        assignees={[
          { id: "active-owner-1", displayName: "Active Owner" },
          { id: "director-1", displayName: "Dana Director" },
        ]}
        entityLabel="company"
        onAssignToMe={vi.fn()}
        onReassign={vi.fn()}
        onAssigned={vi.fn()}
        {...props}
      />
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("OwnerAssignmentControl", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps an inactive current owner represented in the manager select", async () => {
    const { container, cleanup } = await renderControl();
    try {
      expect(container.textContent).toContain("Inactive or unknown owner");
      expect(container.textContent).not.toContain("Unassigned");
    } finally {
      await cleanup();
    }
  });

  it("keeps active current owners represented normally", async () => {
    const { container, cleanup } = await renderControl({ ownerUserId: "active-owner-1" });
    try {
      expect(container.textContent).toContain("Active Owner");
      expect(container.textContent).not.toContain("Inactive or unknown owner");
    } finally {
      await cleanup();
    }
  });
});
