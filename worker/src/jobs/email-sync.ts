import { pool } from "../db.js";
import crypto from "crypto";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// RED email-signature coordination — body-on-dedup-collision policy.
// Default OFF = OPTION (a): when a Sent-folder copy collides with an existing row on internet_message_id,
// trust the CRM compose-time body and skip cleanly. Flip to true ONLY if signatures are appended
// SERVER-SIDE (Exchange transport rule / Outlook client signature), where the CRM never sees the final
// as-sent body — then OPTION (b) lets the Sent-folder copy win the body field so the stored copy matches
// what the client actually received. See .audit/outlook-graph-sync-discovery.md.
const SENT_COPY_WINS_BODY_ON_COLLISION = false;
const SERVER_MODULE_ROOT =
  process.env.NODE_ENV === "production" ? "../../../server/dist/modules" : "../../../server/src/modules";
const SERVER_EMAIL_ASSIGNMENT_MODULE = `${SERVER_MODULE_ROOT}/email/assignment-service.js` as string;
const SERVER_EVALUATOR_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/evaluator.js` as string;
const SERVER_TASK_RULES_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/config.js` as string;
const SERVER_TASK_PERSISTENCE_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/persistence.js` as string;

// ---------- Inline encryption (worker can't import from server package) ----------
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex && process.env.NODE_ENV !== "test") {
    throw new Error("ENCRYPTION_KEY must be set (64-character hex string)");
  }
  const keyHex = hex || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const buf = Buffer.from(keyHex, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

function decrypt(encoded: string): string {
  const key = getEncryptionKey();
  const packed = Buffer.from(encoded, "base64");
  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// ---------- Inline Graph request (worker can't import from server package) ----------
interface GraphFetchResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

const MAX_429_RETRIES = 3;

async function graphFetch<T = any>(
  accessToken: string,
  path: string
): Promise<GraphFetchResult<T>> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE_URL}${path}`;

  for (let retryCount = 0; retryCount <= MAX_429_RETRIES; retryCount++) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 429) {
      if (retryCount >= MAX_429_RETRIES) {
        throw new Error(`Rate limited (429) after ${MAX_429_RETRIES} retries for ${path}`);
      }
      const retryAfter = parseInt(res.headers.get("Retry-After") || "10", 10);
      console.warn(`[Worker:email-sync] 429 rate limited, waiting ${retryAfter}s (attempt ${retryCount + 1}/${MAX_429_RETRIES})`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    const data: T = res.status === 204 ? ({} as T) : await res.json().catch(() => ({} as T));
    return { ok: res.ok, status: res.status, data };
  }

  // Should not reach here, but TypeScript needs a return
  throw new Error(`Unexpected exit from graphFetch retry loop for ${path}`);
}

// ---------- Inline encrypt (needed for storing refreshed tokens) ----------
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

/**
 * Refresh an expired access token using MSAL cache stored in the DB (worker context).
 * Returns the NEW encrypted access token string (for use in tokenRow.access_token),
 * or null if refresh fails (marks reauth_needed).
 */
async function refreshTokenForWorker(client: any, tokenRow: any): Promise<string | null> {
  try {
    // Dynamically import MSAL (available in worker's node_modules)
    const { ConfidentialClientApplication } = await import("@azure/msal-node");

    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;
    const tenantId = process.env.AZURE_TENANT_ID || "common";
    if (!clientId || !clientSecret) {
      console.error("[Worker:email-sync] AZURE_CLIENT_ID/SECRET not set — cannot refresh token");
      return null;
    }

    // Decrypt the stored MSAL serialized cache
    const serializedCache = decrypt(tokenRow.refresh_token);

    // Create a fresh per-user MSAL instance with only this user's cache
    const cca = new ConfidentialClientApplication({
      auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
    });
    cca.getTokenCache().deserialize(serializedCache);

    const accounts = await cca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      await client.query(
        `UPDATE public.user_graph_tokens
         SET status = 'reauth_needed', error_message = $1, updated_at = NOW()
         WHERE user_id = $2`,
        ["No cached MSAL account found during worker refresh", tokenRow.user_id]
      );
      return null;
    }

    // Look up by homeAccountId if stored
    const homeAccountId = tokenRow.home_account_id;
    const account = homeAccountId
      ? accounts.find((a: any) => a.homeAccountId === homeAccountId) ?? accounts[0]
      : accounts[0];

    const scopes = ["Mail.Read", "Mail.Send", "Mail.ReadWrite", "User.Read", "offline_access"];
    const result = await cca.acquireTokenSilent({ account, scopes });

    if (!result?.accessToken) {
      await client.query(
        `UPDATE public.user_graph_tokens
         SET status = 'reauth_needed', error_message = $1, updated_at = NOW()
         WHERE user_id = $2`,
        ["Token refresh returned empty response in worker", tokenRow.user_id]
      );
      return null;
    }

    const newExpiresAt = result.expiresOn ?? new Date(Date.now() + 3600 * 1000);
    const newSerializedCache = cca.getTokenCache().serialize();
    const newHomeAccountId = result.account?.homeAccountId ?? homeAccountId;

    // Encrypt and store the refreshed tokens
    const encryptedAccess = encrypt(result.accessToken);
    const encryptedCache = encrypt(newSerializedCache);

    await client.query(
      `UPDATE public.user_graph_tokens
       SET access_token = $1, refresh_token = $2, home_account_id = $3,
           token_expires_at = $4, updated_at = NOW()
       WHERE user_id = $5`,
      [encryptedAccess, encryptedCache, newHomeAccountId, newExpiresAt, tokenRow.user_id]
    );

    console.log(`[Worker:email-sync] Refreshed token for user ${tokenRow.user_id}`);
    // Return the NEW encrypted access token so the caller can update tokenRow
    return encryptedAccess;
  } catch (err: any) {
    console.error(`[Worker:email-sync] Token refresh failed for user ${tokenRow.user_id}:`, err.message);
    await client.query(
      `UPDATE public.user_graph_tokens
       SET status = 'reauth_needed', error_message = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [`Worker refresh failed: ${err.message}`, tokenRow.user_id]
    );
    return null;
  }
}

/**
 * Inbound email sync job.
 *
 * Runs every 5 minutes. For each user with an active Graph token:
 * 1. Use delta query to get new messages since last sync
 * 2. For each message, match from/to addresses against contacts.email
 * 3. If match found: store email, auto-associate to deal, create activity
 * 4. Update delta link for next sync
 *
 * Selective sync: only emails from/to known CRM contacts are stored.
 */
export async function runEmailSync(): Promise<void> {
  console.log("[Worker:email-sync] Starting email sync...");

  const client = await pool.connect();
  try {
    // Get all users with active Graph tokens
    const tokenRows = await client.query(
      `SELECT ugt.user_id, ugt.access_token, ugt.refresh_token,
              ugt.home_account_id, ugt.token_expires_at, ugt.last_delta_link,
              ugt.last_inbox_delta_link, ugt.last_sent_delta_link, ugt.last_inbox_sync_at,
              ugt.last_sync_at, u.office_id, u.email AS user_email
       FROM public.user_graph_tokens ugt
       JOIN public.users u ON u.id = ugt.user_id
       WHERE ugt.status = 'active' AND u.is_active = true`
    );

    if (tokenRows.rows.length === 0) {
      console.log("[Worker:email-sync] No active Graph tokens — skipping");
      return;
    }

    console.log(`[Worker:email-sync] Processing ${tokenRows.rows.length} users`);

    for (const tokenRow of tokenRows.rows) {
      try {
        // Skip if last sync was less than 60 seconds ago (prevents overlap with slow syncs)
        if (
          tokenRow.last_sync_at &&
          Date.now() - new Date(tokenRow.last_sync_at).getTime() < 60_000
        ) {
          continue;
        }

        // Refresh token if within 5 min of expiry (single-statement UPDATE — autocommit, no wrapping txn).
        const expiresAt = new Date(tokenRow.token_expires_at);
        if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
          const refreshedToken = await refreshTokenForWorker(client, tokenRow);
          if (!refreshedToken) continue; // reauth marked inside refreshTokenForWorker
          tokenRow.access_token = refreshedToken;
        }

        // Sync folders, EACH in its own transaction so a Sent-folder failure can't roll back the
        // already-committed Inbox sync (the Inbox pipeline is live in prod).
        await syncUserMailbox(client, tokenRow);
      } catch (err: any) {
        console.error(
          `[Worker:email-sync] Failed for user ${tokenRow.user_id}:`,
          err.message
        );

        // If token is invalid (401), mark for reauth
        if (
          err.message?.includes("401") ||
          err.message?.includes("InvalidAuthenticationToken")
        ) {
          await client.query(
            `UPDATE public.user_graph_tokens
             SET status = 'reauth_needed', error_message = $1, updated_at = NOW()
             WHERE user_id = $2`,
            [`Sync failed: ${err.message}`, tokenRow.user_id]
          ).catch(() => {});
        }
      }
    }

    console.log("[Worker:email-sync] Sync complete");
  } finally {
    client.release();
  }
}

// One mailbox folder to delta-sync. Inbox carries inbound mail; Sent Items carries the rep's own
// outbound mail — including emails composed directly in Outlook, which never enter the CRM otherwise.
interface MailFolderSync {
  folder: "inbox" | "sentitems";
  direction: "inbound" | "outbound";
  cursorColumn: "last_inbox_delta_link" | "last_sent_delta_link";
  syncAtColumn: "last_inbox_sync_at" | "last_sent_sync_at";
  // Where this run's delta resumes from (null → fresh 7-day query).
  initialCursor: string | null;
}

/**
 * Choose the inbox delta cursor to resume from.
 *
 * Before this worker version, prod advanced a single `last_delta_link` for the inbox. Migration 0129
 * backfilled `last_inbox_delta_link = last_delta_link` ONCE and then it froze, while the old worker kept
 * advancing `last_delta_link` — so for a user the new worker hasn't synced yet, `last_delta_link` is the
 * LIVE cursor and `last_inbox_delta_link` is stale. `last_inbox_sync_at` is only ever written by THIS
 * worker, so its presence means the new worker has taken over the inbox and `last_inbox_delta_link` is now
 * authoritative. Preferring the stale cursor would resume from an expired delta link → large replay or a
 * persistent Graph delta failure on every run.
 */
export function pickInboxStartCursor(tokenRow: {
  last_inbox_sync_at?: unknown;
  last_inbox_delta_link?: string | null;
  last_delta_link?: string | null;
}): string | null {
  if (tokenRow.last_inbox_sync_at) {
    return tokenRow.last_inbox_delta_link ?? null;
  }
  return tokenRow.last_delta_link ?? tokenRow.last_inbox_delta_link ?? null;
}

function buildMailFolders(tokenRow: any): MailFolderSync[] {
  return [
    {
      folder: "inbox",
      direction: "inbound",
      cursorColumn: "last_inbox_delta_link",
      syncAtColumn: "last_inbox_sync_at",
      initialCursor: pickInboxStartCursor(tokenRow),
    },
    {
      folder: "sentitems",
      direction: "outbound",
      cursorColumn: "last_sent_delta_link",
      syncAtColumn: "last_sent_sync_at",
      initialCursor: tokenRow.last_sent_delta_link ?? null,
    },
  ];
}

/**
 * Sync a user's mailbox folders, EACH IN ITS OWN TRANSACTION. Isolating folders is critical: a Sent-folder
 * failure must never roll back the Inbox sync that already committed (the Inbox pipeline is live in prod).
 * The per-user advisory lock is taken per folder-transaction to prevent concurrent syncs of the same user.
 */
async function syncUserMailbox(client: any, tokenRow: any): Promise<void> {
  const { user_id, access_token, office_id } = tokenRow;
  const currentAccessToken = decrypt(access_token);

  // Resolve the office schema for this user (read — no transaction needed).
  const officeResult = await client.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [office_id]
  );
  if (officeResult.rows.length === 0) return;

  const officeSlug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(officeSlug)) {
    console.error(`[Worker:email-sync] Invalid office slug: "${officeSlug}" — skipping`);
    return;
  }
  const schemaName = `office_${officeSlug}`;

  for (const f of buildMailFolders(tokenRow)) {
    try {
      await client.query("BEGIN");
      // Per-user advisory lock prevents concurrent syncs of the same user; held for this folder's txn.
      const lockResult = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
        [user_id]
      );
      if (!lockResult.rows[0]?.acquired) {
        await client.query("COMMIT");
        console.log(`[Worker:email-sync] Skipping user ${user_id} — sync already in progress`);
        break;
      }
      await syncUserMailFolder(client, currentAccessToken, user_id, office_id, schemaName, f);
      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[Worker:email-sync] ${f.folder} sync failed for user ${user_id}:`, err.message);
      // A 401 means the token is dead for ALL folders → mark reauth and stop. Any other folder error
      // (e.g. a transient Graph error on Sent) is ISOLATED here: the already-committed Inbox sync is
      // untouched, so the live inbound pipeline keeps working.
      if (err.message?.includes("401") || err.message?.includes("InvalidAuthenticationToken")) {
        await client
          .query(
            `UPDATE public.user_graph_tokens
             SET status = 'reauth_needed', error_message = $1, updated_at = NOW()
             WHERE user_id = $2`,
            [`Sync failed: ${err.message}`, user_id]
          )
          .catch(() => {});
        break;
      }
    }
  }
}

async function syncUserMailFolder(
  poolClient: any,
  accessToken: string,
  userId: string,
  officeId: string,
  schemaName: string,
  f: MailFolderSync
): Promise<void> {
  // First sync for this folder: messages endpoint with select fields (last 7 days).
  // Subsequent syncs: the stored delta link (which encodes the original $select).
  //
  // CRITICAL: Graph message-delta only supports a `receivedDateTime` $filter — NOT `sentDateTime`
  // (which 400s with ErrorInvalidUrlQuery). Sent Items rows DO carry receivedDateTime, so we filter both
  // folders on it; outbound additionally selects sentDateTime for the stored sent_at. (Inbox uses this
  // exact receivedDateTime filter in prod today, so it's known-supported.)
  let deltaUrl: string;
  if (f.initialCursor) {
    deltaUrl = f.initialCursor;
  } else {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const selectFields =
      "id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,hasAttachments,receivedDateTime" +
      (f.direction === "outbound" ? ",sentDateTime" : "");
    deltaUrl = `/me/mailFolders/${f.folder}/messages/delta?$select=${selectFields}&$filter=receivedDateTime ge ${sevenDaysAgo}`;
  }

  // Fetch messages page by page via delta
  let nextLink: string | null = deltaUrl;
  let newDeltaLink: string | null = null;
  let totalProcessed = 0;

  while (nextLink) {
    const result: GraphFetchResult<any> = await graphFetch(accessToken, nextLink);

    if (!result.ok) {
      if (result.status === 401) {
        throw new Error("401 InvalidAuthenticationToken");
      }
      throw new Error(
        `Graph API error: ${result.status} ${JSON.stringify(result.data)}`
      );
    }

    const messages = result.data.value ?? [];

    for (const msg of messages) {
      // Skip deleted/removed messages from delta (they have @removed)
      if (msg["@removed"]) continue;

      const processed = await processMailMessage(
        poolClient,
        schemaName,
        userId,
        officeId,
        msg,
        f.direction
      );
      if (processed) totalProcessed++;
    }

    // Follow pagination
    nextLink = result.data["@odata.nextLink"] ?? null;
    // Delta link is only on the last page
    if (result.data["@odata.deltaLink"]) {
      newDeltaLink = result.data["@odata.deltaLink"];
    }
  }

  // Persist the folder's own cursor + per-folder sync time + the overall heartbeat. The split cursor
  // columns (last_inbox_delta_link / last_sent_delta_link) are hardcoded literals from MailFolderSync,
  // never user input — safe to interpolate.
  if (newDeltaLink) {
    await poolClient.query(
      `UPDATE public.user_graph_tokens
       SET ${f.cursorColumn} = $1, ${f.syncAtColumn} = NOW(), last_sync_at = NOW(), updated_at = NOW()
       WHERE user_id = $2`,
      [newDeltaLink, userId]
    );
  } else {
    await poolClient.query(
      `UPDATE public.user_graph_tokens
       SET ${f.syncAtColumn} = NOW(), last_sync_at = NOW(), updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
  }

  if (totalProcessed > 0) {
    console.log(
      `[Worker:email-sync] User ${userId}: synced ${totalProcessed} new ${f.direction} emails from ${f.folder}`
    );
  }
}

/**
 * Process a single inbound (Inbox) message from Graph delta. Thin wrapper — see processMailMessage.
 */
export async function processInboundMessage(
  client: any,
  schemaName: string,
  userId: string,
  officeId: string,
  msg: any
): Promise<boolean> {
  return processMailMessage(client, schemaName, userId, officeId, msg, "inbound");
}

/**
 * Process a single outbound (Sent Items) message from Graph delta. Thin wrapper — see processMailMessage.
 */
export async function processSentMessage(
  client: any,
  schemaName: string,
  userId: string,
  officeId: string,
  msg: any
): Promise<boolean> {
  return processMailMessage(client, schemaName, userId, officeId, msg, "outbound");
}

/**
 * Process a single message from a Graph delta page.
 *
 * Inbound (Inbox): matches the SENDER against CRM contacts; stores every message; fires inbound side
 * effects (email.received event, reply-task evaluation).
 *
 * Outbound (Sent Items): matches the RECIPIENTS (rep → client); SELECTIVE — stores only when a recipient
 * is a known contact or the thread is already bound, so sent-to-noise stays out of the assignment queue;
 * dedups on internet_message_id so a CRM-composed email isn't double-stored when its Sent-folder copy
 * (different graph id, same Message-ID) is synced; skips the inbound-only side effects.
 *
 * Returns true if the email was stored, false if skipped (dedup / not selective / conflict).
 */
export async function processMailMessage(
  client: any,
  schemaName: string,
  userId: string,
  officeId: string,
  msg: any,
  direction: "inbound" | "outbound"
): Promise<boolean> {
  const isOutbound = direction === "outbound";
  const graphMessageId = msg.id;
  if (!graphMessageId) return false;
  const internetMessageId: string | null = msg.internetMessageId ?? null;

  // Dedup 1 (both directions): graph_message_id is UNIQUE.
  const existing = await client.query(
    `SELECT id FROM ${schemaName}.emails WHERE graph_message_id = $1 LIMIT 1`,
    [graphMessageId]
  );
  if (existing.rows.length > 0) return false;

  // Dedup 2 (outbound only): the Sent-folder copy of a message the CRM already stored (a CRM-composed
  // send, or an earlier sync) carries a DIFFERENT graph id but the SAME internet_message_id. Skip it so
  // the outbound email is stored exactly once.
  //
  // Scope the match to THIS mailbox's own outbound rows (user_id + direction='outbound'). The RFC822
  // Message-ID is identical across a message's copies in DIFFERENT mailboxes — for an internal A→B email,
  // A's Sent copy and B's Inbox copy share it. A tenant-wide match would let B's inbound row swallow A's
  // outbound copy (data loss). The only collision we dedup is A's own CRM-composed row vs A's Sent copy.
  if (isOutbound && internetMessageId) {
    const existingByMid = await client.query(
      `SELECT id FROM ${schemaName}.emails
        WHERE internet_message_id = $1 AND user_id = $2 AND direction = 'outbound' LIMIT 1`,
      [internetMessageId, userId]
    );
    if (existingByMid.rows.length > 0) {
      // OPTION (b) fallback (default OFF): let the Sent-folder copy win the body field — only relevant
      // when a signature is appended server-side and the CRM's stored body predates it.
      if (SENT_COPY_WINS_BODY_ON_COLLISION) {
        await client.query(
          `UPDATE ${schemaName}.emails
              SET body_html = $1, body_preview = $2
            WHERE internet_message_id = $3 AND user_id = $4 AND direction = 'outbound'`,
          [msg.body?.content ?? "", (msg.bodyPreview ?? "").substring(0, 500), internetMessageId, userId]
        );
      }
      return false;
    }
  }

  // Extract addresses
  const fromAddress =
    msg.from?.emailAddress?.address?.toLowerCase() ?? "";
  const toAddresses: string[] = (msg.toRecipients ?? [])
    .map((r: any) => r.emailAddress?.address?.toLowerCase())
    .filter(Boolean);
  const ccAddresses: string[] = (msg.ccRecipients ?? [])
    .map((r: any) => r.emailAddress?.address?.toLowerCase())
    .filter(Boolean);
  const conversationId = msg.conversationId ?? null;
  const subject = msg.subject ?? "(No Subject)";
  const bodyPreview = (msg.bodyPreview ?? "").substring(0, 500);
  const bodyHtml = msg.body?.content ?? "";
  const hasAttachments = msg.hasAttachments ?? false;
  // Inbound is timestamped by receipt; outbound by send time (falling back to receivedDateTime, which
  // Sent Items rows also carry, since the delta $select uses it).
  const messageDate = isOutbound ? (msg.sentDateTime ?? msg.receivedDateTime) : msg.receivedDateTime;
  const sentAt = messageDate ? new Date(messageDate) : new Date();
  const mailboxAccountId = await resolveMailboxAccountIdForSyncedUser(client, userId);
  const normalizedSubject = normalizeEmailSubject(subject);
  const participantFingerprint = buildParticipantFingerprint(toAddresses, ccAddresses);

  // First-Sent-scan transition: a CRM-composed send made BEFORE this feature has internet_message_id = NULL
  // (it was never captured), so its Sent-folder copy won't match the dedup above and would double-store.
  // Adopt: if a legacy outbound row (NULL imid, same mailbox + conversation + subject) exists, stamp this
  // message's Message-ID onto it and skip the insert. Self-limiting — once every pre-feature send is
  // adopted, no NULL-imid outbound rows remain and this never fires again.
  if (isOutbound && internetMessageId && conversationId) {
    // Match conversation + subject + RECIPIENTS + a tight send-time window. The recipients and the ±1-day
    // window stop a NEW Outlook message from stamping its Message-ID onto an OLD CRM row that merely shares
    // a conversation+subject (which would drop the real Sent item and break later dedup). A genuine
    // CRM-composed row and its Sent-folder copy ARE the same message — same recipients, same send time —
    // so the real adoption still matches.
    const legacy = await client.query(
      `SELECT id FROM ${schemaName}.emails
        WHERE user_id = $1 AND direction = 'outbound' AND internet_message_id IS NULL
          AND graph_conversation_id = $2 AND subject = $3
          -- case-insensitive recipient overlap (worker lowercases to/cc; sendEmail stores as-composed)
          AND EXISTS (SELECT 1 FROM unnest(to_addresses) addr WHERE lower(addr) = ANY($4::text[]))
          AND sent_at BETWEEN ($5::timestamptz - interval '1 day') AND ($5::timestamptz + interval '1 day')
        ORDER BY sent_at DESC LIMIT 1`,
      [userId, conversationId, subject, toAddresses, sentAt]
    );
    if (legacy.rows.length > 0) {
      await client.query(
        `UPDATE ${schemaName}.emails SET internet_message_id = $1 WHERE id = $2`,
        [internetMessageId, legacy.rows[0].id]
      );
      return false;
    }
  }

  // Participant match differs by direction:
  //   inbound  — the SENDER is the external party → match from_address against contacts.
  //   outbound — the rep is the sender → match the RECIPIENTS (to/cc) against contacts.
  const matchAddresses = isOutbound
    ? [...toAddresses, ...ccAddresses]
    : fromAddress
      ? [fromAddress]
      : [];
  const [contactMatch, activeThreadBinding, provisionalThreadBinding, assignmentModule] = await Promise.all([
    findContactByEmailRaw(client, schemaName, matchAddresses),
    getActiveThreadBindingRaw(client, schemaName, mailboxAccountId, conversationId),
    getProvisionalThreadBindingRaw(client, schemaName, mailboxAccountId, normalizedSubject, participantFingerprint),
    import(SERVER_EMAIL_ASSIGNMENT_MODULE),
  ]);
  const contactContext = contactMatch
    ? await getContactAssignmentContextRaw(client, schemaName, contactMatch.id)
    : {
        companyId: null,
        companyName: null,
        estimatingStageDisplayOrder: null,
        dealCandidates: [],
        leadCandidates: [],
      };
  const authoritativeBinding = activeThreadBinding ?? provisionalThreadBinding;

  // SELECTIVE SENT-SYNC: inbound stores every Inbox message, but a rep's Sent Items also holds mail to
  // no-reply/newsletter/internal addresses. Store an outbound email only when it ties to a known CRM
  // record — a matched recipient contact OR an already-bound thread — so the shared assignment queue
  // surfaces real sent-to-contact mail, not noise. (Inbound is unaffected.)
  if (isOutbound && !contactMatch && !authoritativeBinding) {
    return false;
  }

  const assignment = authoritativeBinding
    ? {
        assignedEntityType: "deal",
        assignedEntityId: authoritativeBinding.deal_id,
        assignedDealId: authoritativeBinding.deal_id,
        confidence: "high",
        ambiguityReason: null,
        matchedBy: "prior_thread_assignment",
        requiresClassificationTask: false,
        candidateDealIds: authoritativeBinding.deal_id ? [authoritativeBinding.deal_id] : [],
      }
    : assignmentModule.resolveEmailAssignment({
        subject,
        bodyPreview,
        bodyHtml,
        priorThreadAssignment: null,
        contactCompanyId: contactContext.companyId,
        dealCandidates: contactContext.dealCandidates,
        leadCandidates: contactContext.leadCandidates,
        propertyCandidates: assignmentModule.buildPropertyCandidatesFromDeals(contactContext.dealCandidates),
      });

  const promotedBinding =
    provisionalThreadBinding && conversationId
      ? await promoteProvisionalBindingRaw(client, schemaName, provisionalThreadBinding.id, conversationId)
      : null;
  let bindingId = promotedBinding?.id ?? activeThreadBinding?.id ?? provisionalThreadBinding?.id ?? null;

  // Seed a thread binding when an ASSIGNED outbound send is the first CRM-seen message in its conversation.
  // The CRM sendEmail path seeds one (seedOutboundThreadBinding); the Sent-folder sync must too — otherwise
  // a later Inbox reply on this conversationId finds no binding and falls back to ambiguous/no assignment.
  // We have the real conversationId here, so seed a CONCRETE (non-provisional) binding keyed on it; the
  // partial-unique ON CONFLICT absorbs a race with the CRM seed.
  if (isOutbound && assignment.assignedDealId && conversationId && !bindingId) {
    const seeded = await client.query(
      `INSERT INTO ${schemaName}.email_thread_bindings
         (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence,
          assignment_reason, created_by, updated_by)
       VALUES ($1, 'microsoft_graph', $2, $3, 'outbound_sync_seed', 'high', 'outbound_sent_sync', $4, $4)
       ON CONFLICT (mailbox_account_id, provider, provider_conversation_id)
         WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [mailboxAccountId, conversationId, assignment.assignedDealId, userId]
    );
    bindingId = seeded.rows[0]?.id ?? bindingId;
  }

  // Persist assignment_status from the RESOLVED assignment rather than letting it default to 'unassigned'.
  // The reused insert would otherwise leave an auto-assigned email (deal/entity resolved) looking
  // unassigned in status views — undercutting the auto-assign the sync just did. (deriveAssignmentStatus
  // parity: assigned when a deal or entity is attached.)
  const assignmentStatus =
    assignment.assignedDealId || assignment.assignedEntityId ? "assigned" : "unassigned";

  const [insertResult] = [await client.query(
    `INSERT INTO ${schemaName}.emails
     (graph_message_id, internet_message_id, graph_conversation_id, direction, from_address, to_addresses, cc_addresses,
      subject, body_preview, body_html, has_attachments, contact_id, deal_id,
      assigned_entity_type, assigned_entity_id, assignment_confidence, assignment_ambiguity_reason,
      thread_binding_id, user_id, sent_at, assignment_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      graphMessageId,
      internetMessageId,
      conversationId,
      direction,
      fromAddress,
      toAddresses,
      ccAddresses,
      subject,
      bodyPreview,
      bodyHtml,
      hasAttachments,
      contactMatch?.id ?? null,
      assignment.assignedDealId ?? null,
      assignment.assignedEntityType ?? null,
      assignment.assignedEntityId ?? null,
      assignment.confidence,
      assignment.ambiguityReason ?? null,
      bindingId,
      userId,
      sentAt,
      assignmentStatus,
    ]
  )];

  if (insertResult.rows.length === 0) return false; // Conflict — already existed

  const emailId = insertResult.rows[0].id;

  // Auto-associate to deal (determine dealId BEFORE creating activity/task)
  const association = {
    dealId: assignment.assignedDealId ?? null,
    activeDealCount: contactContext.dealCandidates.length,
    activeDealNames: contactContext.dealCandidates.map((d) => `${d.dealNumber} ${d.name}`.trim()),
  };

  // Create activity record AFTER deal association so deal_id is included in the INSERT
  // (no separate UPDATE needed)
  const activitySourceEntityType =
    association.dealId
      ? "deal"
      : assignment.assignedEntityType === "company" && assignment.assignedEntityId
        ? "company"
        : contactMatch?.id
          ? "contact"
          : null;
  const activitySourceEntityId =
    association.dealId
      ?? assignment.assignedEntityId
      ?? contactMatch?.id
      ?? null;
  const responsibleUserId = userId;
  // Outbound = the rep performed the send → set performed_by_user_id so the deal shows in their "mine"
  // (mine-visibility filters on performed_by_user_id = userId, like CRM sendEmail). Inbound was received,
  // not performed, so it stays NULL.
  const performedByUserId = isOutbound ? userId : null;
  if (activitySourceEntityType && activitySourceEntityId) {
    await client.query(
      `INSERT INTO ${schemaName}.activities
       (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id,
        deal_id, contact_id, email_id, subject, body, occurred_at)
       VALUES ('email', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        responsibleUserId,
        performedByUserId,
        activitySourceEntityType,
        activitySourceEntityId,
        association.dealId, // may be null if 0 or multiple deals
        contactMatch?.id ?? null,
        emailId,
        subject,
        bodyPreview.substring(0, 1000),
        sentAt,
      ]
    );
  }

  // Refresh the auto-associated deal's email counters (email_count / last_email_at) so they're not stale —
  // the CRM sendEmail + manual-association paths do this; the sync must too. Mirrors the deal branch of
  // server stats-service.refreshEntityEmailStats, qualified to the office schema (the worker runs outside a
  // search_path). Deal is the stat target a sent/received email auto-associates to; company/lead cascades
  // stay with the server's full refresh on the CRM paths.
  if (association.dealId) {
    await refreshDealEmailStatsRaw(client, schemaName, association.dealId);
  }

  // createClassificationTaskRaw hardcodes an INBOUND-flavored task (type='inbound_email',
  // source_event='email.received'), so it must not fire for outbound. The outbound email still surfaces
  // in the assignment queue via its assignment_ambiguity_reason on the row (set in the INSERT above) —
  // the task is a separate, inbound-only nudge.
  if (!isOutbound && assignment.requiresClassificationTask) {
    await createClassificationTaskRaw(client, schemaName, {
      officeId,
      emailId,
      userId,
      contactId: contactMatch?.id ?? null,
      subject,
      contactName: contactMatch ? `${contactMatch.first_name} ${contactMatch.last_name}`.trim() : fromAddress,
      companyName: contactContext.companyName,
      ambiguityReason: assignment.ambiguityReason ?? "assignment_review",
      candidateDealNames: association.activeDealNames,
    });
  } else if (!isOutbound && association.dealId) {
    // Reply-task evaluation ("a client replied → maybe a follow-up task") is an INBOUND concern only.
    await evaluateInboundEmailTasks(
      client,
      schemaName,
      {
        now: new Date(),
        officeId,
        entityId: `email:${emailId}`,
        sourceEvent: "email.received",
        dealId: association.dealId,
        contactId: contactMatch?.id ?? null,
        emailId,
        taskAssigneeId: userId,
        contactName: contactMatch
          ? `${contactMatch.first_name} ${contactMatch.last_name}`.trim()
          : (fromAddress ?? "Unknown sender"),
        emailSubject: subject,
        activeDealCount: association.activeDealCount,
        activeDealNames: association.activeDealNames,
        unreadInbound: 30,
      }
    );
  }

  // Emit email.received event via job_queue — INBOUND only; a sent email is not a "received" event.
  if (!isOutbound) {
    await client.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
       VALUES ('domain_event', $1, $2, 'pending', NOW())`,
      [
        JSON.stringify({
          eventName: "email.received",
          emailId,
          contactId: contactMatch?.id ?? null,
          contactName: contactMatch ? `${contactMatch.first_name} ${contactMatch.last_name}` : fromAddress,
          fromAddress,
          subject,
          userId,
        }),
        officeId, // pass actual office so notification handler resolves correct tenant
      ]
    );
  }

  await client.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
     VALUES ('ai_index_document', $1, $2, 'pending', NOW())`,
    [
      JSON.stringify({
        sourceType: "email_message",
        sourceId: emailId,
      }),
      officeId,
    ]
  );

  return true;
}

/**
 * Refresh a deal's email_count / last_email_at after an email is stored against it (worker context).
 * Qualified to the office schema; mirrors the deal branch of server stats-service.refreshEntityEmailStats
 * (same `assignment_status <> 'ignored'` filter and deal/lead source-lead matching) so the worker-synced
 * counters agree with the CRM-composed and manual-association paths.
 */
async function refreshDealEmailStatsRaw(
  client: any,
  schemaName: string,
  dealId: string
): Promise<void> {
  await client.query(
    `UPDATE ${schemaName}.deals AS d
        SET email_count = (
              SELECT COUNT(e.id)::int FROM ${schemaName}.emails e
               WHERE e.assignment_status <> 'ignored'
                 AND ((e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
                   OR e.deal_id = d.id
                   OR (d.source_lead_id IS NOT NULL AND e.assigned_entity_type = 'lead' AND e.assigned_entity_id = d.source_lead_id))
            ),
            last_email_at = (
              SELECT MAX(e.sent_at) FROM ${schemaName}.emails e
               WHERE e.assignment_status <> 'ignored'
                 AND ((e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
                   OR e.deal_id = d.id
                   OR (d.source_lead_id IS NOT NULL AND e.assigned_entity_type = 'lead' AND e.assigned_entity_id = d.source_lead_id))
            )
      WHERE d.id = $1`,
    [dealId]
  );
}

/**
 * Find a CRM contact by email address using raw SQL (worker context).
 */
async function findContactByEmailRaw(
  client: any,
  schemaName: string,
  emailAddresses: string[]
): Promise<{ id: string; first_name: string; last_name: string; company_id: string | null } | null> {
  if (emailAddresses.length === 0) return null;

  // Build parameterized IN clause. Deterministic pick: outbound passes multiple recipients (To then Cc),
  // so order the match by the address's position in the input list — the first/highest-priority recipient
  // wins instead of an arbitrary LIMIT 1. (Inbound passes a single address, so this is a no-op there.)
  const lowered = emailAddresses.map((e) => e.toLowerCase());
  const placeholders = lowered.map((_, i) => `$${i + 1}`).join(", ");
  const orderParam = `$${lowered.length + 1}`;
  const result = await client.query(
    `SELECT id, first_name, last_name, company_id FROM ${schemaName}.contacts
     WHERE LOWER(email) IN (${placeholders}) AND is_active = true
     ORDER BY array_position(${orderParam}::text[], LOWER(email))
     LIMIT 1`,
    [...lowered, lowered]
  );

  return result.rows[0] ?? null;
}

async function getContactAssignmentContextRaw(
  client: any,
  schemaName: string,
  contactId: string
): Promise<{
  companyId: string | null;
  companyName: string | null;
  estimatingStageDisplayOrder: number | null;
  dealCandidates: Array<{
    id: string;
    dealNumber: string;
    name: string;
    companyId: string | null;
    stageSlug: string | null;
    stageDisplayOrder: number | null;
    propertyAddress: string | null;
    propertyCity: string | null;
    propertyState: string | null;
    propertyZip: string | null;
  }>;
  leadCandidates: Array<{
    id: string;
    leadNumber: string;
    name: string;
    companyId: string | null;
    relatedDealId: string | null;
    stageSlug: string | null;
    stageDisplayOrder: number | null;
    propertyAddress: string | null;
    propertyCity: string | null;
    propertyState: string | null;
    propertyZip: string | null;
  }>;
}> {
  const estimatingStageResult = await client.query(
    `SELECT MIN(display_order) AS display_order
       FROM public.pipeline_stage_config
      WHERE slug IN ('estimate_in_progress', 'service_estimating')`
  );
  const estimatingStageDisplayOrder = estimatingStageResult.rows[0]?.display_order ?? 2;

  const [contactRow] = await client.query(
    `SELECT company_id, company_name
       FROM ${schemaName}.contacts
      WHERE id = $1
      LIMIT 1`,
    [contactId]
  ).then((result: any) => result.rows ?? []);

  const companyId = contactRow?.company_id ?? null;
  const companyName = contactRow?.company_name ?? null;

  const contactDealsResult = await client.query(
    `SELECT d.id, d.deal_number, d.name, d.company_id,
            ps.slug AS stage_slug, ps.display_order AS stage_display_order,
            d.property_address, d.property_city, d.property_state, d.property_zip
       FROM ${schemaName}.deals d
       JOIN ${schemaName}.contact_deal_associations cda ON cda.deal_id = d.id
       JOIN public.pipeline_stage_config ps ON ps.id = d.stage_id
      WHERE cda.contact_id = $1 AND d.is_active = true`,
    [contactId]
  );

  const companyDealsResult = companyId
    ? await client.query(
        `SELECT d.id, d.deal_number, d.name, d.company_id,
                ps.slug AS stage_slug, ps.display_order AS stage_display_order,
                d.property_address, d.property_city, d.property_state, d.property_zip
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config ps ON ps.id = d.stage_id
          WHERE d.company_id = $1 AND d.is_active = true`,
        [companyId]
      )
    : { rows: [] };

  const dealCandidates = [...contactDealsResult.rows, ...companyDealsResult.rows]
    .map((deal: any) => ({
      id: deal.id,
      dealNumber: deal.deal_number,
      name: deal.name,
      companyId: deal.company_id ?? null,
      stageSlug: deal.stage_slug ?? null,
      stageDisplayOrder: deal.stage_display_order ?? null,
      propertyAddress: deal.property_address ?? null,
      propertyCity: deal.property_city ?? null,
      propertyState: deal.property_state ?? null,
      propertyZip: deal.property_zip ?? null,
    }))
    .filter((deal, index, arr) => arr.findIndex((candidate) => candidate.id === deal.id) === index);

  const leadCandidates = dealCandidates
    .filter((deal) => deal.stageDisplayOrder != null && deal.stageDisplayOrder < estimatingStageDisplayOrder)
    .map((deal) => ({
      id: deal.id,
      leadNumber: deal.dealNumber,
      name: deal.name,
      companyId: deal.companyId,
      relatedDealId: deal.id,
      stageSlug: deal.stageSlug,
      stageDisplayOrder: deal.stageDisplayOrder,
      propertyAddress: deal.propertyAddress,
      propertyCity: deal.propertyCity,
      propertyState: deal.propertyState,
      propertyZip: deal.propertyZip,
    }));

  return { companyId, companyName, estimatingStageDisplayOrder, dealCandidates, leadCandidates };
}

function normalizeEmailSubject(subject: string): string {
  return subject.replace(/^(re|fw|fwd):\s*/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildParticipantFingerprint(toAddresses: string[], ccAddresses: string[]): string {
  return [...toAddresses, ...ccAddresses].map((value) => value.trim().toLowerCase()).filter(Boolean).sort().join("|");
}

async function resolveMailboxAccountIdForSyncedUser(
  client: any,
  syncedUserId: string
): Promise<string> {
  const result = await client.query(
    `SELECT id FROM public.user_graph_tokens WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [syncedUserId]
  );
  if (result.rows.length === 0) {
    throw new Error(`No active mailbox connected for user ${syncedUserId}`);
  }
  return result.rows[0].id;
}

async function getActiveThreadBindingRaw(
  client: any,
  schemaName: string,
  mailboxAccountId: string,
  conversationId: string | null
): Promise<{ id: string; deal_id: string | null } | null> {
  if (!conversationId) return null;
  const result = await client.query(
    `SELECT id, deal_id
       FROM ${schemaName}.email_thread_bindings
      WHERE mailbox_account_id = $1
        AND provider = 'microsoft_graph'
        AND provider_conversation_id = $2
        AND detached_at IS NULL
      LIMIT 1`,
    [mailboxAccountId, conversationId]
  );
  return result.rows[0] ?? null;
}

async function getProvisionalThreadBindingRaw(
  client: any,
  schemaName: string,
  mailboxAccountId: string,
  normalizedSubject: string,
  participantFingerprint: string
): Promise<{ id: string; deal_id: string | null } | null> {
  const result = await client.query(
    `SELECT id, deal_id
       FROM ${schemaName}.email_thread_bindings
      WHERE mailbox_account_id = $1
        AND provider = 'microsoft_graph'
        AND provider_conversation_id IS NULL
        AND normalized_subject = $2
        AND participant_fingerprint = $3
        AND detached_at IS NULL
        AND provisional_until IS NOT NULL
        AND provisional_until > NOW()
      LIMIT 1`,
    [mailboxAccountId, normalizedSubject, participantFingerprint]
  );
  return result.rows[0] ?? null;
}

async function promoteProvisionalBindingRaw(
  client: any,
  schemaName: string,
  bindingId: string,
  conversationId: string
): Promise<{ id: string; deal_id: string | null } | null> {
  const result = await client.query(
    `UPDATE ${schemaName}.email_thread_bindings
        SET provider_conversation_id = $2,
            provisional_until = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, deal_id`,
    [bindingId, conversationId]
  );
  return result.rows[0] ?? null;
}

async function createClassificationTaskRaw(
  client: any,
  schemaName: string,
  input: {
    officeId: string;
    emailId: string;
    userId: string;
    contactId: string | null;
    subject: string;
    contactName: string;
    companyName: string | null;
    ambiguityReason: string;
    candidateDealNames: string[];
  }
): Promise<void> {
  await withTenantAuditContext(client, schemaName, input.userId, async () => {
    const dedupeKey = `email:${input.emailId}:assignment_review`;
    const existing = await client.query(
      `SELECT id
         FROM ${schemaName}.tasks
        WHERE origin_rule = 'email_assignment_queue'
          AND dedupe_key = $1
          AND status IN ('pending', 'scheduled', 'in_progress', 'waiting_on', 'blocked')
        LIMIT 1`,
      [dedupeKey]
    );
    if (existing.rows.length > 0) return;

    const title = `Classify email: ${input.subject}`;
    const dealNames =
      input.candidateDealNames.length > 0 ? input.candidateDealNames.join(", ") : "No clear deal candidate";
    await client.query(
      `INSERT INTO ${schemaName}.tasks
         (title, description, type, priority, status, assigned_to, created_by, office_id, origin_rule, source_rule, source_event, dedupe_key, reason_code, entity_snapshot, deal_id, contact_id, email_id, due_date, due_time, remind_at)
       VALUES ($1, $2, 'inbound_email', 'normal', 'pending', $3, $4, $5, 'email_assignment_queue', 'email_assignment_queue', 'email.received', $6, $7, $8, NULL, $9, $10, NULL, NULL, NULL)`,
      [
        title,
        `Review email assignment for ${input.contactName}${input.companyName ? ` at ${input.companyName}` : ""}. Candidate deals: ${dealNames}.`,
        input.userId,
        input.userId,
        input.officeId,
        dedupeKey,
        input.ambiguityReason,
        JSON.stringify({
          schemaVersion: 1,
          entityType: "email",
          entityId: `email:${input.emailId}`,
          officeId: input.officeId,
          contactId: input.contactId,
          emailId: input.emailId,
          contactName: input.contactName,
          companyName: input.companyName,
          ambiguityReason: input.ambiguityReason,
          candidateDealNames: input.candidateDealNames,
        }),
        input.contactId,
        input.emailId,
      ]
    );
  });
}

async function evaluateInboundEmailTasks(
  client: any,
  schemaName: string,
  context: {
    now: Date;
    officeId: string;
    entityId: string;
    sourceEvent: "email.received";
    dealId: string | null;
    contactId: string | null;
    emailId: string;
    taskAssigneeId: string;
    contactName: string;
    emailSubject: string;
    activeDealCount: number;
    activeDealNames: string[];
    unreadInbound: number;
  }
): Promise<void> {
  await withTenantAuditContext(client, schemaName, context.taskAssigneeId, async () => {
    const [{ evaluateTaskRules }, { TASK_RULES }, { createTenantTaskRulePersistence }] = (await Promise.all([
      import(SERVER_EVALUATOR_MODULE),
      import(SERVER_TASK_RULES_MODULE),
      import(SERVER_TASK_PERSISTENCE_MODULE),
    ])) as any;

    const taskPersistence = createTenantTaskRulePersistence(client, schemaName);
    await evaluateTaskRules(context, taskPersistence, TASK_RULES);
  });
}

async function setTenantAuditContext(client: any, schemaName: string, userId: string | null): Promise<void> {
  await client.query("SELECT set_config('search_path', $1, false)", [`${schemaName},public`]);
  await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId ?? ""]);
}

async function resetTenantAuditContext(client: any): Promise<void> {
  await client.query("SELECT set_config('search_path', $1, false)", ["public"]);
  await client.query("SELECT set_config('app.current_user_id', $1, false)", [""]);
}

async function withTenantAuditContext<T>(
  client: any,
  schemaName: string,
  userId: string | null,
  fn: () => Promise<T>
): Promise<T> {
  await setTenantAuditContext(client, schemaName, userId);
  try {
    return await fn();
  } finally {
    await resetTenantAuditContext(client);
  }
}
