import {
  scorecardEditorBusyMessage,
  scorecardEditorSubmitError,
  scorecardPhotoOverflowMessage,
} from "../editor-state";

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

  it("enables rebase recovery only for the explicit server conflict code", () => {
    expect(scorecardEditorSubmitError({
      status: 409,
      code: "SCORECARD_EDIT_CONFLICT",
      message: "The scorecard could not be updated.",
    }, true)).toEqual({
      hasEditConflict: true,
      message: "This scorecard changed in another session. Your local work is safe. Reload the latest revision to retry with your changes.",
    });

    expect(scorecardEditorSubmitError({
      status: 409,
      code: "SOME_OTHER_CONFLICT",
      message: "Resolve this validation issue first.",
    }, true)).toEqual({
      hasEditConflict: false,
      message: "Resolve this validation issue first.",
    });
  });

  it("preserves the actionable photo-limit message without offering rebase", () => {
    const message = "This scorecard would contain more than 100 evidence photos, including unavailable evidence retained from the current report. Restore or remove gallery evidence, then try again.";
    expect(scorecardEditorSubmitError({
      status: 409,
      code: "SCORECARD_EDIT_PHOTO_LIMIT",
      message,
    }, true)).toEqual({
      hasEditConflict: false,
      message,
    });
  });

  it("does not infer a conflict from a code-less 409", () => {
    expect(scorecardEditorSubmitError({ status: 409, message: "Request failed (409)" }, true)).toEqual({
      hasEditConflict: false,
      message: "Couldn’t save the scorecard changes. Your work is saved — try again.",
    });
  });
});
