// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelinePage } from "./pipeline-page";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/components/deals/deals-list-section", () => ({
  DealsListSection: (props: Record<string, unknown>) => {
    mocks.dealsListSectionMock(props);
    return <div data-testid="pipeline-records" />;
  },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  useDroppable: vi.fn(() => ({ isOver: false, setNodeRef: vi.fn() })),
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
  })),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiMock.mockReset();
  mocks.dealsListSectionMock.mockReset();
  mocks.useAuthMock.mockReset();
  mocks.useAuthMock.mockReturnValue({
    user: { id: "user-1", role: "rep" },
    loading: false,
  });
  mocks.apiMock.mockResolvedValue({
    pipelineColumns: [],
    terminalStages: [],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
});

async function renderPipeline(path: string) {
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <PipelinePage />
      </MemoryRouter>
    );
  });

  await vi.waitFor(() => {
    expect(mocks.dealsListSectionMock).toHaveBeenCalled();
  });

  const calls = mocks.dealsListSectionMock.mock.calls;
  return calls[calls.length - 1]?.[0] as { scope?: string };
}

describe("PipelinePage embedded deals list scope", () => {
  it("forwards scope=all from the page URL into the embedded DealsListSection", async () => {
    const props = await renderPipeline("/pipeline?scope=all");

    expect(mocks.apiMock).toHaveBeenCalledWith(expect.stringContaining("scope=all"));
    expect(props.scope).toBe("all");
  });

  it("forwards scope=mine from the page URL into the embedded DealsListSection", async () => {
    const props = await renderPipeline("/pipeline?scope=mine");

    expect(mocks.apiMock).toHaveBeenCalledWith(expect.stringContaining("scope=mine"));
    expect(props.scope).toBe("mine");
  });
});
