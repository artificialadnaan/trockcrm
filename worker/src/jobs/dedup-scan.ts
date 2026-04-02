import { pool } from "../db.js";

/**
 * Background fuzzy deduplication scanner.
 *
 * Runs weekly across all office schemas. For each office:
 * 1. Load all active contacts
 * 2. Compare pairs using:
 *    a. Levenshtein distance on normalized names (lower(first_name || ' ' || last_name))
 *    b. Digit-sequence matching on normalized_phone
 *    c. Case-insensitive company_name comparison
 * 3. Score each pair (0.00-1.00)
 * 4. Insert into duplicate_queue if score > 0.7 and pair not already queued
 *
 * Uses raw SQL for performance -- this is a batch operation, not a request handler.
 * Levenshtein is computed in pure JS (no PG fuzzystrmatch extension needed).
 */
export async function runDedupScan(): Promise<void> {
  console.log("[Worker:dedup-scan] Starting contact dedup scan...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalDuplicates = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:dedup-scan] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Load all active contacts with dedup-relevant fields
      const contactsResult = await client.query(
        `SELECT
           id,
           LOWER(TRIM(first_name || ' ' || last_name)) AS normalized_name,
           LOWER(TRIM(COALESCE(company_name, ''))) AS norm_company,
           normalized_phone,
           LOWER(TRIM(COALESCE(email, ''))) AS norm_email
         FROM ${schemaName}.contacts
         WHERE is_active = true`
      );

      const contactList = contactsResult.rows;
      if (contactList.length < 2) continue;

      console.log(`[Worker:dedup-scan] Scanning ${contactList.length} contacts in office ${office.slug}`);

      let officeDuplicates = 0;

      // Compare all pairs. For large contact lists (>1000), this should be
      // optimized with blocking (group by first letter of last name), but
      // for T Rock's scale (~200-500 contacts per office) O(n^2) is fine.
      for (let i = 0; i < contactList.length; i++) {
        for (let j = i + 1; j < contactList.length; j++) {
          const a = contactList[i];
          const b = contactList[j];

          const score = calculateDuplicateScore(a, b);

          if (score.total < 0.7) continue;

          // Canonical ordering: always store smaller UUID as contact_a_id to
          // prevent duplicate pairs inserted in opposite directions.
          const [canonicalA, canonicalB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

          // Insert into duplicate queue -- ON CONFLICT DO NOTHING as a safety net
          // The unique constraint on (contact_a_id, contact_b_id) prevents duplicates.
          await client.query(
            `INSERT INTO ${schemaName}.duplicate_queue
             (contact_a_id, contact_b_id, match_type, confidence_score, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT DO NOTHING`,
            [canonicalA, canonicalB, score.matchType, score.total.toFixed(2)]
          );

          officeDuplicates++;
        }
      }

      if (officeDuplicates > 0) {
        console.log(`[Worker:dedup-scan] Found ${officeDuplicates} new duplicate pairs in office ${office.slug}`);
      }
      totalDuplicates += officeDuplicates;
    }

    console.log(`[Worker:dedup-scan] Scan complete. Total new duplicate pairs: ${totalDuplicates}`);
  } catch (err) {
    console.error("[Worker:dedup-scan] Scan failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

interface DuplicateScore {
  total: number;
  matchType: "exact_email" | "fuzzy_name" | "fuzzy_phone" | "company_match";
}

/**
 * Calculate a duplicate confidence score between two contacts.
 *
 * Scoring weights:
 * - Exact email match: 1.0 (automatic)
 * - Name similarity (Levenshtein-based): 0-0.4 weight (40%)
 * - Phone digit match: 0-0.3 weight (30%)
 * - Company match: 0-0.3 weight (30%)
 *
 * Returns the highest-confidence match type and total score.
 */
function calculateDuplicateScore(
  a: { normalized_name: string; norm_company: string; normalized_phone: string | null; norm_email: string },
  b: { normalized_name: string; norm_company: string; normalized_phone: string | null; norm_email: string }
): DuplicateScore {
  // Exact email match -- automatic 1.0
  if (a.norm_email && b.norm_email && a.norm_email === b.norm_email && a.norm_email.length > 0) {
    return { total: 1.0, matchType: "exact_email" };
  }

  let nameScore = 0;
  let phoneScore = 0;
  let companyScore = 0;

  // Name similarity using Levenshtein distance (computed in JS)
  // Max distance is the length of the longer string
  if (a.normalized_name && b.normalized_name) {
    const distance = levenshtein(a.normalized_name, b.normalized_name);
    const maxLen = Math.max(a.normalized_name.length, b.normalized_name.length);
    if (maxLen > 0) {
      const similarity = 1 - distance / maxLen;
      nameScore = similarity * 0.4; // Weight: 40%
    }
  }

  // Phone digit matching
  if (a.normalized_phone && b.normalized_phone && a.normalized_phone.length >= 7 && b.normalized_phone.length >= 7) {
    if (a.normalized_phone === b.normalized_phone) {
      phoneScore = 0.3; // Weight: 30%
    } else {
      // Check last 7 digits (local number without area code)
      const aLast7 = a.normalized_phone.slice(-7);
      const bLast7 = b.normalized_phone.slice(-7);
      if (aLast7 === bLast7) {
        phoneScore = 0.2;
      }
    }
  }

  // Company name match
  if (a.norm_company && b.norm_company && a.norm_company.length > 0 && b.norm_company.length > 0) {
    if (a.norm_company === b.norm_company) {
      companyScore = 0.3; // Weight: 30%
    }
  }

  const total = nameScore + phoneScore + companyScore;

  // Determine primary match type
  let matchType: DuplicateScore["matchType"] = "fuzzy_name";
  if (phoneScore >= nameScore && phoneScore > 0) matchType = "fuzzy_phone";
  if (companyScore > 0 && nameScore > 0.3) matchType = "company_match";
  if (nameScore >= 0.35) matchType = "fuzzy_name";

  return { total, matchType };
}

/**
 * Levenshtein distance between two strings.
 * Standard dynamic programming implementation with single-row optimization.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization to reduce memory from O(m*n) to O(n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
