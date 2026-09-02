// @vitest-environment jsdom
//
// The AI-walk panel, state by state. Every `state` the endpoint can return has to render as something a
// human understands — a walk that silently renders as an empty box is indistinguishable from a walk that
// produced nothing, and those are different facts about somebody's site visit.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  reviewUrlMock: vi.fn((_id: string | null | undefined): string | null => null),
  walksMock: vi.fn(),
}));
// Mocked so the CARD is tested against both answers the URL builder can give (a link, or null for an
// unconfigured build) without reaching for import.meta.env. The builder's own rules are tested directly in
// lib/trock-scope.test.ts.
vi.mock("@/lib/trock-scope", () => ({
  buildTrockScopeReviewUrl: (id: string | null | undefined) => mocks.reviewUrlMock(id),
  resolveTrockScopeBaseUrl: () => null,
}));
vi.mock("@/hooks/use-glasses-walkthroughs", () => ({
  useDealGlassesWalkthroughs: (dealId: string) => mocks.walksMock(dealId),
}));

import {
  AiWalkCard,
  DealAiWalkPanel,
  describeConfidence,
  formatCapturedAt,
  formatWalkQuantity,
  summarizeScopeItems,
} from "./deal-ai-walk-panel";
import type { GlassesWalkthrough, GlassesWalkthroughScopeItem } from "@/hooks/use-glasses-walkthroughs";

const CAPTURED_AT = "2026-08-02T22:21:47.702Z";
const SCOPE_ID = "b91a5bfd-1111-4222-8333-444455556666";

function makeItem(
  over: Partial<GlassesWalkthroughScopeItem> & Pick<GlassesWalkthroughScopeItem, "id">
): GlassesWalkthroughScopeItem {
  return {
    workTypeCode: null,
    description: "Paint wall red",
    trade: null,
    quantity: null,
    unit: null,
    confidence: null,
    locationLabel: null,
    evidence: [],
    quantitySource: null,
    status: null,
    lowVisualConfidence: false,
    hasOpenConflict: false,
    ...over,
  };
}

function makeWalk(over: Partial<GlassesWalkthrough> & Pick<GlassesWalkthrough, "id">): GlassesWalkthrough {
  return {
    walkId: "walk-msc4vvy4-m7r30urh",
    scopeWalkthroughId: null,
    capturedAt: CAPTURED_AT,
    capturedByUserId: null,
    capturedByName: null,
    captureCensus: null,
    narrationShortfallMs: null,
    state: "processing",
    scope: null,
    ...over,
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container };
}

function buttonLabelled(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").includes(text)
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  mocks.reviewUrlMock.mockReset();
  mocks.reviewUrlMock.mockReturnValue(null);
  mocks.walksMock.mockReset();
});

describe("describeConfidence", () => {
  it("does not present a 0.50 the way it presents a 0.90", () => {
    // The whole reason the bands exist. TROCK Scope really returns values like 0.50, and rendering it in the
    // same type as a 0.90 is what gets a coin flip priced as a measurement.
    const low = describeConfidence(0.5);
    const high = describeConfidence(0.9);
    expect(low.band).toBe("low");
    expect(high.band).toBe("high");
    expect(low.label).not.toBe(high.label);
    expect(low.className).not.toBe(high.className);
  });

  it("carries the band in the TEXT, not colour alone", () => {
    // A colour-only distinction disappears in greyscale and for a colour-blind reader — for whom the panel
    // would then present a 0.50 exactly the way it presents a 0.90.
    const labels = [describeConfidence(0.95), describeConfidence(0.7), describeConfidence(0.2), describeConfidence(null)]
      .map((d) => d.label);
    expect(new Set(labels).size).toBe(4);
    expect(describeConfidence(0.5).label).toContain("Low");
    expect(describeConfidence(0.9).label).toContain("High");
  });

  it("reports a null as unscored rather than as zero", () => {
    const described = describeConfidence(null);
    expect(described.band).toBe("unscored");
    expect(described.label).toBe("No confidence score");
    expect(described.detail).toContain("not the same as a low score");
  });

  it("keeps a genuine 0 as a LOW score, not as an unscored item", () => {
    // The `!confidence` version of this check reads 0 as "no score" and hides the most damning value TROCK
    // Scope can send.
    const described = describeConfidence(0);
    expect(described.band).toBe("low");
    expect(described.label).toBe("Low · 0%");
  });

  it("refuses to convert a value outside 0-1 and shows the raw number instead", () => {
    // If TROCK Scope ever moves to a 0-100 scale, `value * 100` prints "7800%" beside a line item and
    // clamping invents a certainty nobody computed.
    const described = describeConfidence(78);
    expect(described.band).toBe("unscored");
    expect(described.label).toBe("Unrecognised confidence");
    expect(described.detail).toContain("78");
  });

  it("bands at the documented thresholds", () => {
    expect(describeConfidence(0.85).band).toBe("high");
    expect(describeConfidence(0.849).band).toBe("medium");
    expect(describeConfidence(0.6).band).toBe("medium");
    expect(describeConfidence(0.599).band).toBe("low");
  });
});

describe("formatWalkQuantity", () => {
  it("renders the quantity with its unit", () => {
    expect(formatWalkQuantity(700, "SF")).toBe("700 SF");
  });

  it("keeps a zero quantity, which is a measurement", () => {
    expect(formatWalkQuantity(0, "SF")).toBe("0 SF");
  });

  it("returns null when neither a quantity nor a unit was extracted", () => {
    // Null so the caller can say "No quantity extracted" — work still to do — instead of printing a 0 an
    // estimator would price at nothing.
    expect(formatWalkQuantity(null, null)).toBeNull();
  });

  it("renders a unit alone when only the quantity is missing", () => {
    expect(formatWalkQuantity(null, "SF")).toBe("SF");
  });

  it("groups thousands so a large take-off is readable", () => {
    expect(formatWalkQuantity(12500.5, "SF")).toBe("12,500.5 SF");
  });
});

describe("formatCapturedAt", () => {
  it("includes the time of day, not only the date", () => {
    // Two walks of the same building in one morning are otherwise indistinguishable in a list whose only
    // ordering claim is "newest first".
    const formatted = formatCapturedAt(CAPTURED_AT);
    expect(formatted).toContain("2026");
    expect(formatted).toMatch(/\d:\d{2}/);
  });

  it("echoes an unparseable timestamp verbatim rather than rendering Invalid Date", () => {
    expect(formatCapturedAt("not-a-timestamp")).toBe("not-a-timestamp");
  });
});

describe("summarizeScopeItems", () => {
  it("counts low and unscored items as needing verification", () => {
    const summary = summarizeScopeItems([
      makeItem({ id: "1", confidence: 0.95 }),
      makeItem({ id: "2", confidence: 0.5 }),
      makeItem({ id: "3", confidence: null }),
      makeItem({ id: "4", confidence: 0.7 }),
    ]);
    expect(summary).toEqual({ total: 4, needsVerification: 2 });
  });
});

describe("AiWalkCard states", () => {
  it("processing: says it is still processing and shows the captured time", async () => {
    const { container } = await render(
      <AiWalkCard walkthrough={makeWalk({ id: "w1", state: "processing" })} onRetry={vi.fn()} />
    );
    expect(container.textContent).toContain("Still processing");
    expect(container.textContent).toContain(formatCapturedAt(CAPTURED_AT));
    // The answer genuinely changes over time and the panel does not poll, so there has to be a way to ask again.
    expect(buttonLabelled(container, "Check again")).toBeDefined();
  });

  it("NAMES the capturer in the heading when one resolved", async () => {
    const walkthrough = makeWalk({ id: "w1", capturedByName: "Dana Reyes" });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent ?? "").toContain("by Dana Reyes");
  });

  it("omits the capturer clause entirely when nobody resolved, rather than saying 'Unknown'", async () => {
    // A deleted user is an ABSENCE, not a data error — the FK is ON DELETE SET NULL on purpose. Rendering
    // a placeholder there would read as something having gone wrong with a walk that is perfectly fine.
    const walkthrough = makeWalk({ id: "w1", capturedByName: null });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Walk captured");
    expect(text).not.toContain("by ");
    expect(text.toLowerCase()).not.toContain("unknown");
  });

  it("CITES what was said, and shows the stills it was said over", async () => {
    // The reason to open this panel at all. `description` is the model's reading of an utterance; the
    // quote is the utterance, and the frames are what the estimator was looking at when they said it.
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scopeWalkthroughId: SCOPE_ID,
      scope: {
        status: "ready",
        items: [
          makeItem({
            id: "i1",
            description: "Paint wall red",
            locationLabel: "Unit 12B — living area",
            evidence: [
              {
                clipId: "c1",
                timelineMs: 254800,
                quote: "paint this whole wall red",
                mentionedQuantity: 700,
                mentionedUnit: "SF",
                frames: [{ url: "https://scope.test/frame-1.jpg?sig=1", timelineMs: 254800 }],
                clipUrl: "https://scope.test/clip.mp4?sig=1",
              },
            ],
          }),
        ],
      },
    });
    const { container } = await render(
      <AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} reviewUrl="https://scope.test/review" />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("paint this whole wall red");
    expect(text).toContain("Unit 12B — living area");
    expect(text).toContain("700 SF");

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://scope.test/frame-1.jpg?sig=1");
    // Named by what it IS and WHEN, because nothing here knows what the photo shows and inventing a
    // description of a jobsite would be worse than naming the artefact.
    expect(image?.getAttribute("alt")).toContain("4:14");

    const moment = Array.from(container.querySelectorAll("a")).find((a) =>
      (a.textContent ?? "").includes("Watch this moment")
    );
    expect(moment?.getAttribute("href")).toBe("https://scope.test/review?t=254800");
  });

  it("offers a refresh when the citations carry signed media, and not otherwise", async () => {
    // TROCK Scope signs frame and clip URLs with a short TTL and the images are lazy, so a tab left
    // open past the TTL shows broken stills for evidence that is perfectly healthy. A card whose
    // citations are text-only has nothing that can rot and gets no control it does not need.
    const withMedia = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [
          makeItem({
            id: "i1",
            evidence: [
              {
                clipId: "c1",
                timelineMs: 1000,
                quote: "paint this wall",
                mentionedQuantity: null,
                mentionedUnit: null,
                frames: [{ url: "https://scope.test/f.jpg?sig=1", timelineMs: 1000 }],
                clipUrl: null,
              },
            ],
          }),
        ],
      },
    });
    const shown = await render(<AiWalkCard walkthrough={withMedia} onRetry={vi.fn()} />);
    expect(buttonLabelled(shown.container, "Refresh evidence")).toBeDefined();

    const textOnly = makeWalk({
      id: "w2",
      state: "ready",
      scope: { status: "ready", items: [makeItem({ id: "i2" })] },
    });
    const plain = await render(<AiWalkCard walkthrough={textOnly} onRetry={vi.fn()} />);
    expect(buttonLabelled(plain.container, "Refresh evidence")).toBeUndefined();
  });

  it("falls back to the presigned clip when the review origin is not configured", async () => {
    // `VITE_TROCK_SCOPE_URL` being unset is a supported build. Without this an estimator could see the
    // stills and not watch the footage they were cut from, with a working URL sitting unused in the
    // payload the server already fetched.
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [
          makeItem({
            id: "i1",
            evidence: [
              {
                clipId: "c1",
                timelineMs: 4200,
                quote: "paint this wall",
                mentionedQuantity: null,
                mentionedUnit: null,
                frames: [],
                clipUrl: "https://scope.test/clip.mp4?sig=1",
              },
            ],
          }),
        ],
      },
    });
    const { container } = await render(
      <AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} reviewUrl={null} />
    );
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      (a.textContent ?? "").includes("Watch")
    );
    expect(link?.getAttribute("href")).toBe("https://scope.test/clip.mp4?sig=1");
    expect(link?.textContent).toContain("Watch the clip");
  });

  it("offers no watch link when there is neither a review origin nor a clip", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [
          makeItem({
            id: "i1",
            evidence: [
              {
                clipId: null,
                timelineMs: null,
                quote: "paint this wall",
                mentionedQuantity: null,
                mentionedUnit: null,
                frames: [],
                clipUrl: null,
              },
            ],
          }),
        ],
      },
    });
    const { container } = await render(
      <AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} reviewUrl={null} />
    );
    expect(
      Array.from(container.querySelectorAll("a")).some((a) => (a.textContent ?? "").includes("Watch"))
    ).toBe(false);
  });

  it("marks a quantity nobody actually said as inferred", async () => {
    // A number somebody spoke and a number the model derived are different claims, and pricing them
    // alike is how a guess becomes a line item.
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [makeItem({ id: "i1", quantity: 700, unit: "SF", quantitySource: "inferred" })],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent ?? "").toContain("inferred quantity");
  });

  it("treats a MISSING quantitySource as inferred, never as spoken", async () => {
    // An older TROCK Scope build that does not send the field must not have its silence read as
    // "somebody said it" — the whole point of the flag is that it is a claim about provenance.
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [makeItem({ id: "i1", quantity: 700, unit: "SF", quantitySource: null })],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent ?? "").toContain("inferred quantity");
  });

  it("does NOT call a spoken quantity inferred", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [makeItem({ id: "i1", quantity: 700, unit: "SF", quantitySource: "spoken" })],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent ?? "").not.toContain("inferred quantity");
  });

  it("surfaces an unresolved conflict and low visual confidence", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [makeItem({ id: "i1", hasOpenConflict: true, lowVisualConfidence: true })],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("unresolved conflict");
    expect(text).toContain("low visual confidence");
  });

  it("renders a citation with no stills, rather than a broken image", async () => {
    // Frames are extracted after transcription, so a fresh walk legitimately has quotes and no pictures.
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [
          makeItem({
            id: "i1",
            evidence: [
              {
                clipId: "c1",
                timelineMs: null,
                quote: "replace the vinyl",
                mentionedQuantity: null,
                mentionedUnit: null,
                frames: [],
                clipUrl: null,
              },
            ],
          }),
        ],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent ?? "").toContain("replace the vinyl");
    expect(container.querySelector("img")).toBeNull();
  });

  it("ready: renders each line item's code, description, quantity + unit and confidence", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scopeWalkthroughId: SCOPE_ID,
      scope: {
        status: "ready",
        items: [makeItem({ id: "i1", workTypeCode: "PAINT-WALL", description: "Paint wall red", trade: "painting", quantity: 700, unit: "SF", confidence: 0.78 })],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("PAINT-WALL");
    expect(text).toContain("Paint wall red");
    expect(text).toContain("painting");
    expect(text).toContain("700 SF");
    expect(text).toContain("Medium · 78%");
  });

  it("ready: renders a 0.50 and a 0.90 in the same list as visibly different claims", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: {
        status: "ready",
        items: [
          makeItem({ id: "i1", description: "Patch ceiling", confidence: 0.5 }),
          makeItem({ id: "i2", description: "Paint wall red", confidence: 0.9 }),
        ],
      },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent).toContain("Low · 50%");
    expect(container.textContent).toContain("High · 90%");
    expect(container.innerHTML).toContain("text-red-800");
    expect(container.innerHTML).toContain("text-green-800");
    // And the shaky one is called out above the list, so "is any of this doubtful" needs no chip-reading.
    expect(container.textContent).toContain("1 to verify");
  });

  it("ready: renders an item whose optional fields are all absent without inventing values", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: { status: "ready", items: [makeItem({ id: "i1", description: "Paint wall red" })] },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    const text = container.textContent ?? "";
    // No quantity is work still to do, and no confidence is not a zero confidence.
    expect(text).toContain("No quantity extracted");
    expect(text).toContain("No confidence score");
    // Specifically NOT rendered as a zero of either kind: an unscored item is not a 0%-confident item, and
    // an unextracted quantity is not a quantity of nothing.
    expect(text).not.toContain("0%");
    expect(text).not.toContain("Low · ");
    // workTypeCode is null for every item TROCK Scope sends today; the slot is absent rather than a dash.
    expect(text).not.toContain("—");
  });

  it("ready with NO items: says no scope was extracted rather than rendering a blank box", async () => {
    const walkthrough = makeWalk({ id: "w1", state: "ready", scope: { status: "ready", items: [] } });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    expect(container.textContent).toContain("No scope extracted");
    expect(container.textContent).toContain("Scope ready");
  });

  it("unavailable: says the scope is unavailable, does NOT claim there is none, and offers a retry", async () => {
    const { container } = await render(
      <AiWalkCard walkthrough={makeWalk({ id: "w1", state: "unavailable", scopeWalkthroughId: SCOPE_ID })} onRetry={vi.fn()} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Scope unavailable");
    // "We could not read" is not "it is not there" — an estimator told their walk had vanished every time
    // TROCK Scope restarted would be worse off than one told nothing.
    expect(text).toContain("we do not know whether it");
    expect(buttonLabelled(container, "Retry")).toBeDefined();
  });

  it("missing: says the walkthrough is no longer in TROCK Scope and offers no retry", async () => {
    const { container } = await render(
      <AiWalkCard walkthrough={makeWalk({ id: "w1", state: "missing", scopeWalkthroughId: SCOPE_ID })} onRetry={vi.fn()} />
    );
    expect(container.textContent).toContain("No longer in TROCK Scope");
    // TROCK Scope has ANSWERED about this walkthrough. A retry on a settled negative is a button that does nothing.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("re-reads the deal's walks when the retry control is used", async () => {
    const onRetry = vi.fn();
    const { container } = await render(
      <AiWalkCard walkthrough={makeWalk({ id: "w1", state: "unavailable", scopeWalkthroughId: SCOPE_ID })} onRetry={onRetry} />
    );
    const retry = buttonLabelled(container, "Retry")!;
    await act(async () => {
      retry.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("links out to the walkthrough's TROCK Scope review screen, since corrections happen there", async () => {
    mocks.reviewUrlMock.mockReturnValue(`https://scope.example.com/walkthroughs/${SCOPE_ID}/review`);
    const { container } = await render(
      <AiWalkCard
        walkthrough={makeWalk({ id: "w1", state: "ready", scopeWalkthroughId: SCOPE_ID, scope: { status: "ready", items: [] } })}
        onRetry={vi.fn()}
      />
    );
    expect(mocks.reviewUrlMock).toHaveBeenCalledWith(SCOPE_ID);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`https://scope.example.com/walkthroughs/${SCOPE_ID}/review`);
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(container.textContent).toContain("Review in TROCK Scope");
  });

  it("renders no link at all when TROCK Scope's origin is not configured for this build", async () => {
    mocks.reviewUrlMock.mockReturnValue(null);
    const { container } = await render(
      <AiWalkCard
        walkthrough={makeWalk({ id: "w1", state: "ready", scopeWalkthroughId: SCOPE_ID, scope: { status: "ready", items: [] } })}
        onRetry={vi.fn()}
      />
    );
    // Never a guessed host: a dead link that looks live is harder to notice than a missing one.
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("offers no editing affordances — the panel is read-only", async () => {
    const walkthrough = makeWalk({
      id: "w1",
      state: "ready",
      scope: { status: "ready", items: [makeItem({ id: "i1", confidence: 0.9, quantity: 700, unit: "SF" })] },
    });
    const { container } = await render(<AiWalkCard walkthrough={walkthrough} onRetry={vi.fn()} />);
    // Accepting a line item here would create a second copy of a truth TROCK Scope owns and re-exports.
    expect(container.querySelectorAll("input, textarea, select, button")).toHaveLength(0);
  });
});

describe("DealAiWalkPanel", () => {
  function hookState(over: Partial<ReturnType<typeof baseHookState>> = {}) {
    return { ...baseHookState(), ...over };
  }
  function baseHookState() {
    return {
      walkthroughs: [] as GlassesWalkthrough[],
      loading: false,
      hasLoaded: true,
      error: null as string | null,
      refetch: vi.fn(),
    };
  }

  it("renders NOTHING before this deal's read resolves, even while holding another deal's walks", async () => {
    // Exactly the state the hook is in between navigating from deal 1 to deal 2 and deal 2's answer landing:
    // `hasLoaded` false, `walkthroughs` still deal 1's. Rendering them here would put one project's walk,
    // dated and captioned, on another project's scoping tab with nothing on screen saying so. (It is also
    // why most deals see no skeleton flash: a deal with no walk renders nothing throughout.)
    mocks.walksMock.mockReturnValue(
      hookState({
        hasLoaded: false,
        loading: true,
        walkthroughs: [makeWalk({ id: "w-other-deal", state: "ready", scope: { status: "ready", items: [makeItem({ id: "i1", description: "Paint wall red" })] } })],
      })
    );
    const { container } = await render(<DealAiWalkPanel dealId="deal-2" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders NOTHING before the first read resolves and there is an error from a previous deal", async () => {
    // Same rule applied to the error branch: a stale error must not surface as this deal's failure either.
    mocks.walksMock.mockReturnValue(hookState({ hasLoaded: false, loading: true, error: "Internal server error" }));
    const { container } = await render(<DealAiWalkPanel dealId="deal-2" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders NOTHING when the deal has no walks — absent, not an empty box", async () => {
    mocks.walksMock.mockReturnValue(hookState({ walkthroughs: [] }));
    const { container } = await render(<DealAiWalkPanel dealId="deal-1" />);
    expect(container.innerHTML).toBe("");
  });

  it("surfaces a failed read quietly, with a way to try again", async () => {
    const refetch = vi.fn();
    mocks.walksMock.mockReturnValue(hookState({ error: "Internal server error", refetch }));
    const { container } = await render(<DealAiWalkPanel dealId="deal-1" />);
    expect(container.textContent).toContain("load AI walks");
    const tryAgain = buttonLabelled(container, "Try again")!;
    expect(tryAgain).toBeDefined();
    await act(async () => {
      tryAgain.click();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("renders one card per walk, newest first as the server ordered them", async () => {
    mocks.walksMock.mockReturnValue(
      hookState({
        walkthroughs: [
          makeWalk({ id: "w1", state: "ready", capturedAt: "2026-08-02T22:21:47.702Z", scope: { status: "ready", items: [makeItem({ id: "i1", description: "Paint wall red", confidence: 0.9 })] } }),
          makeWalk({ id: "w2", state: "processing", capturedAt: "2026-08-01T09:00:00.000Z" }),
        ],
      })
    );
    const { container } = await render(<DealAiWalkPanel dealId="deal-1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("AI Walk");
    expect(text).toContain("Paint wall red");
    expect(text).toContain("Still processing");
    // The panel says what it is before an estimator prices anything off it.
    expect(text).toContain("verify a line before you price it");
    expect(text.indexOf("Paint wall red")).toBeLessThan(text.indexOf("Still processing"));
  });

  it("reads the walks for the deal it was mounted on", async () => {
    mocks.walksMock.mockReturnValue(hookState());
    await render(<DealAiWalkPanel dealId="deal-42" />);
    expect(mocks.walksMock).toHaveBeenCalledWith("deal-42");
  });
});
