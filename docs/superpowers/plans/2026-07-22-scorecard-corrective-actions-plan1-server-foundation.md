# Scorecard Corrective Actions — Plan 1: Server Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a field scorecard is submitted in the "Corrective Action Required" rating band, open a corrective-action stage and seed one tracked item per flagged issue; provide the service logic to resolve an item and auto-close the scorecard once all items are resolved.

**Architecture:** Pure server/data-layer backbone, no HTTP or UI. A new per-tenant `scorecard_corrective_actions` table (one row per action item + critical deficiency), two new `field_scorecards.status` values, and a nullable `corrective_action_id` on `field_scorecard_photos`. Submit-time trigger lives in the existing `createFieldScorecard` transaction; closure logic is a small pure-ish service. All proven with PGlite runtime tests (the repo's convention).

**Tech Stack:** TypeScript, Drizzle ORM, Postgres (per-office tenant schemas), PGlite for runtime tests, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md` (§4, §5, §8).

**Reference reading before starting:**
- `shared/src/schema/tenant/field-scorecards.ts` — the scorecard + items + photos tables.
- `shared/src/types/field-scorecard.ts` — rating bands, `resolveScorecardV2Rating`, `ScorecardRating`.
- `server/src/modules/field/scorecards-service.ts` — `createFieldScorecard` (computes rating, enqueues email job in the submit txn) — this is where the trigger hooks in.
- An existing per-tenant migration with a `-- TENANT_SCHEMA_START/END` block (e.g. the property cover-image migration 0186) — copy that shape so newly-provisioned offices inherit the new table.

---

### Task 1: Migration — new table, status values, photo FK

**Files:**
- Create: `migrations/0190_scorecard_corrective_actions.sql`
- Reference: an existing per-tenant migration with a `DO`-loop over `office_*` schemas AND a `-- TENANT_SCHEMA_START/END` block.

- [ ] **Step 1: Find the next migration number and confirm it's free**

Run: `ls migrations/ | grep -oE '^0[0-9]{3}' | sort -u | tail -3`
Expected: highest is `0189`; use `0190`. (If not, use the next free number and rename accordingly throughout.)

- [ ] **Step 2: Write the migration**

Create `migrations/0190_scorecard_corrective_actions.sql`. It must (a) run for every EXISTING `office_*` schema via a `DO`-loop, AND (b) include a `-- TENANT_SCHEMA_START/END` block so the office provisioner replays it for NEW offices. Per-tenant objects: the new table + its indexes + the `field_scorecard_photos.corrective_action_id` column. `field_scorecards.status` is a `varchar(20)` and MUST be widened to `varchar(30)` in BOTH the `DO`-loop and the TENANT_SCHEMA block (`ALTER TABLE ... ALTER COLUMN status TYPE varchar(30)`): the new values `corrective_action_open` (22 chars) and `corrective_action_closed` (24 chars) do not fit `varchar(20)`. The new values are enforced in app code + a widened CHECK if one exists (verify: `grep -n "status" migrations/*field_scorecard* 2>/dev/null` — `field_scorecards.status` has no CHECK constraint, so only the column length changes here; but if a CHECK on status ever exists, this migration must drop+recreate it to include the new values).

```sql
-- Migration 0190: corrective-action follow-up for below-band scorecards.
-- Per-tenant (office_* schemas). Seeds one scorecard_corrective_actions row per flagged item when a scorecard
-- trips the corrective-action band; the scorecard's status walks submitted -> corrective_action_open ->
-- corrective_action_closed. See docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md.

DO $$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office_%'
  LOOP
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %I.scorecard_corrective_actions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
        item_type text NOT NULL CHECK (item_type IN ('action_item', 'critical_deficiency')),
        item_ref text NOT NULL,
        item_label text NOT NULL,
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        response_comment text,
        responded_by_user_id uuid,
        responder_name text,
        responder_email text,
        responded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (scorecard_id, item_type, item_ref)
      );
      CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_scorecard_idx
        ON %I.scorecard_corrective_actions (scorecard_id);
      CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_open_idx
        ON %I.scorecard_corrective_actions (scorecard_id) WHERE status = 'open';
      ALTER TABLE %I.field_scorecard_photos
        ADD COLUMN IF NOT EXISTS corrective_action_id uuid
        REFERENCES %I.scorecard_corrective_actions(id) ON DELETE SET NULL;
    $ddl$, schema_name, schema_name, schema_name, schema_name, schema_name, schema_name);
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS "{{schema}}".scorecard_corrective_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES "{{schema}}".field_scorecards(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('action_item', 'critical_deficiency')),
  item_ref text NOT NULL,
  item_label text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  response_comment text,
  responded_by_user_id uuid,
  responder_name text,
  responder_email text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scorecard_id, item_type, item_ref)
);
CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_scorecard_idx
  ON "{{schema}}".scorecard_corrective_actions (scorecard_id);
CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_open_idx
  ON "{{schema}}".scorecard_corrective_actions (scorecard_id) WHERE status = 'open';
ALTER TABLE "{{schema}}".field_scorecard_photos
  ADD COLUMN IF NOT EXISTS corrective_action_id uuid
  REFERENCES "{{schema}}".scorecard_corrective_actions(id) ON DELETE SET NULL;
-- TENANT_SCHEMA_END
```

> NOTE: confirm the provisioner's placeholder token (`{{schema}}` vs another) by reading the reference migration — match it exactly. Confirm the DO-loop `DECLARE`/`format` idiom against the reference migration too.

- [ ] **Step 3: Verify the migration parses on a throwaway PGlite**

Write a scratch check (or rely on Task 2's runtime test which creates the tables). Minimum: `grep -c "TENANT_SCHEMA" migrations/0190_scorecard_corrective_actions.sql` → expected `2` (START + END).

- [ ] **Step 4: Commit**

```bash
git add migrations/0190_scorecard_corrective_actions.sql
git commit -m "feat(scorecards): migration 0190 — corrective-action items table + status/photo columns"
```

---

### Task 2: Drizzle schema for `scorecard_corrective_actions` (+ photo column parity)

**Files:**
- Create: `shared/src/schema/tenant/scorecard-corrective-actions.ts`
- Modify: `shared/src/schema/tenant/field-scorecards.ts` (add `correctiveActionId` to the photos table + export the new table from the tenant index if there is one)
- Test: `shared/src/schema/tenant/__tests__/scorecard-corrective-actions.test.ts` (a light shape test)

- [ ] **Step 1: Write a failing test asserting the table + columns exist in the Drizzle model**

```typescript
import { describe, expect, it } from "vitest";
import { scorecardCorrectiveActions } from "../scorecard-corrective-actions";

describe("scorecardCorrectiveActions schema", () => {
  it("exposes the tracked-item columns", () => {
    const cols = Object.keys(scorecardCorrectiveActions);
    for (const c of ["id", "scorecardId", "itemType", "itemRef", "itemLabel", "status",
      "responseComment", "respondedByUserId", "responderName", "responderEmail", "respondedAt"]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run it — expect failure (module not found)**

Run: `npx vitest run shared/src/schema/tenant/__tests__/scorecard-corrective-actions.test.ts`
Expected: FAIL — cannot find `../scorecard-corrective-actions`.

- [ ] **Step 3: Create the Drizzle table (mirror migration 0190 exactly)**

```typescript
import { pgSchema, text, timestamp, uuid, unique, index } from "drizzle-orm/pg-core";
// Follow the file's existing pattern for how tenant tables bind to a schema. Match field-scorecards.ts.
// (If tenant tables are declared schema-less and namespaced at query time, do the same here.)

export const scorecardCorrectiveActions = /* pgTable or tenant-schema table, matching field-scorecards.ts */ ({
  id: uuid("id").primaryKey().defaultRandom(),
  scorecardId: uuid("scorecard_id").notNull(),
  itemType: text("item_type").notNull(), // 'action_item' | 'critical_deficiency'
  itemRef: text("item_ref").notNull(),
  itemLabel: text("item_label").notNull(),
  status: text("status").notNull().default("open"), // 'open' | 'resolved'
  responseComment: text("response_comment"),
  respondedByUserId: uuid("responded_by_user_id"),
  responderName: text("responder_name"),
  responderEmail: text("responder_email"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("scorecard_corrective_actions_scorecard_item_uidx").on(t.scorecardId, t.itemType, t.itemRef),
  index("scorecard_corrective_actions_scorecard_idx").on(t.scorecardId),
]);
```

> IMPORTANT: open `field-scorecards.ts` and copy its exact table-declaration idiom (schema binding, imports). Keep byte-parity discipline with the migration so `db:generate` sees no drift.

- [ ] **Step 4: Add `correctiveActionId` to the photos table in `field-scorecards.ts`**

Add to the `fieldScorecardPhotos` table definition: `correctiveActionId: uuid("corrective_action_id"),`.

- [ ] **Step 5: Run the test — expect pass; run shared build**

Run: `npx vitest run shared/src/schema/tenant/__tests__/scorecard-corrective-actions.test.ts` → PASS
Run: `npm run build --workspace shared` → clean

- [ ] **Step 6: Commit**

```bash
git add shared/src/schema/tenant/scorecard-corrective-actions.ts shared/src/schema/tenant/field-scorecards.ts shared/src/schema/tenant/__tests__/scorecard-corrective-actions.test.ts
git commit -m "feat(scorecards): drizzle model for scorecard_corrective_actions + photo FK"
```

---

### Task 3: Pure helper — is this scorecard in the corrective-action band, and what are its flagged items?

**Files:**
- Modify: `shared/src/types/field-scorecard.ts` (add `isCorrectiveActionBand` + `enumerateFlaggedItems`)
- Test: `shared/src/types/__tests__/field-scorecard-corrective.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { isCorrectiveActionBand, enumerateFlaggedItems } from "../field-scorecard";

describe("isCorrectiveActionBand", () => {
  it("is true only for the corrective_action rating", () => {
    expect(isCorrectiveActionBand("corrective_action")).toBe(true);
    expect(isCorrectiveActionBand("needs_improvement")).toBe(false);
    expect(isCorrectiveActionBand("elite")).toBe(false);
  });
});

describe("enumerateFlaggedItems", () => {
  it("yields one item per action item and per critical deficiency, with stable refs + labels", () => {
    const items = enumerateFlaggedItems({
      actionItems: ["Re-inspect slab 2", "Verify hold points"],
      criticalDeficiencies: ["missed_hold_point"],
    });
    expect(items).toEqual([
      { itemType: "action_item", itemRef: "0", itemLabel: "Re-inspect slab 2" },
      { itemType: "action_item", itemRef: "1", itemLabel: "Verify hold points" },
      { itemType: "critical_deficiency", itemRef: "missed_hold_point", itemLabel: "Missed hold point" },
    ]);
  });

  it("returns an empty list when nothing is flagged", () => {
    expect(enumerateFlaggedItems({ actionItems: [], criticalDeficiencies: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure (functions not exported)**

Run: `npx vitest run shared/src/types/__tests__/field-scorecard-corrective.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `field-scorecard.ts`**

```typescript
import type { ScorecardRating } from "./field-scorecard"; // (already in this file — reuse the existing type)
// Reuse the existing deficiency label lookup already in this file (the FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES
// map). If that constant lives here, use it directly; otherwise import it.

export function isCorrectiveActionBand(rating: ScorecardRating): boolean {
  return rating === "corrective_action";
}

export interface FlaggedItem {
  itemType: "action_item" | "critical_deficiency";
  itemRef: string;
  itemLabel: string;
}

export function enumerateFlaggedItems(input: {
  actionItems: string[];
  criticalDeficiencies: string[];
}): FlaggedItem[] {
  const items: FlaggedItem[] = [];
  input.actionItems.forEach((text, i) => {
    if (text.trim()) items.push({ itemType: "action_item", itemRef: String(i), itemLabel: text });
  });
  for (const key of input.criticalDeficiencies) {
    items.push({
      itemType: "critical_deficiency",
      itemRef: key,
      itemLabel: deficiencyLabel(key), // reuse the existing label lookup in this file
    });
  }
  return items;
}
```

> `deficiencyLabel(key)` — reuse whatever label lookup already exists for `FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES` in this file (find it first; do not duplicate the label table). If a lookup helper doesn't exist, add a tiny one over the existing constant.

- [ ] **Step 4: Run — expect pass; shared build**

Run: `npx vitest run shared/src/types/__tests__/field-scorecard-corrective.test.ts` → PASS
Run: `npm run build --workspace shared` → clean

- [ ] **Step 5: Commit**

```bash
git add shared/src/types/field-scorecard.ts shared/src/types/__tests__/field-scorecard-corrective.test.ts
git commit -m "feat(scorecards): helpers to detect the corrective-action band + enumerate flagged items"
```

---

### Task 4: Submit trigger — open the stage + seed items (runtime test)

**Files:**
- Modify: `server/src/modules/field/scorecards-service.ts` (in `createFieldScorecard`, after rating is computed and within the same transaction that inserts the scorecard + enqueues the email job)
- Test: `server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`

- [ ] **Step 1: Write a failing runtime test (PGlite) proving open+seed on a below-band submit**

Model it on the repo's existing scorecard runtime tests (look at `server/tests/modules/field/scorecards.runtime.test.ts` for the PGlite table setup + how `createFieldScorecard` is invoked). The test:
1. Sets up the tenant schema tables (field_scorecards, field_scorecard_items, field_scorecard_photos, scorecard_corrective_actions, deals, job_queue) exactly as the existing runtime test does, PLUS the new table.
2. Calls `createFieldScorecard` with a submission whose scores land in the corrective-action band AND has 2 action items + 1 critical deficiency.
3. Asserts: `field_scorecards.status = 'corrective_action_open'`; `scorecard_corrective_actions` has exactly 3 rows (2 action_item + 1 critical_deficiency) all `status='open'` with the right `item_ref`/`item_label`.
4. A SECOND test: a passing (above-band) submission → status stays `submitted`, zero corrective-action rows.

```typescript
// (Skeleton — mirror the existing runtime test's beforeAll/PGlite setup exactly.)
it("opens the corrective-action stage and seeds one row per flagged item on a below-band submit", async () => {
  const { scorecard } = await createFieldScorecard(db, belowBandSubmission()); // scores avg < 7, 2 action items + 1 deficiency
  const row = await getScorecardRow(db, scorecard.id);
  expect(row.status).toBe("corrective_action_open");
  const items = await getCorrectiveActions(db, scorecard.id);
  expect(items).toHaveLength(3);
  expect(items.filter((i) => i.status === "open")).toHaveLength(3);
  expect(items.map((i) => i.itemType).sort()).toEqual(["action_item", "action_item", "critical_deficiency"]);
});

it("leaves a passing scorecard as 'submitted' with no corrective-action rows", async () => {
  const { scorecard } = await createFieldScorecard(db, passingSubmission()); // avg >= 7, no deficiencies
  expect((await getScorecardRow(db, scorecard.id)).status).toBe("submitted");
  expect(await getCorrectiveActions(db, scorecard.id)).toHaveLength(0);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`
Expected: FAIL (status is `submitted`; no rows seeded).

- [ ] **Step 3: Implement the trigger in `createFieldScorecard`**

Inside the existing submit transaction, after `rating` is computed and the scorecard row is inserted, add. Enumerate the flagged items FIRST, then open the stage ONLY when the rating is in the corrective-action band AND there is at least one flagged item — otherwise the card stays `submitted` (a below-band card with nothing flagged has nothing to correct):

```typescript
const flagged = enumerateFlaggedItems({ actionItems, criticalDeficiencies: deficiencies });

if (isCorrectiveActionBand(rating) && flagged.length > 0) {
  await tenantDb
    .update(fieldScorecards)
    .set({ status: "corrective_action_open" })
    .where(eq(fieldScorecards.id, card.id));

  await tenantDb.insert(scorecardCorrectiveActions).values(
    flagged.map((f) => ({
      scorecardId: card.id,
      itemType: f.itemType,
      itemRef: f.itemRef,
      itemLabel: f.itemLabel,
      status: "open" as const,
    }))
  );
}
```

Use the same `tenantDb`/`card`/`actionItems`/`deficiencies` bindings already present in `createFieldScorecard` (verify their exact names). Import `isCorrectiveActionBand`, `enumerateFlaggedItems`, `scorecardCorrectiveActions`.

> EDGE CASE the test must also cover (add a third test): below-band rating but ZERO flagged items (score low, but the form had no action items / deficiencies). For v1, if `flagged.length === 0`, leave status `submitted` (nothing to correct itemwise) — the spec §4.2 has items drive the stage. This is exactly what the Step 3 block above encodes: `corrective_action_open` is only set when `isCorrectiveActionBand(rating) && flagged.length > 0`.

- [ ] **Step 4: Run — expect pass (all three cases)**

Run: `npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts` → PASS
Run: `npm run typecheck --workspace server` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/field/scorecards-service.ts server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts
git commit -m "feat(scorecards): open corrective-action stage + seed items on below-band submit"
```

---

### Task 5: Closure service — resolve an item + auto-close when all resolved

**Files:**
- Create: `server/src/modules/field/corrective-actions-service.ts`
- Test: extend `server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`

- [ ] **Step 1: Write failing tests for resolve + auto-close**

```typescript
it("resolving the LAST open item auto-closes the scorecard; resolving a non-last item does not", async () => {
  const { scorecard } = await createFieldScorecard(db, belowBandSubmission()); // seeds 3 open items
  const items = await getCorrectiveActions(db, scorecard.id);

  await resolveCorrectiveActionItem(db, {
    scorecardId: scorecard.id, itemId: items[0].id,
    responseComment: "fixed", respondedBy: { userId: "user-1", name: "Sam", email: null },
  });
  expect((await getScorecardRow(db, scorecard.id)).status).toBe("corrective_action_open"); // still open

  for (const it of items.slice(1)) {
    await resolveCorrectiveActionItem(db, {
      scorecardId: scorecard.id, itemId: it.id,
      responseComment: "fixed", respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
    });
  }
  expect((await getScorecardRow(db, scorecard.id)).status).toBe("corrective_action_closed"); // all resolved -> closed
});

it("re-resolving an already-resolved item is a no-op (idempotent) and keeps it closed", async () => {
  // resolve all, then resolve the first again — status stays closed, no throw
});
```

- [ ] **Step 2: Run — expect failure (function not defined)**

Run: `npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts -t "auto-closes"`
Expected: FAIL.

- [ ] **Step 3: Implement `resolveCorrectiveActionItem`**

```typescript
import { and, eq } from "drizzle-orm";
import { scorecardCorrectiveActions } from "@trock-crm/shared/schema";
import { fieldScorecards } from "@trock-crm/shared/schema";

export interface ResolveInput {
  scorecardId: string;
  itemId: string;
  responseComment: string;
  respondedBy: { userId: string | null; name: string | null; email: string | null };
  photoFileIds?: string[]; // linked in Plan 2's endpoint; accepted here for reuse
}

/** Mark one corrective-action item resolved; if it was the last open item for the scorecard, close it.
 *  Idempotent: resolving an already-resolved item is a no-op. Runs in a single transaction. */
export async function resolveCorrectiveActionItem(db: TenantDb, input: ResolveInput): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(scorecardCorrectiveActions)
      .set({
        status: "resolved",
        responseComment: input.responseComment,
        respondedByUserId: input.respondedBy.userId,
        responderName: input.respondedBy.name,
        responderEmail: input.respondedBy.email,
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(scorecardCorrectiveActions.id, input.itemId),
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
        eq(scorecardCorrectiveActions.status, "open"), // idempotent: only an OPEN item transitions
      ))
      .returning({ id: scorecardCorrectiveActions.id });

    if (updated.length === 0) return; // already resolved or not found — no-op

    const stillOpen = await tx
      .select({ id: scorecardCorrectiveActions.id })
      .from(scorecardCorrectiveActions)
      .where(and(
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
        eq(scorecardCorrectiveActions.status, "open"),
      ));

    if (stillOpen.length === 0) {
      await tx
        .update(fieldScorecards)
        .set({ status: "corrective_action_closed", updatedAt: new Date() })
        .where(eq(fieldScorecards.id, input.scorecardId));
    }
  });
}
```

> Match `TenantDb` to the type the existing field services use (find the alias in scorecards-service.ts). The `.returning` + status-guarded update gives idempotency without a race: two concurrent resolves of the same item — only one updates a row; the closure check reads within the txn.

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts` → PASS (all cases)
Run: `npm run typecheck --workspace server` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/field/corrective-actions-service.ts server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts
git commit -m "feat(scorecards): resolve corrective-action item + auto-close on last resolve"
```

---

## Self-review (done at authoring)

- **Spec coverage (Plan 1 slice):** §4.1 status stages → Task 1/4; §4.2 items table → Task 1/2; §4.3 photo FK → Task 1/2; §5 open+seed on submit → Task 4; §8 closure (all items, either responder) → Task 5. Recipients/email/tokens/API/UI are explicitly Plans 2–4.
- **Placeholders:** the only deferrals are the two "confirm against the reference file" notes (provisioner placeholder token; exact Drizzle idiom) — these are verification steps, not missing content, and each has an exact command/file to check.
- **Type consistency:** `scorecardCorrectiveActions`, `FlaggedItem`, `isCorrectiveActionBand`, `enumerateFlaggedItems`, `resolveCorrectiveActionItem`, and the `status` string values (`corrective_action_open`/`corrective_action_closed`, item `open`/`resolved`) are used identically across tasks.

## Next plans (not in this file)
- **Plan 2:** `GET/POST` corrective-action endpoints (session + token auth), hybrid recipient resolution, the `scorecard_corrective_action_email` job, and web tokens.
- **Plan 3:** the TRock Cam itemized response screen.
- **Plan 4:** Team-tab email-only config, inline thread rendering (web + mobile), QC dashboard status, and the tokenized web responder page.
