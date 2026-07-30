import React from "react";
import { render } from "@testing-library/react-native";

// gesture-handler's native handlers aren't available under jest; pass children straight through so the
// image and its props are reachable.
jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  const passthrough = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  return {
    PanGestureHandler: passthrough,
    PinchGestureHandler: passthrough,
    TapGestureHandler: passthrough,
    State: { ACTIVE: 4, END: 5 },
  };
});

// Capture what the real component hands expo-image, so the decode/caching decisions are assertable.
const mockImageProps: Record<string, unknown>[] = [];
jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => {
      mockImageProps.push(props);
      return <View testID="expo-image" />;
    },
  };
});

import { ZoomablePhoto } from "../ZoomablePhoto";

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
    const props = mockImageProps[mockImageProps.length - 1] as { placeholder?: { uri: string } };
    expect(props.placeholder).toEqual({ uri: "https://r2.example/t.jpg" });
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
