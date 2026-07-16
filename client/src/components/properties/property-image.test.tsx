/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyImageAvatar, PropertyPhotoButton } from "./property-image";
import type { PropertySurface } from "@/hooks/use-properties";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PropertyImageAvatar", () => {
  it("renders the fallback building icon (no <img>) when there is no photo", () => {
    act(() => {
      root.render(<PropertyImageAvatar name="Milo at Mountain Park" imageThumbnailUrl={null} imageUrl={null} />);
    });
    expect(container.querySelector("img")).toBeNull();
    // lucide icons render as <svg>.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders the thumbnail image and a view control when a photo exists", () => {
    act(() => {
      root.render(
        <PropertyImageAvatar
          name="Milo at Mountain Park"
          imageThumbnailUrl="https://cdn.example/thumb.jpg"
          imageUrl="https://cdn.example/full.jpg"
        />,
      );
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://cdn.example/thumb.jpg");
    expect(container.querySelector('button[aria-label="View photo of Milo at Mountain Park"]')).not.toBeNull();
  });

  it("calls onRefreshNeeded once when the image fails to load (expired URL recovery)", () => {
    const onRefreshNeeded = vi.fn();
    act(() => {
      root.render(
        <PropertyImageAvatar
          name="Milo"
          imageThumbnailUrl="https://cdn/thumb.jpg"
          imageUrl="https://cdn/full.jpg"
          onRefreshNeeded={onRefreshNeeded}
        />,
      );
    });
    const img = container.querySelector("img") as HTMLImageElement;
    act(() => img.dispatchEvent(new Event("error", { bubbles: false })));
    act(() => img.dispatchEvent(new Event("error", { bubbles: false })));
    // Bounded to a single refresh per URL so a genuinely broken object can't loop.
    expect(onRefreshNeeded).toHaveBeenCalledTimes(1);
  });
});

describe("PropertyPhotoButton", () => {
  const baseProperty: Pick<PropertySurface, "id" | "imageThumbnailUrl"> = {
    id: "prop-1",
    imageThumbnailUrl: null,
  };

  it("shows an Add photo control and a hidden image input when there is no photo", () => {
    act(() => {
      root.render(<PropertyPhotoButton property={baseProperty} onChange={() => {}} />);
    });
    expect(container.textContent).toContain("Add photo");
    const input = container.querySelector('input[data-testid="property-photo-input"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.getAttribute("accept")).toBe("image/*");
    expect(input!.type).toBe("file");
  });

  it("shows the Photo menu trigger when a photo already exists", () => {
    act(() => {
      root.render(
        <PropertyPhotoButton property={{ id: "prop-1", imageThumbnailUrl: "https://cdn/thumb.jpg" }} onChange={() => {}} />,
      );
    });
    expect(container.textContent).toContain("Photo");
    expect(container.textContent).not.toContain("Add photo");
  });
});
