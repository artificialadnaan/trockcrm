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
  it("edits ONLY the tapped photo's caption — never applies it to a sibling", () => {
    const onSetCaption = jest.fn();
    const photos = [sp({ key: "sp-1", uri: "file://A.jpg" }), sp({ key: "sp-2", uri: "file://B.jpg" })];
    const screen = render(
      <ReviewTray photos={photos} onSetCaption={onSetCaption} onAppendCaption={jest.fn()} onRemove={jest.fn()} />,
    );

    // Both photos are uncaptioned → same "add caption" tile label; tap the FIRST one.
    fireEvent.press(screen.getAllByLabelText("Photo — add caption")[0]);
    fireEvent.changeText(screen.getByLabelText("Photo caption"), "north wall");

    expect(onSetCaption).toHaveBeenCalledWith("sp-1", "north wall");
    // The other photo's key is never touched by this edit.
    expect(onSetCaption).not.toHaveBeenCalledWith("sp-2", "north wall");
  });

  it("removes the shared-caption affordance: the hint says blank means no description", () => {
    const screen = render(
      <ReviewTray photos={[sp({ key: "sp-1" })]} onSetCaption={jest.fn()} onAppendCaption={jest.fn()} onRemove={jest.fn()} />,
    );

    fireEvent.press(screen.getByLabelText("Photo — add caption"));

    expect(screen.getByText("Optional — leave blank for no description.")).toBeTruthy();
    expect(screen.queryByText(/shared caption/i)).toBeNull();
  });
});
