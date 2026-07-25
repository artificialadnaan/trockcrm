import React, { useState } from "react";
import { View } from "react-native";
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

  it("virtualizes — the mounted cell count is bounded and independent of gallery size", () => {
    // The point of the fix: mount count must NOT grow with the gallery (that unbounded growth is the OOM).
    const small = render(<Host photos={makePhotos(200)} />);
    const smallCount = small.queryAllByTestId(/^photo-cell-/).length;
    small.unmount();

    const big = render(<Host photos={makePhotos(800)} />);
    const bigCount = big.queryAllByTestId(/^photo-cell-/).length;

    expect(smallCount).toBeGreaterThan(0);
    expect(smallCount).toBeLessThan(200); // not every photo is mounted
    expect(bigCount).toBe(smallCount); // 4x the gallery mounts the SAME window — the OOM-safety property
  });

  it("renders each thumbnail with expo-image (not core Image) using the thumbnail URL", () => {
    const { getByTestId } = render(<Host photos={makePhotos(2)} />);
    const image = getByTestId("photo-image-p0");
    // expo-image normalizes `source` to an array of sources (core RN <Image> keeps the bare object).
    expect(image.props.source).toEqual([{ uri: "https://example.test/thumb-0.jpg" }]);
    // cachePolicy + recyclingKey are expo-image-only props — core RN <Image> has neither, so this fails
    // if the grid ever regresses back to core Image (which re-introduces the decoded-bitmap OOM).
    expect(image.props.cachePolicy).toBe("memory-disk");
    expect(image.props.recyclingKey).toBe("p0");
  });

  it("renders a placeholder (no image) when a photo has no imageUrl", () => {
    const photos = [{ id: "p0", displayName: "No image", imageUrl: null }] as unknown as FieldPhoto[];
    const { queryByTestId, getByTestId } = render(<Host photos={photos} />);
    expect(queryByTestId("photo-image-p0")).toBeNull();
    expect(getByTestId("photo-cell-p0")).toBeTruthy(); // still a pressable cell
  });

  it("renders the header and footer inside the list", () => {
    const { getByTestId } = render(
      <PhotoPickerGrid
        photos={makePhotos(2)}
        selected={new Set()}
        onToggle={jest.fn()}
        cellSize={100}
        header={<View testID="grid-header" />}
        footer={<View testID="grid-footer" />}
      />,
    );
    expect(getByTestId("grid-header")).toBeTruthy();
    expect(getByTestId("grid-footer")).toBeTruthy();
  });

  it("uses the getAccessibilityLabel override when provided", () => {
    const getLabel = jest.fn((photo: FieldPhoto, isSelected: boolean) => `custom ${photo.id} ${isSelected}`);
    const { getByTestId } = render(
      <PhotoPickerGrid
        photos={makePhotos(1)}
        selected={new Set()}
        onToggle={jest.fn()}
        cellSize={100}
        getAccessibilityLabel={getLabel}
      />,
    );
    expect(getByTestId("photo-cell-p0").props.accessibilityLabel).toBe("custom p0 false");
    expect(getLabel).toHaveBeenCalledWith(expect.objectContaining({ id: "p0" }), false);
  });
});
