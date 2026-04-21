import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectorRepWorkspace } from "./director-rep-workspace";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

afterEach(() => {
  vi.unmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("DirectorRepWorkspace", () => {
  it("renders table controls, page metadata, and the first page of reps", () => {
    const html = normalize(
      renderToStaticMarkup(
        <DirectorRepWorkspace
          repCards={[
            {
              repId: "rep-1",
              repName: "Alpha Rep",
              activeDeals: 4,
              pipelineValue: 150000,
              winRate: 40,
              activityScore: 12,
              staleDeals: 1,
              staleLeads: 0,
            },
            {
              repId: "rep-2",
              repName: "Bravo Rep",
              activeDeals: 7,
              pipelineValue: 450000,
              winRate: 55,
              activityScore: 3,
              staleDeals: 2,
              staleLeads: 2,
            },
          ]}
          initialPageSize={25}
          onSelectRep={vi.fn()}
        />
      )
    );

    expect(html).toContain("Rep performance");
    expect(html).toContain("Search reps");
    expect(html).toContain("Sort by");
    expect(html).toContain("Alpha Rep");
    expect(html).toContain("Bravo Rep");
    expect(html).toContain("Page 1 of 1");
  });

  it("syncs the page back into range after a shrink and keeps navigation aligned", async () => {
    const hookState: unknown[] = [];
    let hookIndex = 0;

    vi.resetModules();
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");

      return {
        ...actual,
        useState<T>(initial: T | (() => T)) {
          const index = hookIndex++;
          if (hookState[index] === undefined) {
            hookState[index] = typeof initial === "function" ? (initial as () => T)() : initial;
          }

          const setState = (next: T | ((current: T) => T)) => {
            hookState[index] =
              typeof next === "function" ? (next as (current: T) => T)(hookState[index] as T) : next;
          };

          return [hookState[index] as T, setState] as const;
        },
        useMemo<T>(factory: () => T) {
          return factory();
        },
        useEffect(effect: () => void | (() => void)) {
          effect();
        },
      };
    });

    const { DirectorRepWorkspace: MockedDirectorRepWorkspace } = await import("./director-rep-workspace");

    const manyReps = Array.from({ length: 30 }, (_, index) => ({
      repId: `rep-${index + 1}`,
      repName: `Rep ${index + 1}`,
      activeDeals: 30 - index,
      pipelineValue: 300000 - index * 1000,
      winRate: 50,
      activityScore: 10,
      staleDeals: 0,
      staleLeads: 0,
    }));

    const fewReps = manyReps.slice(0, 10);

    const renderWorkspace = (repCards: typeof manyReps) => {
      hookIndex = 0;
      return normalize(
        renderToStaticMarkup(
          <MockedDirectorRepWorkspace
            repCards={repCards}
            initialPageSize={25}
            onSelectRep={vi.fn()}
          />
        )
      );
    };

    expect(renderWorkspace(manyReps)).toContain("Page 1 of 2");

    hookState[2] = 2;
    expect(renderWorkspace(fewReps)).toContain("Page 1 of 1");
    expect(hookState[2]).toBe(1);

    const expanded = renderWorkspace(manyReps);
    expect(expanded).toContain("Page 1 of 2");
    expect(expanded).toContain("Previous");
    expect(expanded).toContain("Next");
  });
});
