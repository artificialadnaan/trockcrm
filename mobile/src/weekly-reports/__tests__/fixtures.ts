// Shared weekly-report fixtures.
//
// Not a `.test.ts`, so jest's testMatch does not collect it. Held in one place because reconcile, the hub
// door and the submit sequence all reason about the SAME report in the same states, and three private
// copies of "an empty row" would drift the first time a field is added — with the symptom being a suite
// that still passes while the screens disagree about what an untouched row looks like.

import {
  weeklyReportDraftFromDetail,
  type WeeklyReportDraft,
  type WeeklyReportSeedableReport,
} from "../draft";
import type {
  WeeklyReportDoorChoice,
  WeeklyReportDoorPort,
  WeeklyReportDoorPrompt,
  WeeklyReportDoorRead,
  WeeklyReportDoorRefusal,
} from "../door";

export const ALL_ALLOWED = { canEdit: true, canApprove: true };

/** A report with content on it, sitting in the PM's queue. */
export function serverReport(
  overrides: Partial<WeeklyReportSeedableReport> = {},
): WeeklyReportSeedableReport {
  return {
    id: "rep-1",
    weeklyReportProjectId: "wrp-1",
    dealId: "deal-1",
    weekOf: "2026-08-13",
    status: "pending_review",
    workCompleted: "Poured the north slab.",
    nextWeekLookAhead: "Start unit framing.",
    issuesConcerns: null,
    completionPercent: 12.5,
    weatherDelayDays: 2,
    photos: [
      {
        fileId: "file-a",
        caption: "North slab",
        originalDescription: "slab",
        takenAt: "2026-08-11T15:00:00Z",
        thumbnailUrl: "https://example.test/a.jpg?sig=one",
      },
      {
        fileId: "file-b",
        caption: "Balcony mock-up",
        originalDescription: null,
        takenAt: "2026-08-12T15:00:00Z",
        thumbnailUrl: "https://example.test/b.jpg?sig=one",
      },
    ],
    ...overrides,
  };
}

/** An empty row, exactly as `POST /reports` leaves it when a device reaches the photos step. */
export function emptyRow(
  overrides: Partial<WeeklyReportSeedableReport> = {},
): WeeklyReportSeedableReport {
  return serverReport({
    status: "draft",
    workCompleted: null,
    nextWeekLookAhead: null,
    issuesConcerns: null,
    completionPercent: null,
    weatherDelayDays: null,
    photos: [],
    ...overrides,
  });
}

export function seed(
  report: WeeklyReportSeedableReport,
  mode: "author" | "review",
  id = "draft-1",
): WeeklyReportDraft {
  return weeklyReportDraftFromDetail({
    id,
    clientSubmissionId: `sub-${id}`,
    projectName: "4123 Cedar Springs",
    mode,
    report,
    now: 1_000,
  });
}

/** Either the report the door's read returns, or a read that fails the way a jobsite does. */
export type FakeDoorServer = { read: WeeklyReportDoorRead } | { fails: true };

export function doorServer(
  report: WeeklyReportSeedableReport = serverReport(),
  permissions: { canEdit: boolean; canApprove: boolean } = ALL_ALLOWED,
): FakeDoorServer {
  return { read: { report, permissions } };
}

/**
 * The hub screen, reduced to the effects the door asks it for.
 *
 * `commit` writes to the fake disk AND records what was opened, because those are the same act on the real
 * screen: `commitDraft` persists and then opens. `answer` is what the user taps on the conflict dialog.
 */
export function fakeDoorHub(input: { server: FakeDoorServer; answer?: WeeklyReportDoorChoice }) {
  const state = {
    events: [] as string[],
    committed: null as WeeklyReportDraft | null,
    opened: null as WeeklyReportDraft | null,
    refusal: null as WeeklyReportDoorRefusal | null,
    prompt: null as WeeklyReportDoorPrompt | null,
    unavailable: false,
  };
  const port: WeeklyReportDoorPort = {
    read: async () => {
      state.events.push("read");
      if ("fails" in input.server) {
        throw Object.assign(new Error("Network request failed"), { status: 0 });
      }
      return input.server.read;
    },
    newDraftId: () => "draft-new",
    newClientSubmissionId: () => "sub-new",
    now: () => 2_000,
    commit: async (draft) => {
      state.events.push("commit");
      state.committed = draft;
      state.opened = draft;
    },
    open: (draft) => {
      state.events.push("open");
      state.opened = draft;
    },
    refuse: (refusal) => {
      state.events.push("refuse");
      state.refusal = refusal;
    },
    choose: async (prompt) => {
      state.events.push("choose");
      state.prompt = prompt;
      return input.answer ?? "cancel";
    },
    unavailable: () => {
      state.events.push("unavailable");
      state.unavailable = true;
    },
  };
  return { port, state };
}
