import { scorecardEditorBusyMessage, scorecardPhotoOverflowMessage } from "../editor-state";

describe("scorecard editor guards", () => {
  it("blocks navigation while saving, copying evidence, or finishing dictation", () => {
    expect(scorecardEditorBusyMessage({ submitting: true, savingPhotos: false, voiceBusy: false }))
      .toBe("Saving this scorecard — please wait.");
    expect(scorecardEditorBusyMessage({ submitting: false, savingPhotos: true, voiceBusy: false }))
      .toBe("Saving a photo — one moment…");
    expect(scorecardEditorBusyMessage({ submitting: false, savingPhotos: false, voiceBusy: true }))
      .toBe("Finishing dictation — please wait before leaving.");
    expect(scorecardEditorBusyMessage({ submitting: false, savingPhotos: false, voiceBusy: false })).toBeNull();
  });

  it("makes a no-drop conflict overflow explicit", () => {
    expect(scorecardPhotoOverflowMessage(100)).toBeNull();
    expect(scorecardPhotoOverflowMessage(101)).toContain("Remove 1 photo before saving");
    expect(scorecardPhotoOverflowMessage(102)).toContain("Remove 2 photos before saving");
    expect(scorecardPhotoOverflowMessage(102)).toContain("no evidence was removed automatically");
  });
});
