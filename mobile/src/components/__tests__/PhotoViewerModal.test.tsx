import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { FieldPhoto } from "../../projects/field-projects";

// A Modal renders in its own window; give it a plain provider so its children mount in-test.
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => <View {...props}>{children}</View>,
  };
});
jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  return { GestureHandlerRootView: ({ children, ...p }: any) => <View {...p}>{children}</View> };
});
// The zoomable page decodes a real image via expo-image — stub it to a plain node.
jest.mock("../ZoomablePhoto", () => ({ ZoomablePhoto: () => null }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

// Spy on the device-save so we can assert it is (never) invoked for a URL-less photo. `mock`-prefixed so
// jest allows referencing it inside the hoisted factory.
const mockSavePhotoToDevice = jest.fn(async (_url: string) => "saved" as const);
jest.mock("../../photos/save-to-device", () => ({ savePhotoToDevice: (url: string) => mockSavePhotoToDevice(url) }));

// The edit hook needs auth/query context we don't want in a pure UI test.
jest.mock("../../query/hooks", () => ({
  useUpdatePhotoMetadata: () => ({ mutate: jest.fn(), reset: jest.fn(), isError: false, isPending: false }),
}));

import { PhotoViewerModal } from "../PhotoViewerModal";

function photo(over: Partial<FieldPhoto>): FieldPhoto {
  return {
    id: "p1",
    category: "photo",
    photoCategory: "construction",
    subcategory: null,
    displayName: "Roof detail",
    mimeType: "image/jpeg",
    fileSizeBytes: null,
    fileExtension: "jpg",
    dealId: "d1",
    leadId: null,
    description: null,
    tags: [],
    takenAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    uploadedBy: "u1",
    uploaderName: "Tester",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: null,
    addressSource: null,
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    imageUrl: null,
    fullImageUrl: null,
    ...over,
  };
}

describe("PhotoViewerModal save action gating", () => {
  beforeEach(() => mockSavePhotoToDevice.mockClear());

  it("advertises Save when the current photo has a resolvable URL", () => {
    const { queryByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ fullImageUrl: "https://r2.example/full.jpg" })]}
        initialIndex={0}
        visible
        onClose={jest.fn()}
      />,
    );
    expect(queryByLabelText("Save photo to device")).not.toBeNull();
  });

  it("hides Save when the current photo has no URL (would only 403/fail)", () => {
    const { queryByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ fullImageUrl: null, imageUrl: null })]}
        initialIndex={0}
        visible
        onClose={jest.fn()}
      />,
    );
    expect(queryByLabelText("Save photo to device")).toBeNull();
  });

  it("falls back to the thumbnail URL when only imageUrl is present", async () => {
    const { getByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ fullImageUrl: null, imageUrl: "https://r2.example/thumb.jpg" })]}
        initialIndex={0}
        visible
        onClose={jest.fn()}
      />,
    );
    // saveToDevice is async (flushes state on resolve) — flush it inside act so no post-return warning fires.
    await act(async () => {
      fireEvent.press(getByLabelText("Save photo to device"));
    });
    expect(mockSavePhotoToDevice).toHaveBeenCalledWith("https://r2.example/thumb.jpg");
  });
});
