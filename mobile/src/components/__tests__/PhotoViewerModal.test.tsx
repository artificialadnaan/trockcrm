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
type SaveResult = "saved" | "permission_denied" | "failed";
const mockSavePhotoToDevice = jest.fn<Promise<SaveResult>, [string]>(async () => "saved");
jest.mock("../../photos/save-to-device", () => ({ savePhotoToDevice: (url: string) => mockSavePhotoToDevice(url) }));

// The edit hook needs auth/query context we don't want in a pure UI test.
jest.mock("../../query/hooks", () => ({
  useUpdatePhotoMetadata: () => ({ mutate: jest.fn(), reset: jest.fn(), isError: false, isPending: false }),
}));

// Stub auth so the viewer has a fetcher for the fresh-URL refetch.
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ fetcher: jest.fn(), user: { id: "u1" } }) }));

// Spy on the project-photos fetch used to re-mint a fresh presigned URL on save.
const mockGetProjectPhotos = jest.fn();
jest.mock("../../api/endpoints", () => ({ getProjectPhotos: (...args: unknown[]) => mockGetProjectPhotos(...args) }));

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
  beforeEach(() => {
    mockSavePhotoToDevice.mockClear();
    mockSavePhotoToDevice.mockResolvedValue("saved");
    mockGetProjectPhotos.mockReset();
  });

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

describe("PhotoViewerModal expired-URL refresh", () => {
  beforeEach(() => {
    mockSavePhotoToDevice.mockReset();
    mockGetProjectPhotos.mockReset();
  });

  it("re-fetches a fresh URL and retries once when the snapshot URL is expired (403 → failed)", async () => {
    // First save (the stale snapshot URL) fails; the retry with the fresh URL succeeds.
    mockSavePhotoToDevice
      .mockResolvedValueOnce("failed")
      .mockResolvedValueOnce("saved");
    mockGetProjectPhotos.mockResolvedValueOnce({
      photos: [photo({ id: "p1", fullImageUrl: "https://r2.example/full-FRESH.jpg" })],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
    });

    const { getByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ id: "p1", fullImageUrl: "https://r2.example/full-STALE.jpg" })]}
        initialIndex={0}
        visible
        projectDealId="d1"
        onClose={jest.fn()}
      />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText("Save photo to device"));
    });

    expect(mockSavePhotoToDevice).toHaveBeenNthCalledWith(1, "https://r2.example/full-STALE.jpg");
    expect(mockGetProjectPhotos).toHaveBeenCalledWith(expect.anything(), "d1", { page: 1, perPage: 200 });
    expect(mockSavePhotoToDevice).toHaveBeenNthCalledWith(2, "https://r2.example/full-FRESH.jpg");
  });

  it("does NOT retry when the save succeeds on the first (unexpired) URL", async () => {
    mockSavePhotoToDevice.mockResolvedValue("saved");
    const { getByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ id: "p1", fullImageUrl: "https://r2.example/full.jpg" })]}
        initialIndex={0}
        visible
        projectDealId="d1"
        onClose={jest.fn()}
      />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText("Save photo to device"));
    });
    expect(mockSavePhotoToDevice).toHaveBeenCalledTimes(1);
    expect(mockGetProjectPhotos).not.toHaveBeenCalled();
  });

  it("does NOT retry on a permission denial (only genuine 'failed' triggers a refresh)", async () => {
    mockSavePhotoToDevice.mockResolvedValue("permission_denied");
    const { getByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ id: "p1", fullImageUrl: "https://r2.example/full.jpg" })]}
        initialIndex={0}
        visible
        projectDealId="d1"
        onClose={jest.fn()}
      />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText("Save photo to device"));
    });
    expect(mockSavePhotoToDevice).toHaveBeenCalledTimes(1);
    expect(mockGetProjectPhotos).not.toHaveBeenCalled();
  });

  it("surfaces the error without retrying the SAME URL when the refresh yields an identical (still-stale) URL", async () => {
    mockSavePhotoToDevice.mockResolvedValue("failed");
    mockGetProjectPhotos.mockResolvedValueOnce({
      photos: [photo({ id: "p1", fullImageUrl: "https://r2.example/full-STALE.jpg" })],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
    });
    const { getByLabelText } = render(
      <PhotoViewerModal
        photos={[photo({ id: "p1", fullImageUrl: "https://r2.example/full-STALE.jpg" })]}
        initialIndex={0}
        visible
        projectDealId="d1"
        onClose={jest.fn()}
      />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText("Save photo to device"));
    });
    // The refetch ran, but the URL matched — no pointless second save of the same dead link.
    expect(mockGetProjectPhotos).toHaveBeenCalledTimes(1);
    expect(mockSavePhotoToDevice).toHaveBeenCalledTimes(1);
  });
});
