import React, { useState } from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoPickerGrid } from "../PhotoPickerGrid";
import type { FieldPhoto } from "../../api/types";

function makePhotos(count: number): FieldPhoto[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    displayName: `Photo ${i}`,
    imageUrl: `https://example.test/thumb-${i}.jpg`,
  })) as unknown as FieldPhoto[];
}

// Controlled host so selection tracks presses like the real modals (which own the Set).
function Host({
  photos,
  disabled = false,
  onToggleSpy,
}: {
  photos: FieldPhoto[];
  disabled?: boolean;
  onToggleSpy?: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <PhotoPickerGrid
      photos={photos}
      selected={selected}
      cellSize={100}
      disabled={disabled}
      onToggle={(id) => {
        onToggleSpy?.(id);
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }}
    />
  );
}

describe("PhotoPickerGrid", () => {
  it("renders a pressable cell for each photo in a small gallery", () => {
    const { getByTestId } = render(<Host photos={makePhotos(4)} />);
    expect(getByTestId("photo-cell-p0")).toBeTruthy();
    expect(getByTestId("photo-cell-p3")).toBeTruthy();
  });

  it("calls onToggle with the photo id when a cell is pressed", () => {
    const onToggleSpy = jest.fn();
    const { getByTestId } = render(<Host photos={makePhotos(3)} onToggleSpy={onToggleSpy} />);
    fireEvent.press(getByTestId("photo-cell-p1"));
    expect(onToggleSpy).toHaveBeenCalledWith("p1");
  });

  it("marks a pressed cell as selected via accessibilityState", () => {
    const { getByTestId } = render(<Host photos={makePhotos(3)} />);
    const cell = getByTestId("photo-cell-p2");
    expect(cell.props.accessibilityState?.selected).toBe(false);
    fireEvent.press(cell);
    expect(getByTestId("photo-cell-p2").props.accessibilityState?.selected).toBe(true);
  });

  it("does not toggle when disabled", () => {
    const onToggleSpy = jest.fn();
    const { getByTestId } = render(<Host photos={makePhotos(3)} disabled onToggleSpy={onToggleSpy} />);
    fireEvent.press(getByTestId("photo-cell-p0"));
    expect(onToggleSpy).not.toHaveBeenCalled();
  });

  it("virtualizes a large gallery — it does NOT mount a cell for every photo", () => {
    // The whole point of the fix: a 200-photo project must not mount 200 <Image>s at once (the OOM cause).
    const { queryAllByTestId } = render(<Host photos={makePhotos(200)} />);
    const mounted = queryAllByTestId(/^photo-cell-/);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(200);
  });
});
