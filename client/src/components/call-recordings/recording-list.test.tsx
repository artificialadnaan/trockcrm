// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingList } from "./recording-list";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  user: { id: "rep-1", role: "rep" } as { id: string; role: string } | null,
}));

vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

async function renderList() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<RecordingList entityType="deal" entityId="deal-1" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root: root! };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe("RecordingList role gates", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.apiMock.mockResolvedValue({ recordings: [] });
    mocks.user = { id: "rep-1", role: "rep" };
  });

  it("shows upload access to reps but keeps delete admin-only", async () => {
    const { container, root } = await renderList();

    expect(container.textContent).toContain("Upload Recording");
    expect(container.querySelector('[aria-label="Delete recording"]')).toBeNull();
    expect(mocks.apiMock).toHaveBeenCalledWith("/call-recordings?entityType=deal&entityId=deal-1");

    await unmount(root);
  });

  it("hides the recording surface until a CRM user is loaded", async () => {
    mocks.user = null;
    const { container, root } = await renderList();

    expect(container.textContent).not.toContain("Call Recordings");
    expect(mocks.apiMock).not.toHaveBeenCalled();

    await unmount(root);
  });
});
