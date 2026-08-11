import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { FieldPhoto } from "../../api/types";

jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return { SafeAreaView: ({ children, ...p }: any) => <View {...p}>{children}</View> };
});
jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return { Image: (p: any) => <View {...p} /> };
});
jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ fetcher: jest.fn(), user: { id: "u1" } }) }));
// Pulls in expo-audio's native module, which has no test double — the summary dictation isn't under test here.
jest.mock("../VoiceRecorder", () => ({ VoiceRecorder: () => null }));

const mockPreviewReport = jest.fn();
const mockGenerateReport = jest.fn();
jest.mock("../../api/endpoints", () => ({
  previewReport: (...args: unknown[]) => mockPreviewReport(...args),
  generateReport: (...args: unknown[]) => mockGenerateReport(...args),
}));

import { ReportBuilder } from "../ReportBuilder";

function galleryPhoto(id: string, name: string): FieldPhoto {
  return {
    id,
    category: "photo",
    photoCategory: "construction",
    subcategory: null,
    displayName: name,
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
    imageUrl: `https://r2.example/${id}.jpg`,
    fullImageUrl: `https://r2.example/${id}-full.jpg`,
  };
}

function previewPhoto(id: string, name: string) {
  return {
    id,
    displayName: name,
    description: null,
    takenAt: null,
    createdAt: "",
    uploaderName: "Tester",
    imageUrl: `https://r2.example/${id}.jpg`,
    tags: [],
    projectName: "District at Boynton",
  };
}

const PHOTOS = [galleryPhoto("p1", "First"), galleryPhoto("p2", "Second"), galleryPhoto("p3", "Third")];

/** The rendered order of the edit list, read off the position badges' sibling captions. */
function renderedOrder(ui: ReturnType<typeof render>): string[] {
  // Each row renders "<n>/<total>" — reading them in tree order proves the LIST re-rendered in the new
  // order, not merely that the outgoing payload did.
  return ui.getAllByLabelText(/^Move photo \d+ of \d+ earlier, /).map((node) => {
    const label = node.props.accessibilityLabel as string;
    return label.replace(/^Move photo \d+ of \d+ earlier, /, "");
  });
}

/** Drive the builder from the select step through preview into the edit step. */
async function openEditStep(ui: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.press(ui.getByText("Select all"));
  });
  await act(async () => {
    fireEvent.press(ui.getByText("Preview report"));
  });
  await waitFor(() => expect(ui.queryByText("Edit report")).not.toBeNull());
}

describe("ReportBuilder photo reordering", () => {
  beforeEach(() => {
    mockPreviewReport.mockReset();
    mockGenerateReport.mockReset();
    mockPreviewReport.mockResolvedValue({
      cover: {
        reportTitle: "Site Photo Report",
        creatorName: "Sam Super",
        companyName: "TRock",
        reportDateLabel: "Jul 30, 2026",
        projectName: "District at Boynton",
        photoCount: 3,
      },
      sections: [
        {
          id: "sec-1",
          title: "Section 1",
          photos: [previewPhoto("p1", "First"), previewPhoto("p2", "Second"), previewPhoto("p3", "Third")],
        },
      ],
    });
    mockGenerateReport.mockResolvedValue({ report: { id: "r1", title: "Site Photo Report", pdfUrl: null } });
  });

  it("sends the REORDERED photo ids — the server prints them in exactly this order", async () => {
    const ui = render(
      <ReportBuilder visible onClose={jest.fn()} projectId="d1" photos={PHOTOS} onGenerated={jest.fn()} />,
    );
    await openEditStep(ui);

    // Promote the third photo twice: p1,p2,p3 -> p1,p3,p2 -> p3,p1,p2
    await act(async () => {
      fireEvent.press(ui.getByLabelText(/^Move photo \d+ of 3 earlier, Third$/));
    });
    await act(async () => {
      fireEvent.press(ui.getByLabelText(/^Move photo \d+ of 3 earlier, Third$/));
    });
    await act(async () => {
      fireEvent.press(ui.getByText("Generate PDF"));
    });

    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
    const payload = mockGenerateReport.mock.calls[0][1];
    expect(payload.sections[0].photoIds).toEqual(["p3", "p1", "p2"]);
    // photoOverrides must stay aligned with the reordered ids, not the original order.
    expect(payload.sections[0].photoOverrides.map((o: { id: string }) => o.id)).toEqual(["p3", "p1", "p2"]);
  });

  it("moving a photo later mirrors moving the next one earlier", async () => {
    const ui = render(
      <ReportBuilder visible onClose={jest.fn()} projectId="d1" photos={PHOTOS} onGenerated={jest.fn()} />,
    );
    await openEditStep(ui);

    await act(async () => {
      fireEvent.press(ui.getByLabelText(/^Move photo \d+ of 3 later, First$/));
    });
    await act(async () => {
      fireEvent.press(ui.getByText("Generate PDF"));
    });

    expect(mockGenerateReport.mock.calls[0][1].sections[0].photoIds).toEqual(["p2", "p1", "p3"]);
  });

  it("re-renders the edit list in the new order, not just the outgoing payload", async () => {
    const ui = render(
      <ReportBuilder visible onClose={jest.fn()} projectId="d1" photos={PHOTOS} onGenerated={jest.fn()} />,
    );
    await openEditStep(ui);
    expect(renderedOrder(ui)).toEqual(["First", "Second", "Third"]);

    await act(async () => {
      fireEvent.press(ui.getByLabelText(/^Move photo \d+ of 3 earlier, Third$/));
    });
    await act(async () => {
      fireEvent.press(ui.getByLabelText(/^Move photo \d+ of 3 earlier, Third$/));
    });

    // reorderPhoto is keyed by id, so the outgoing payload would come out right even if the list froze —
    // the user would tap, watch nothing move, and receive a PDF in an order they were never shown. This
    // asserts what they actually SEE. (Read before Generate, which closes the sheet and resets state.)
    expect(renderedOrder(ui)).toEqual(["Third", "First", "Second"]);
  });

  it("keeps a caption attached to its photo across a reorder (descriptions are id-keyed)", async () => {
    const ui = render(
      <ReportBuilder visible onClose={jest.fn()} projectId="d1" photos={PHOTOS} onGenerated={jest.fn()} />,
    );
    await openEditStep(ui);

    const captionInputs = ui.getAllByPlaceholderText("Caption / description");
    await act(async () => {
      fireEvent.changeText(captionInputs[0], "caption for the first photo");
    });
    await act(async () => {
      fireEvent.press(ui.getByLabelText(/^Move photo \d+ of 3 later, First$/));
    });
    await act(async () => {
      fireEvent.press(ui.getByText("Generate PDF"));
    });

    const overrides = mockGenerateReport.mock.calls[0][1].sections[0].photoOverrides;
    expect(overrides.find((o: { id: string }) => o.id === "p1").description).toBe("caption for the first photo");
  });

  it("keeps controls distinguishable when two photos share a name (IMG_0001 twice in one section)", async () => {
    // displayName seeds from the uploader's filename and is freely editable, so duplicates are routine —
    // a label built only from the name would be ambiguous to VoiceOver and would match two nodes here.
    mockPreviewReport.mockResolvedValue({
      cover: {
        reportTitle: "Site Photo Report",
        creatorName: "Sam Super",
        companyName: "TRock",
        reportDateLabel: "Jul 30, 2026",
        projectName: "District at Boynton",
        photoCount: 2,
      },
      sections: [
        { id: "sec-1", title: "Section 1", photos: [previewPhoto("p1", "IMG_0001"), previewPhoto("p2", "IMG_0001")] },
      ],
    });
    const ui = render(
      <ReportBuilder visible onClose={jest.fn()} projectId="d1" photos={PHOTOS} onGenerated={jest.fn()} />,
    );
    await openEditStep(ui);

    // Each control resolves to exactly one node because the position leads the label.
    expect(ui.getByLabelText("Move photo 1 of 2 later, IMG_0001")).toBeTruthy();
    expect(ui.getByLabelText("Move photo 2 of 2 earlier, IMG_0001")).toBeTruthy();

    await act(async () => {
      fireEvent.press(ui.getByLabelText("Move photo 2 of 2 earlier, IMG_0001"));
    });
    await act(async () => {
      fireEvent.press(ui.getByText("Generate PDF"));
    });
    expect(mockGenerateReport.mock.calls[0][1].sections[0].photoIds).toEqual(["p2", "p1"]);
  });

  it("disables the move controls at the ends so an order can't run off the section", async () => {
    const ui = render(
      <ReportBuilder visible onClose={jest.fn()} projectId="d1" photos={PHOTOS} onGenerated={jest.fn()} />,
    );
    await openEditStep(ui);

    expect(ui.getByLabelText(/earlier, First$/).props.accessibilityState.disabled).toBe(true);
    expect(ui.getByLabelText(/later, Third$/).props.accessibilityState.disabled).toBe(true);
    expect(ui.getByLabelText(/earlier, Second$/).props.accessibilityState.disabled).toBeFalsy();
  });
});
