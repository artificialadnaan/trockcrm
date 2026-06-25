import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { apiFetch } from "../api/client";
import type { Fetcher } from "../api/endpoints";
import { isTokenExpired, loadSession, type Session } from "../auth/session";
import { drainUploadQueue, getQueuedCount, uploadOwnerKey } from "./upload-queue";

/**
 * Best-effort BACKGROUND drain of the persistent upload queue.
 *
 * iOS only grants short, opportunistic windows (often overnight) and may ignore the requested interval —
 * so this is a long-tail safety net, NOT the primary mechanism. The real-time resilience comes from
 * keep-awake (foreground) + resume-on-foreground/launch in the capture screen. When the OS does grant a
 * window, this rebuilds an authenticated fetcher from the stored session and drains whatever is queued.
 */
export const UPLOAD_QUEUE_TASK = "trockcam-upload-queue-drain";

/** A React-free authenticated fetcher bound to a loaded session (for the background context). */
function buildSessionFetcher(session: Session): Fetcher {
  // No onUnauthorized: a background 401 must not tear down the session out from under the UI.
  return (path, opts) => apiFetch(path, { ...opts, token: session.token, officeId: session.activeOfficeId });
}

// defineTask must run at module load so the OS can invoke it. Importing this module from the root layout
// registers the handler; registerUploadBackgroundTask() then schedules it.
TaskManager.defineTask(UPLOAD_QUEUE_TASK, async () => {
  try {
    const session = await loadSession();
    if (!session || isTokenExpired(session.token)) return BackgroundTask.BackgroundTaskResult.Success;
    // Drain only THIS user+office's queue. The fetcher binds session.activeOfficeId, so the owner key MUST
    // include the resolved office (activeOfficeId ?? tenantId) too — otherwise a queue captured under a
    // different office could drain under the current one. Matches the capture screen's namespacing.
    const ownerKey = uploadOwnerKey(session.user.id, session.activeOfficeId ?? session.user.tenantId);
    if ((await getQueuedCount(ownerKey)) === 0) return BackgroundTask.BackgroundTaskResult.Success;
    const fetcher = buildSessionFetcher(session);
    await drainUploadQueue(ownerKey, fetcher);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Schedule the background drain. Idempotent + fully guarded — a failure here never affects the app. */
export async function registerUploadBackgroundTask(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
    // 15 min is the floor; the OS treats it as a minimum and usually runs far less often.
    await BackgroundTask.registerTaskAsync(UPLOAD_QUEUE_TASK, { minimumInterval: 15 });
  } catch {
    // Background scheduling is best-effort (unsupported platform, restricted, etc.).
  }
}
