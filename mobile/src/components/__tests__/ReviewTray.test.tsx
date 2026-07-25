import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

// Stub VoiceRecorder so this stays a pure UI test (no expo-audio / auth context).
jest.mock("../VoiceRecorder", () => ({
  VoiceRecorder: () => null,
}));

// A Modal renders in its own window; give the sheet a plain provider so its children mount in-test.
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => <View {...props}>{children}</View>,
  };
});

import { ReviewTray } from "../ReviewTray";
import type { SessionPhoto } from "../../capture/session-photo";

function sp(over: Partial<SessionPhoto>): SessionPhoto {
  return { key: "k", clientUploadId: "cu", uri: "file://x.jpg", metadata: { takenAt: "t" }, caption: "", ...over };
}

describe("ReviewTray (per-photo captions, no shared caption)", () => {
  it("routes each caption edit to the TAPPED photo's key (independently)", () => {
    const onSetCaption = jest.fn();
    const photos = [sp({ key: "sp-1", uri: "file://A.jpg" }), sp({ key: "sp-2", uri: "file://B.jpg" })];
    const screen = render(
      <ReviewTray photos={photos} onSetCaption={onSetCaption} onAppendCaption={jest.fn()} onRemove={jest.fn()} />,
    );

    // Thumbnails render via expo-image (array-normalized source + cachePolicy), NOT core RN <Image> — a revert
    // to core Image re-introduces the Fabric image use-after-free crash while capturing.
    const thumb = screen.getByTestId("review-photo-image-sp-1");
    expect(thumb.props.source).toEqual([{ uri: "file://A.jpg" }]);
    expect(thumb.props.cachePolicy).toBe("memory-disk");

    // Both photos start uncaptioned (controlled by props; onSetCaption is a spy so props don't change).
    // Edit the FIRST tile → the edit is bound to sp-1.
    fireEvent.press(screen.getAllByLabelText("Photo — add caption")[0]);
    fireEvent.changeText(screen.getByLabelText("Photo caption"), "north wall");
    expect(onSetCaption).toHaveBeenLastCalledWith("sp-1", "north wall");

    // Now edit the SECOND tile → the edit is bound to sp-2, NOT sp-1 (the sheet re-binds to the tapped photo).
    fireEvent.press(screen.getAllByLabelText("Photo — add caption")[1]);
    fireEvent.changeText(screen.getByLabelText("Photo caption"), "active leak");
    expect(onSetCaption).toHaveBeenLastCalledWith("sp-2", "active leak");
  });

  it("shows the per-photo hint (blank = no description)", () => {
    const screen = render(
      <ReviewTray photos={[sp({ key: "sp-1" })]} onSetCaption={jest.fn()} onAppendCaption={jest.fn()} onRemove={jest.fn()} />,
    );

    fireEvent.press(screen.getByLabelText("Photo — add caption"));

    expect(screen.getByText("Optional — leave blank for no description.")).toBeTruthy();
  });
});
