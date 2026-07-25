import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoGrid } from "../PhotoGrid";
import type { FieldPhoto } from "../../api/types";

function makePhotos(count: number): FieldPhoto[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    displayName: `Photo ${i}`,
    description: `desc ${i}`,
    uploaderName: "Adnaan",
    imageUrl: `https://example.test/thumb-${i}.jpg`,
    photoCategory: null,
  })) as unknown as FieldPhoto[];
}

describe("PhotoGrid", () => {
  it("renders each photo with expo-image (not core RN Image), avoiding the RCTImageManager crash path", () => {
    const { getByTestId } = render(<PhotoGrid photos={makePhotos(3)} onPress={jest.fn()} />);
    const image = getByTestId("photo-grid-image-p0");
    // expo-image array-normalizes `source` and carries cachePolicy/recyclingKey; core RN <Image> does neither.
    // A revert to core <Image> re-introduces the Fabric ImageResponseObserverCoordinator use-after-free crash,
    // so these assertions fail if that happens.
    expect(image.props.source).toEqual([{ uri: "https://example.test/thumb-0.jpg" }]);
    expect(image.props.cachePolicy).toBe("memory-disk");
    expect(image.props.recyclingKey).toBe("p0");
  });

  it("renders a placeholder (no image node) when a photo has no imageUrl", () => {
    const photos = [
      { id: "p0", displayName: "x", description: null, uploaderName: "A", imageUrl: null, photoCategory: null },
    ] as unknown as FieldPhoto[];
    const { queryByTestId } = render(<PhotoGrid photos={photos} onPress={jest.fn()} />);
    expect(queryByTestId("photo-grid-image-p0")).toBeNull();
  });

  it("calls onPress with the tapped photo", () => {
    const onPress = jest.fn();
    const photos = makePhotos(2);
    const { getByLabelText } = render(<PhotoGrid photos={photos} onPress={onPress} />);
    fireEvent.press(getByLabelText("Photo 1")); // accessibilityLabel = photo.displayName
    expect(onPress).toHaveBeenCalledWith(photos[1]);
  });
});
