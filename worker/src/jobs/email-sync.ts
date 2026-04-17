import { pool } from "../db.js";
import crypto from "crypto";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const SERVER_EMAIL_ASSIGNMENT_MODULE = "../../../server/src/modules/email/assignment-service.js" as string;
const SERVER_EVALUATOR_MODULE = "../../../server/src/modules/tasks/rules/evaluator.js" as string;
const SERVER_TASK_RULES_MODULE = "../../../server/src/modules/tasks/rules/config.js" as string;
const SERVER_TASK_PERSISTENCE_MODULE = "../../../server/src/modules/tasks/rules/persistence.js" as string;

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

        // Fix 4: Wrap in BEGIN/COMMIT so the advisory xact lock persists for the full sync
        await client.query("BEGIN");

        // Acquire per-user advisory lock to prevent concurrent syncs for the same user
        const lockResult = await client.query(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
          [tokenRow.user_id]
        );
        if (!lockResult.rows[0]?.acquired) {
          await client.query("COMMIT");
          console.log(
            `[Worker:email-sync] Skipping user ${tokenRow.user_id} — sync already in progress`
          );
          continue;
        }

        // Fix 5: Refresh token if expired before attempting sync
        const expiresAt = new Date(tokenRow.token_expires_at);
        const bufferMs = 5 * 60 * 1000; // refresh if within 5 minutes of expiry
        if (expiresAt.getTime() - Date.now() < bufferMs) {
          const refreshedToken = await refreshTokenForWorker(client, tokenRow);
          if (!refreshedToken) {
            await client.query("COMMIT");
            continue; // reauth marked inside refreshTokenForWorker
          }
          tokenRow.access_token = refreshedToken;
        }

        await syncUserEmails(client, tokenRow);
        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK").catch(() => {});
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
          );
        }
      }
    }

    console.log("[Worker:email-sync] Sync complete");
  } finally {
    client.release();
  }
}

async function syncUserEmails(poolClient: any, tokenRow: any): Promise<void> {
  const { user_id, access_token, last_delta_link, office_id } = tokenRow;

  // Decrypt access token (stored encrypted at rest)
  const currentAccessToken = decrypt(access_token);

  // Determine delta URL
  // First sync: use messages endpoint with select fields (last 7 days)
  // Subsequent syncs: use the stored delta link
  let deltaUrl: string;
  if (last_delta_link) {
    deltaUrl = last_delta_link;
  } else {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    deltaUrl = `/me/mailFolders/inbox/messages/delta?$select=id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,hasAttachments,receivedDateTime&$filter=receivedDateTime ge ${sevenDaysAgo}`;
  }

  // Resolve the office schema for this user
  const officeResult = await poolClient.query(
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

  // Fetch messages page by page via delta
  let nextLink: string | null = deltaUrl;
  let newDeltaLink: string | null = null;
  let totalProcessed = 0;

  while (nextLink) {
    const result: GraphFetchResult<any> = await graphFetch(currentAccessToken, nextLink);

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

      const processed = await processInboundMessage(
        poolClient,
        schemaName,
        user_id,
        office_id,
        msg
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

  // Update the delta link and last sync time
  if (newDeltaLink) {
    await poolClient.query(
      `UPDATE public.user_graph_tokens
       SET last_delta_link = $1, last_sync_at = NOW(), updated_at = NOW()
       WHERE user_id = $2`,
      [newDeltaLink, user_id]
    );
  } else {
    await poolClient.query(
      `UPDATE public.user_graph_tokens SET last_sync_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [user_id]
    );
  }

  if (totalProcessed > 0) {
    console.log(
      `[Worker:email-sync] User ${user_id}: synced ${totalProcessed} new emails`
    );
  }
}

/**
 * Process a single inbound message from Graph delta.
 * Returns true if the email was stored (matched a contact), false if skipped.
 */
export async function processInboundMessage(
  client: any,
  schemaName: string,
  userId: string,
  officeId: string,
  msg: any
): Promise<boolean> {
  const graphMessageId = msg.id;
  if (!graphMessageId) return false;

  // Dedup check: graph_message_id is UNIQUE
  const existing = await client.query(
    `SELECT id FROM ${schemaName}.emails WHERE graph_message_id = $1 LIMIT 1`,
    [graphMessageId]
  );
  if (existing.rows.length > 0) return false;

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
  const sentAt = msg.receivedDateTime
    ? new Date(msg.receivedDateTime)
    : new Date();
  const mailboxAccountId = await resolveMailboxAccountIdForSyncedUser(client, userId);
  const normalizedSubject = normalizeEmailSubject(subject);
  const participantFingerprint = buildParticipantFingerprint(toAddresses, ccAddresses);

  // Selective sync: for inbound emails, match ONLY the sender (from_address)
  // against CRM contacts — not to/cc which are internal mailbox addresses.
  const matchAddresses = fromAddress ? [fromAddress] : [];
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
  const bindingId = promotedBinding?.id ?? activeThreadBinding?.id ?? provisionalThreadBinding?.id ?? null;

  const [insertResult] = [await client.query(
    `INSERT INTO ${schemaName}.emails
     (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, cc_addresses,
      subject, body_preview, body_html, has_attachments, contact_id, deal_id,
      assigned_entity_type, assigned_entity_id, assignment_confidence, assignment_ambiguity_reason,
      thread_binding_id, user_id, sent_at)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (graph_message_id) DO NOTHING
     RETURNING id`,
    [
      graphMessageId,
      conversationId,
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
          : "mailbox";
  const activitySourceEntityId =
    association.dealId
      ?? assignment.assignedEntityId
      ?? contactMatch?.id
      ?? mailboxAccountId;
  const responsibleUserId = userId;
  await client.query(
    `INSERT INTO ${schemaName}.activities
     (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id,
      deal_id, contact_id, email_id, subject, body, occurred_at)
     VALUES ('email', $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      responsibleUserId,
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

  if (assignment.requiresClassificationTask) {
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
  } else if (association.dealId && contactMatch) {
    await evaluateInboundEmailTasks(
      client,
      schemaName,
      {
        now: new Date(),
        officeId,
        entityId: `email:${emailId}`,
        sourceEvent: "email.received",
        dealId: association.dealId,
        contactId: contactMatch.id,
        emailId,
        taskAssigneeId: userId,
        contactName: `${contactMatch.first_name} ${contactMatch.last_name}`.trim(),
        emailSubject: subject,
        activeDealCount: association.activeDealCount,
        activeDealNames: association.activeDealNames,
        unreadInbound: 30,
      }
    );
  }

  // Emit email.received event via job_queue
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
 * Find a CRM contact by email address using raw SQL (worker context).
 */
async function findContactByEmailRaw(
  client: any,
  schemaName: string,
  emailAddresses: string[]
): Promise<{ id: string; first_name: string; last_name: string; company_id: string | null } | null> {
  if (emailAddresses.length === 0) return null;

  // Build parameterized IN clause
  const placeholders = emailAddresses.map((_, i) => `$${i + 1}`).join(", ");
  const result = await client.query(
    `SELECT id, first_name, last_name, company_id FROM ${schemaName}.contacts
     WHERE LOWER(email) IN (${placeholders}) AND is_active = true
     LIMIT 1`,
    emailAddresses.map((e) => e.toLowerCase())
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
    `SELECT display_order
       FROM public.pipeline_stage_config
      WHERE slug = 'estimating'
      LIMIT 1`
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
  const dealNames = input.candidateDealNames.length > 0 ? input.candidateDealNames.join(", ") : "No clear deal candidate";
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
    contactId: string;
    emailId: string;
    taskAssigneeId: string;
    contactName: string;
    emailSubject: string;
    activeDealCount: number;
    activeDealNames: string[];
    unreadInbound: number;
  }
): Promise<void> {
  const [{ evaluateTaskRules }, { TASK_RULES }, { createTenantTaskRulePersistence }] = (await Promise.all([
    import(SERVER_EVALUATOR_MODULE),
    import(SERVER_TASK_RULES_MODULE),
    import(SERVER_TASK_PERSISTENCE_MODULE),
  ])) as any;

  const taskPersistence = createTenantTaskRulePersistence(client, schemaName);
  await evaluateTaskRules(context, taskPersistence, TASK_RULES);
}
