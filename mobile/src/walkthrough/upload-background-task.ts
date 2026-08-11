import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { apiFetch } from "../api/client";
import type { Fetcher } from "../api/endpoints";
import { isTokenExpired, loadSession, type Session } from "../auth/session";
import { walkOwnerKey } from "./owner-key";
import { drainWalkQueue, getSchedulableWalkCount } from "./upload";
import { walkthroughUploadClient } from "./upload-client";

/**
 * Best-effort BACKGROUND drain of the walk-artifact upload queue. Mirrors
 * ../capture/upload-background-task.ts exactly in shape and posture — same iOS reality (short,
 * opportunistic windows the OS may largely ignore), same "long-tail safety net, NOT the primary
 * mechanism" role. The walk screen's own foreground drain (kicked the moment a walk reaches
 * complete/failed, with keep-awake held during the drain) is what actually gets a walk off the
 * device most of the time; this exists so a walk still ships even if the app was killed before that
 * foreground drain finished, or the estimator left the site with the app backgrounded mid-upload.
 *
 * COEXISTENCE WITH THE PHOTO QUEUE'S TASK: this registers a SECOND, independently-named task
 * (TaskManager.defineTask + BackgroundTask.registerTaskAsync), not a replacement for
 * UPLOAD_QUEUE_TASK. That is safe, not merely hoped: expo-background-task schedules exactly ONE
 * native iOS BGProcessingTask, under the single identifier declared in Info.plist
 * (`com.expo.modules.backgroundtask.processing` — see BackgroundTaskConstants.swift). Every JS task
 * name registered via `registerTaskAsync` is a "consumer" layered on top of that ONE native
 * registration (BackgroundTaskConsumer.swift's `didRegisterTask` / `numberOfRegisteredTasksOfThisType`
 * counter); when iOS grants the window, `BackgroundTaskAppDelegateSubscriber` calls
 * `EXTaskServiceInterface.runTasks(with: .backgroundTask, ...)`, which runs EVERY registered task of
 * that type — not just the first one registered. So this task and the photo queue's run inside the
 * SAME OS-granted window, back to back, rather than competing for separate OS-level slots or
 * un-registering one another. The real cost is that they share that one window's time budget (a
 * large in-flight video PUT in one task could leave little time for the other before iOS suspends the
 * process) — an inherent property of iOS background processing generally, not something this
 * registration mis-wires. No Info.plist / app.config.ts change was needed for this: `processing` is
 * already an enabled UIBackgroundMode and the single BGTaskSchedulerPermittedIdentifiers entry already
 * covers any number of expo-task-manager task names.
 */
export const WALK_UPLOAD_QUEUE_TASK = "trockcam-walk-upload-queue-drain";

/** A React-free authenticated fetcher bound to a loaded session (for the background context). Same
 *  shape as ../capture/upload-background-task.ts's buildSessionFetcher — no onUnauthorized: a
 *  background 401 must not tear down the UI's session. */
function buildSessionFetcher(session: Session, officeId: string | null): Fetcher {
  return (path, opts) => apiFetch(path, { ...opts, token: session.token, officeId });
}

// defineTask must run at module load so the OS can invoke it — see app/_layout.tsx's side-effect
// import of this module, which registers the handler even on a cold background launch (before any
// screen, including the walk screen, ever mounts).
TaskManager.defineTask(WALK_UPLOAD_QUEUE_TASK, async () => {
  try {
    const session = await loadSession();
    if (!session || isTokenExpired(session.token)) return BackgroundTask.BackgroundTaskResult.Success;
    // Same resolution rule as the walk screen's foreground drain (activeOfficeId ?? primary office) —
    // the two MUST agree, or the background task would drain a namespace the foreground never wrote
    // walks into.
    const officeId = session.activeOfficeId ?? session.user.tenantId;
    const ownerKey = walkOwnerKey(session.user.id, officeId);
    if (!ownerKey) return BackgroundTask.BackgroundTaskResult.Success;
    if ((await getSchedulableWalkCount(ownerKey)) === 0) return BackgroundTask.BackgroundTaskResult.Success;
    await drainWalkQueue(ownerKey, buildSessionFetcher(session, officeId), walkthroughUploadClient);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Schedule the background drain. Idempotent + fully guarded — a failure here never affects the app
 *  (mirrors ../capture/upload-background-task.ts's registerUploadBackgroundTask exactly). */
export async function registerWalkUploadBackgroundTask(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
    await BackgroundTask.registerTaskAsync(WALK_UPLOAD_QUEUE_TASK, { minimumInterval: 15 });
  } catch {
    // Background scheduling is best-effort (unsupported platform, restricted, etc.).
  }
}
