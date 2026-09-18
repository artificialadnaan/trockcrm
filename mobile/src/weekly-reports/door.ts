// Opening a report the server already knows about: the read, the decision, and what gets written.
//
// This is `openReconciled` from app/(app)/reports/index.tsx, lifted out of the screen. It used to be forty
// lines of orchestration inside a React component that no test in `mobile/` executes — and `mobile/` is not
// in CI and the app has no OTA, so a mistake in it reaches TestFlight and lives on phones for days. The
// individual decisions were well covered (reconcile.ts) and the SEQUENCING was not, which is where these
// live:
//
//   • a refusal must open nothing — the previous shape let a deleted `if` walk a PM into review mode on a
//     bounced-back report, where Approve lands a content PATCH and a whole-set photo PUT over the
//     superintendent's rewrite and only THEN 409s on the illegal transition. The mutations stick;
//   • the kept draft must be re-stamped with the SERVER's seed, not its own — otherwise the baseline never
//     advances and the same conflict is re-asked on every open, for ever;
//   • nothing may be written before the user has answered the conflict prompt.
//
// Every effect is a port method, so the whole sequence runs in a unit test. The screen supplies fetch,
// disk, navigation and Alert, and holds no branch of its own.

import type { WeeklyReportStatusValue } from "../api/types";
import {
  weeklyReportDraftFromDetail,
  weeklyReportDraftSignature,
  type WeeklyReportDraft,
  type WeeklyReportSeedableReport,
} from "./draft";
import {
  weeklyReportDiscardWarning,
  weeklyReportReconcile,
  type WeeklyReportRefusalReason,
} from "./reconcile";

/** What `GET /reports/:id` gives back, reduced to what the door reads. */
export interface WeeklyReportDoorRead {
  report: WeeklyReportSeedableReport;
  permissions: { canEdit: boolean; canApprove: boolean };
}

/**
 * Why nothing opened, and — the point of this shape — whether there is still a way to READ what is on the
 * phone.
 *
 * Routing author drafts through the refusal gate is right for the SUBMIT path and was wrong for the read
 * path. `canEditWeeklyReport` returns PM-only powers at `approved` and false at `sent`, so a plain
 * superintendent holding an author draft for a week somebody else has since filed and had approved gets
 * `canEdit: false` → refuse, on a draft that may hold a paragraph the server has never seen. The project
 * card reads "waiting", so there is no second door, and the only working control left is Discard — whose
 * warning correctly says the writing is deleted for good.
 *
 * `localCopy` is that draft, present only when it holds something unsent. Opening it is exactly what
 * `resume-local` used to do: the wizard renders it and the text can be read and copied out. It is NOT a
 * licence to file — the server refuses the PATCH, which is the correct place for that refusal to live.
 */
export interface WeeklyReportDoorRefusal {
  title: string;
  message: string;
  localCopy: WeeklyReportDraft | null;
}

export interface WeeklyReportDoorPrompt {
  title: string;
  message: string;
  keepLocalLabel: string;
  useServerLabel: string;
}

export type WeeklyReportDoorChoice = "keep-local" | "use-server" | "cancel";

export interface WeeklyReportDoorPort {
  /** Re-read the report. Throwing is the offline case, not a bug. */
  read(reportId: string): Promise<WeeklyReportDoorRead>;
  /** Ids for a draft this door is seeding from scratch. */
  newDraftId(): string;
  newClientSubmissionId(): string;
  now(): number;
  /** Persist the resolved draft (overwriting any local one it replaces) and open it. */
  commit(draft: WeeklyReportDraft): Promise<void>;
  /** Open a draft exactly as it sits on disk. No write, so nothing can be lost by taking this path. */
  open(draft: WeeklyReportDraft): void;
  /** Say why nothing opened, offering `localCopy` as a read path when there is one. */
  refuse(refusal: WeeklyReportDoorRefusal): void;
  /** Both sides moved: the person holding the phone chooses, and nothing is written until they have. */
  choose(prompt: WeeklyReportDoorPrompt): Promise<WeeklyReportDoorChoice>;
  /** The read failed and there is no local copy to fall back on. */
  unavailable(): void;
}

/** The sentence appended to a refusal that still has something readable behind it. */
export const WEEKLY_REPORT_REFUSAL_READ_PATH =
  "What you wrote on this phone is still here — open your copy to read or copy it out before you discard it.";

/**
 * How long the door waits for its read before falling back to the local copy.
 *
 * Half the client's 30s default. This read sits between the user's tap on "Resume" and anything at all
 * happening, so the default was up to half a minute of a button that looked broken — on the one-bar
 * jobsite connection this feature exists for. Timing out is not a loss: the local draft opens instead,
 * which is what a super with no signal already gets.
 */
export const WEEKLY_REPORT_DOOR_READ_TIMEOUT_MS = 15_000;

export async function openWeeklyReportDoor(
  input: {
    reportId: string;
    projectName: string;
    mode: "author" | "review";
    /** The local draft this door found, or null. */
    local: WeeklyReportDraft | null;
  },
  port: WeeklyReportDoorPort,
): Promise<void> {
  let read: WeeklyReportDoorRead;
  try {
    read = await port.read(input.reportId);
  } catch {
    // Somebody with no signal must still see what they had rather than being locked out of it. The local
    // copy is opened UNCHANGED — this branch knows nothing about the server, so it may not restamp
    // anything.
    if (input.local) {
      port.open(input.local);
      return;
    }
    port.unavailable();
    return;
  }

  const seeded = weeklyReportDraftFromDetail({
    id: input.local?.id ?? port.newDraftId(),
    clientSubmissionId: input.local?.clientSubmissionId ?? port.newClientSubmissionId(),
    projectName: input.projectName,
    mode: input.mode,
    report: read.report,
    now: port.now(),
  });
  const serverSeed: { status: WeeklyReportStatusValue; signature: string } = {
    status: read.report.status,
    signature: weeklyReportDraftSignature(seeded),
  };
  const decision = weeklyReportReconcile({
    mode: input.mode,
    server: { ...serverSeed, permissions: read.permissions },
    local: input.local
      ? { seededFrom: input.local.seededFrom, signature: weeklyReportDraftSignature(input.local) }
      : null,
  });

  if (decision.kind === "refuse") {
    const localCopy = weeklyReportDoorReadPath(decision.reason, input.local);
    port.refuse({
      title: decision.title,
      message: localCopy ? `${decision.message} ${WEEKLY_REPORT_REFUSAL_READ_PATH}` : decision.message,
      localCopy,
    });
    return;
  }
  if (decision.kind === "reseed" || !input.local) {
    await port.commit(seeded);
    return;
  }
  // Keeping the local CONTENT, but taking the server's identity: the draft now names the row it was
  // reconciled against, knows where that row stands (so the final button asks for the right transition),
  // and records what it has been SHOWN — so the next open compares against that rather than against a
  // baseline the user has never seen. Carrying the old baseline forward instead re-asks the same conflict
  // on every open until somebody answers it destructively.
  const kept: WeeklyReportDraft = {
    ...input.local,
    reportId: read.report.id,
    mode: input.mode,
    serverStatus: read.report.status,
    seededFrom: serverSeed,
  };
  if (decision.kind === "keep-local") {
    await port.commit(kept);
    return;
  }
  // Nothing is written until the answer is in. Committing first and correcting afterwards would make the
  // prompt decorative, and the destructive answer unrecoverable.
  const choice = await port.choose({
    title: decision.title,
    message: decision.message,
    keepLocalLabel: decision.keepLocalLabel,
    useServerLabel: decision.useServerLabel,
  });
  if (choice === "keep-local") await port.commit(kept);
  else if (choice === "use-server") await port.commit(seeded);
}

/**
 * The local draft to offer as a read path behind a refusal, or null.
 *
 * TWO conditions, and the first is a safety condition rather than a nicety.
 *
 * Only on an `unwritable` refusal. A `bounced-back` one still leaves the PM with `canEdit`, so the wizard
 * they would open is a live one: its final tap PATCHes the content and REPLACES the photo set over the
 * superintendent's rewrite, and only then 409s on the illegal draft → approved. That is the exact failure
 * the gate exists to stop, and re-opening a door onto it in the name of readability would reintroduce it.
 * Nor is there anything to relieve there — the project card offers the same week in AUTHOR mode, which the
 * gate deliberately allows.
 *
 * And only when the draft holds something the server has never seen. A draft that matches what the server
 * already has offers nothing to salvage, and a button there would teach people the sentence above it is
 * noise.
 */
export function weeklyReportDoorReadPath(
  reason: WeeklyReportRefusalReason,
  local: WeeklyReportDraft | null,
): WeeklyReportDraft | null {
  if (reason !== "unwritable" || !local) return null;
  const unsent = weeklyReportDiscardWarning({
    seededFrom: local.seededFrom,
    signature: weeklyReportDraftSignature(local),
  });
  return unsent ? local : null;
}
