import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

// gesture-handler's native handlers aren't available under jest; pass children straight through so the
// image and its props are reachable.
jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  // Forwards the handler props onto the host view so a test can fire a gesture state change the way the
  // native handler would; without that the zoom latch is unreachable and can't be covered.
  const passthrough = (name: string) =>
    function Handler({ children, onHandlerStateChange, onGestureEvent }: any) {
      return (
        <View testID={`gh:${name}`} onHandlerStateChange={onHandlerStateChange} onGestureEvent={onGestureEvent}>
          {children}
        </View>
      );
    };
  return {
    PanGestureHandler: passthrough("pan"),
    PinchGestureHandler: passthrough("pinch"),
    TapGestureHandler: passthrough("tap"),
    State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },
  };
});

// Capture what the real component hands expo-image, so the decode/caching decisions are assertable.
const mockImageProps: Record<string, unknown>[] = [];
jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => {
      mockImageProps.push(props);
      // Preserve an incoming testID so components that set one (PhotoGrid's tiles) stay findable.
      return <View testID={(props.testID as string) ?? "expo-image"} />;
    },
  };
});

import { ZoomablePhoto } from "../ZoomablePhoto";
import { PhotoGrid } from "../PhotoGrid";

const URI = "https://r2.example/full.jpg?X-Amz-Signature=abc";

beforeEach(() => {
  mockImageProps.length = 0;
});

describe("ZoomablePhoto decode + cache behaviour", () => {
  it("bounds the DECODE at 1x — allowDownscaling alone resizes only after a full-resolution decode", () => {
    render(<ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" />);
    const props = mockImageProps[mockImageProps.length - 1];
    // enforceEarlyResizing is the only prop that sets SDWebImage's imageThumbnailPixelSize, i.e. the only
    // one that stops a 4032px original from being decoded at native resolution before anything resizes it.
    expect(props.enforceEarlyResizing).toBe(true);
    expect(props.allowDownscaling).toBe(true);
  });

  it("keys the cache on the photo id, not the presigned URL, and does not tier the key by decode size", () => {
    render(<ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" />);
    const props = mockImageProps[mockImageProps.length - 1] as { source: { uri: string; cacheKey?: string } };
    // Keying on the whole signed URL would miss on every re-mint; tiering the key by decode size would miss
    // on the first pinch and re-download the original the disk cache is already holding.
    expect(props.source.cacheKey).toBe("photo-1");
    expect(props.source.uri).toBe(URI);
  });

  it("shows the cached thumbnail as the placeholder so a slow or failed full-res is never a black frame", () => {
    render(
      <ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" thumbnailUri="https://r2.example/t.jpg" />,
    );
    const props = mockImageProps[mockImageProps.length - 1] as { placeholder?: { uri: string; cacheKey?: string } };
    // The cacheKey is what makes the placeholder actually resolve from cache. Without it expo-image looks
    // the thumbnail up by URL, misses the entry the grid wrote under the id, and goes to the network for a
    // URL that is expired in exactly the situation the placeholder exists to cover.
    expect(props.placeholder).toEqual({ uri: "https://r2.example/t.jpg", cacheKey: "photo-1#thumb" });
  });

  it("looks the placeholder up under the SAME key the grid stores its thumbnail as", () => {
    // The cross-component invariant this whole mechanism rests on. Derived independently in two files it
    // would drift silently: nothing errors, the placeholder just stops appearing — which surfaces as the
    // blank pane it exists to prevent. Asserted here rather than trusted.
    const gridPhotos = [
      {
        id: "photo-1",
        displayName: "Roof detail",
        description: null,
        uploaderName: "Tester",
        imageUrl: "https://r2.example/t.jpg",
        photoCategory: null,
      },
    ] as unknown as Parameters<typeof PhotoGrid>[0]["photos"];

    render(<PhotoGrid photos={gridPhotos} onPress={jest.fn()} />);
    const gridKey = (mockImageProps[mockImageProps.length - 1] as { source: { cacheKey?: string } }).source.cacheKey;

    mockImageProps.length = 0;
    render(
      <ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" thumbnailUri="https://r2.example/t.jpg" />,
    );
    const placeholderKey = (mockImageProps[mockImageProps.length - 1] as { placeholder?: { cacheKey?: string } })
      .placeholder?.cacheKey;

    expect(placeholderKey).toBe(gridKey);
    expect(placeholderKey).toBeTruthy();
  });

  it("latches native-res decode on the first zoom, and releases it when the page goes inactive", () => {
    const { getByTestId, rerender, UNSAFE_root } = render(
      <ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" active />,
    );
    const latest = () => mockImageProps[mockImageProps.length - 1] as Record<string, unknown>;

    // 1x: decode is bounded to the container.
    expect(latest().enforceEarlyResizing).toBe(true);
    expect(latest().recyclingKey).toBe(URI);

    // A completed pinch is what promotes this page to the full-resolution decode.
    fireEvent(getByTestId("gh:pinch"), "handlerStateChange", {
      nativeEvent: { oldState: 4, state: 5, scale: 2 },
    });

    expect(latest().enforceEarlyResizing).toBe(false);
    expect(latest().allowDownscaling).toBe(false);
    // The tier is in the recyclingKey so the upgrade actually forces a re-decode.
    expect(latest().recyclingKey).toBe(`${URI}#full`);

    // Paging away releases it, so the 48MB bitmap doesn't ride along with an offscreen page.
    rerender(<ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" active={false} />);
    expect(latest().enforceEarlyResizing).toBe(true);
    expect(latest().recyclingKey).toBe(URI);
    expect(UNSAFE_root).toBeTruthy();
  });

  it("tells the parent zoom is off when it unmounts, or a remount would freeze the pager", () => {
    // Zoom state is instance-local, so any remount (a re-minted URL, a Retry) silently returns the image to
    // 1x. The parent gates horizontal paging on its own copy of that flag and only onZoomChange writes it —
    // without this cleanup the pager stays disabled over a photo that is visibly unzoomed.
    const onZoomChange = jest.fn();
    const { unmount } = render(
      <ZoomablePhoto uri={URI} width={393} height={500} cacheKey="photo-1" onZoomChange={onZoomChange} />,
    );
    onZoomChange.mockClear();
    unmount();
    expect(onZoomChange).toHaveBeenCalledWith(false);
  });
});
