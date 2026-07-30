import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PHOTO_GRID_COLUMNS, PhotoGrid, PhotoGridRow } from "../PhotoGrid";
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
    // The cacheKey is the photo id, NOT the presigned URL: the signature changes on every list refetch, so
    // a URL-keyed cache misses every time and re-downloads thumbnails it already holds. Suffixed so it can
    // never collide with the viewer's full-size entry for the same photo.
    expect(image.props.source).toEqual([{ uri: "https://example.test/thumb-0.jpg", cacheKey: "p0#thumb" }]);
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

// The project gallery renders PhotoGridRow inside a FlatList instead of mounting the whole grid, so that a
// project with thousands of photos doesn't hold a native image view (and a decoded tile) for every one.
describe("PhotoGridRow", () => {
  it("renders exactly the photos it is handed, with the same tile markup as the grid", () => {
    const photos = makePhotos(PHOTO_GRID_COLUMNS);
    const { getByTestId } = render(<PhotoGridRow photos={photos} size={120} onPress={jest.fn()} />);
    for (const photo of photos) expect(getByTestId(`photo-grid-image-${photo.id}`)).toBeTruthy();
  });

  it("renders a short final row without padding it out", () => {
    const { getByTestId, queryByTestId } = render(
      <PhotoGridRow photos={makePhotos(1)} size={120} onPress={jest.fn()} />,
    );
    expect(getByTestId("photo-grid-image-p0")).toBeTruthy();
    expect(queryByTestId("photo-grid-image-p1")).toBeNull();
  });

  it("calls onPress with the tapped photo", () => {
    const onPress = jest.fn();
    const photos = makePhotos(3);
    const { getByLabelText } = render(<PhotoGridRow photos={photos} size={120} onPress={onPress} />);
    fireEvent.press(getByLabelText("Photo 2"));
    expect(onPress).toHaveBeenCalledWith(photos[2]);
  });
});
