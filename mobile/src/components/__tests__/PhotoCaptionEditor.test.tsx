import React from "react";
import { Text } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";

// Stub VoiceRecorder so this stays a pure UI test (no expo-audio / auth context).
jest.mock("../VoiceRecorder", () => ({
  VoiceRecorder: ({ onTranscript }: { onTranscript: (t: string) => void }) => {
    const { Text: T } = require("react-native");
    return <T testID="voice" onPress={() => onTranscript("dictated")}>voice</T>;
  },
}));

import { PhotoCaptionEditor } from "../PhotoCaptionEditor";

describe("PhotoCaptionEditor", () => {
  it("edits the caption it was given, and renders the supplied label + footer", () => {
    const onChangeCaption = jest.fn();
    const { getByLabelText, getByText } = render(
      <PhotoCaptionEditor
        uri="file://A.jpg"
        caption="initial"
        onChangeCaption={onChangeCaption}
        onAppendCaption={jest.fn()}
        label="Add a note for this photo"
        footer={<Text>Save & next</Text>}
      />,
    );

    getByText("Add a note for this photo");
    getByText("Save & next");
    fireEvent.changeText(getByLabelText("Photo caption"), "cracked flashing");
    expect(onChangeCaption).toHaveBeenCalledWith("cracked flashing");
  });

  it("shows voice dictation only when enabled, and appends transcripts via onAppendCaption", () => {
    const onAppendCaption = jest.fn();
    const off = render(
      <PhotoCaptionEditor uri="u" caption="" onChangeCaption={jest.fn()} onAppendCaption={onAppendCaption} />,
    );
    expect(off.queryByTestId("voice")).toBeNull();

    const on = render(
      <PhotoCaptionEditor
        uri="u"
        caption=""
        onChangeCaption={jest.fn()}
        onAppendCaption={onAppendCaption}
        voiceEnabled
      />,
    );
    fireEvent.press(on.getByTestId("voice"));
    expect(onAppendCaption).toHaveBeenCalledWith("dictated");
  });
});
