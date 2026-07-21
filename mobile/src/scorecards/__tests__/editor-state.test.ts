import {
  scorecardEditorBusyMessage,
  scorecardEditorSubmitError,
  scorecardPhotoOverflowMessage,
  scorecardPhotosMissingMessage,
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

  it("uses generic overflow copy by default and rebase wording only when explicitly requested", () => {
    expect(scorecardPhotoOverflowMessage(100)).toBeNull();
    expect(scorecardPhotoOverflowMessage(101)).toContain("Remove 1 photo before saving");
    expect(scorecardPhotoOverflowMessage(102)).toContain("Remove 2 photos before saving");
    expect(scorecardPhotoOverflowMessage(102)).toContain("the limit is 100");
    expect(scorecardPhotoOverflowMessage(102)).not.toContain("latest revision");
    expect(scorecardPhotoOverflowMessage(102)).not.toContain("evidence was removed automatically");

    const rebaseMessage = scorecardPhotoOverflowMessage(102, { afterRebase: true });
    expect(rebaseMessage).toContain("after loading the latest revision");
    expect(rebaseMessage).toContain("No evidence was removed automatically");
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

  it("uses the actionable photo-limit fallback when the server message is generic", () => {
    expect(scorecardEditorSubmitError({
      status: 409,
      code: "SCORECARD_EDIT_PHOTO_LIMIT",
      message: "Request failed (409)",
    }, true)).toEqual({
      hasEditConflict: false,
      message: "This scorecard contains too many evidence photos. Remove photos and try again.",
    });
  });

  it("gives an actionable remove-and-re-add message when an evidence file is missing", () => {
    expect(scorecardPhotosMissingMessage(1)).toBe(
      "This photo’s file is missing — remove and re-add it, then submit.",
    );
    expect(scorecardPhotosMissingMessage(3)).toBe(
      "3 photos’ files are missing — remove and re-add them, then submit.",
    );
    // Never renders a zero/negative count.
    expect(scorecardPhotosMissingMessage(0)).toContain("This photo’s file is missing");
  });

  it("uses the correct generic fallback for edit saves and new submissions", () => {
    expect(scorecardEditorSubmitError({ status: 503 }, true)).toEqual({
      hasEditConflict: false,
      message: "Couldn’t save the scorecard changes. Your work is saved — try again.",
    });
    expect(scorecardEditorSubmitError(new Error("offline"), false)).toEqual({
      hasEditConflict: false,
      message: "Couldn’t submit the scorecard. Your work is saved — try again.",
    });
  });
});
