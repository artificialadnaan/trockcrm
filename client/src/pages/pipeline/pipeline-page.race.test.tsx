// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelinePage } from "./pipeline-page";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
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
  useDraggable: vi.fn(() => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null })),
}));

type Deferred = { path: string; settled: boolean; resolve: (v: unknown) => void };
let pending: Deferred[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const BOARD = { pipelineColumns: [], terminalStages: [] };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [];
  mocks.apiMock.mockReset();
  mocks.dealsListSectionMock.mockReset();
  mocks.useAuthMock.mockReset();
  mocks.useAuthMock.mockReturnValue({ user: { id: "user-1", role: "rep" }, loading: false });
  // Every call returns a deferred promise the test resolves by hand, in whatever order it likes.
  mocks.apiMock.mockImplementation((path: string) => {
    return new Promise((resolve) => {
      pending.push({ path, settled: false, resolve });
    });
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const isBoardShown = () => Boolean(container?.querySelector("#show-dd-toggle"));
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
/** Resolve a still-pending request whose path matches includeDd=<inc>, newest first. */
async function resolveRequest(inc: "true" | "false") {
  const target = [...pending].reverse().find((d) => !d.settled && d.path.includes(`includeDd=${inc}`));
  if (!target) throw new Error(`no pending request with includeDd=${inc}; paths=${pending.map((p) => p.path).join(",")}`);
  target.settled = true;
  await act(async () => {
    target.resolve(BOARD);
    await Promise.resolve();
  });
}
async function navigateAndWait(testId: string, inc: "true" | "false") {
  await act(async () => {
    (container?.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement)?.click();
  });
  await vi.waitFor(() => {
    expect(pending.some((d) => !d.settled && d.path.includes(`includeDd=${inc}`))).toBe(true);
  });
}

function Harness() {
  const navigate = useNavigate();
  return (
    <div>
      <button data-testid="nav-on" onClick={() => navigate("/pipeline?showDd=1")} />
      <button data-testid="nav-off" onClick={() => navigate("/pipeline")} />
      <PipelinePage />
    </div>
  );
}

describe("PipelinePage out-of-order pipeline responses", () => {
  it("ignores a stale Show-DD response that resolves after the latest one (never strands the board on a skeleton)", async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={["/pipeline"]}>
          <Harness />
        </MemoryRouter>
      );
    });

    // Initial load (Show-DD off) settles -> board on screen.
    await vi.waitFor(() => expect(pending.some((d) => d.path.includes("includeDd=false"))).toBe(true));
    await resolveRequest("false");
    await flush();
    expect(isBoardShown()).toBe(true);

    // Toggle Show-DD ON -> a request for the new identity goes in flight (this is the one that
    // will resolve LAST, out of order).
    await navigateAndWait("nav-on", "true");
    // Toggle Show-DD back OFF before the ON request returns -> a newer request supersedes it.
    await navigateAndWait("nav-off", "false");

    // The latest request (Show-DD off) resolves first and restores the board.
    await resolveRequest("false");
    await flush();
    expect(isBoardShown()).toBe(true);

    // The superseded Show-DD=on request now resolves LATE. Without request-sequencing it would
    // write loadedShowDd=true while the live selection is off, leaving derivePipelineBoardView
    // stuck on a skeleton with nothing in flight. It must be ignored.
    await resolveRequest("true");
    await flush();
    expect(isBoardShown()).toBe(true);
  });
});
