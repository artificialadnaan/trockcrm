import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The REAL 0208 applied to the REAL table shape. What matters here is not the DDL — there is none — but that
// the seeded rows satisfy the conventions the CLIENT relies on to draw the card and drive its selected state.
// Those conventions live in lead-questionnaire-sections.tsx and are asserted explicitly below, because a seed
// that lands in the table but violates one of them produces a card that renders and cannot be selected.
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0208_lead_questionnaire_other_scope.sql", import.meta.url),
  "utf8",
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Mirrors public.project_type_question_nodes as it exists in production.
  await db.exec(`
    CREATE TABLE public.project_type_question_nodes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_type_id uuid,
      parent_node_id uuid,
      parent_option_value varchar,
      node_type varchar NOT NULL DEFAULT 'question',
      key varchar NOT NULL,
      label varchar NOT NULL,
      prompt text,
      input_type varchar,
      options jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_required boolean NOT NULL DEFAULT false,
      display_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      section_key text,
      group_key text,
      group_label text,
      group_order integer
    );
  `);
  // THE INDEX MATTERS. 0082 created this, it covers INACTIVE rows, and omitting it from this fixture is what
  // let a migration through that aborts on any database where either key already exists under another UUID.
  // Same shape of mistake as the 0202 P0: model the table, miss the constraint, ship a migration that cannot
  // apply. Copied verbatim from `pg_indexes` in production.
  await db.exec(`
    CREATE UNIQUE INDEX project_type_question_nodes_universal_key_uidx
      ON public.project_type_question_nodes USING btree (key) WHERE (project_type_id IS NULL);
  `);
  // An existing scope group, so ordering and uniqueness are exercised against real neighbours.
  await db.exec(`
    INSERT INTO public.project_type_question_nodes
      (key, label, input_type, is_required, display_order, section_key, group_key, group_label, group_order)
    VALUES
      ('water_intrusion_applies','Does water intrusion scope apply?','boolean',false,0,'scope','water_intrusion','Water Intrusion',5),
      ('leak_locations','Locations of Leak','textarea',true,1,'scope','water_intrusion','Water Intrusion',5);
  `);
  await db.exec(MIGRATION_SQL);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function otherNodes() {
  const { rows } = await db.query<{
    key: string; label: string; input_type: string; is_required: boolean;
    display_order: number; group_label: string; group_order: number; is_active: boolean;
    parent_node_id: string | null; project_type_id: string | null; prompt: string | null;
  }>(
    `SELECT key, label, input_type, is_required, display_order, group_label, group_order, is_active,
            parent_node_id, project_type_id, prompt
       FROM public.project_type_question_nodes
      WHERE group_key = 'other' AND is_active
      ORDER BY display_order`,
  );
  return rows;
}

describe("migration 0208 — the Other scope", () => {
  it("seeds a selectable card with one free-text field", async () => {
    const rows = await otherNodes();
    expect(rows.map((r) => r.key)).toEqual(["other_applies", "other_scope_description"]);
    expect(rows[0].group_label).toBe("Other");
    // Last on the grid, after the ten seeded scopes.
    expect(rows[0].group_order).toBe(11);
  });

  it("the applies-node satisfies BOTH rules the client uses to find it", async () => {
    // lead-questionnaire-sections.tsx: a parentless node becomes the group's applies-node when its key ends
    // `_applies` OR its display_order is 0. Satisfying both means a future refactor that drops either rule
    // still finds it — and without an applies-node the card renders but can never be selected, so the scope
    // would be visible and unusable.
    const [applies] = await otherNodes();
    expect(applies.key.endsWith("_applies")).toBe(true);
    expect(applies.display_order).toBe(0);
    expect(applies.parent_node_id).toBeNull();
    expect(applies.input_type).toBe("boolean");
    // NOT required: it is the toggle. Requiring it would demand every lead answer "no" to Other explicitly.
    expect(applies.is_required).toBe(false);
  });

  it("the description is a CHILD of the applies-node, or it renders nowhere", async () => {
    // The panel builds a group's question list as `node.parentNodeId === appliesNode.id`. A parentless
    // question still belongs to the group — it counts toward "answered", it is in `group.nodes` — but the
    // panel never draws it, so the card selects and opens onto an empty box. My first version of this
    // migration did exactly that, and the client test caught it.
    const rows = await otherNodes();
    const applies = rows[0];
    const { rows: child } = await db.query<{ parent_node_id: string | null; parent_option_value: string | null }>(
      `SELECT parent_node_id, parent_option_value FROM public.project_type_question_nodes
        WHERE key = 'other_scope_description' AND is_active`,
    );
    expect(child[0].parent_node_id).toBe(
      (await db.query<{ id: string }>(
        `SELECT id FROM public.project_type_question_nodes WHERE key='other_applies' AND is_active`,
      )).rows[0].id,
    );
    // 'true' — the same option value every other scope uses to mean "the group applies".
    expect(child[0].parent_option_value).toBe("true");
    expect(applies.key).toBe("other_applies");
  });

  it("the description is a REQUIRED textarea — enforced only once Other is selected", async () => {
    // Required-ness is filtered through `v2VisibleQuestionNodes`, and a scope group's questions are visible
    // only when the group is selected. So this blocks submit if the user picks Other and types nothing, and
    // is inert otherwise. An Other scope with no description carries no information at all.
    const [, description] = await otherNodes();
    expect(description.input_type).toBe("textarea");
    expect(description.is_required).toBe(true);
    expect(description.prompt).toContain("does not fit the scopes above");
  });

  it("belongs to the UNIVERSAL questionnaire, which is the set the lead form renders", async () => {
    for (const row of await otherNodes()) {
      expect(row.project_type_id).toBeNull();
    }
  });

  it("is idempotent — a re-run updates rather than duplicating the card", async () => {
    await db.exec(MIGRATION_SQL);
    const rows = await otherNodes();
    expect(rows).toHaveLength(2);
  });

  it("APPLIES over rows that already exist under a different UUID", async () => {
    // The state this migration exists to tolerate: a partial earlier run, or hand-seeded nodes. Because the
    // universal-key index is UNIQUE and covers inactive rows, an insert keyed on `id` raises a unique
    // violation and aborts the whole migration before any cleanup can run. Arbitrating on the key makes it
    // total — and the pre-existing row keeps its own id, which is why the description's parent is resolved
    // from RETURNING rather than hard-coded.
    const fresh = new PGlite();
    try {
      await fresh.exec(`
        CREATE TABLE public.project_type_question_nodes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_type_id uuid, parent_node_id uuid, parent_option_value varchar,
          node_type varchar NOT NULL DEFAULT 'question', key varchar NOT NULL, label varchar NOT NULL,
          prompt text, input_type varchar, options jsonb NOT NULL DEFAULT '[]'::jsonb,
          is_required boolean NOT NULL DEFAULT false, display_order integer NOT NULL DEFAULT 0,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          section_key text, group_key text, group_label text, group_order integer
        );
        CREATE UNIQUE INDEX project_type_question_nodes_universal_key_uidx
          ON public.project_type_question_nodes USING btree (key) WHERE (project_type_id IS NULL);
      `);
      // Pre-existing rows: different ids, INACTIVE (the index still covers them), and mis-shaped in the two
      // ways that break rendering rather than merely looking wrong — a node_type the questionnaire filters
      // out, and stale options that would make a textarea normalise as a select.
      await fresh.exec(`
        INSERT INTO public.project_type_question_nodes
          (id, key, label, input_type, node_type, options, is_active, section_key, group_key, group_label, group_order)
        VALUES
          ('11111111-1111-1111-1111-111111111111','other_applies','Stale label','boolean','section','[]'::jsonb,false,'scope','other','Other',99),
          ('22222222-2222-2222-2222-222222222222','other_scope_description','Stale desc','text','question','[{"value":"a","label":"A"}]'::jsonb,false,'scope','other','Other',99);
      `);

      await expect(fresh.exec(MIGRATION_SQL)).resolves.toBeDefined();

      const { rows } = await fresh.query<{
        id: string; key: string; label: string; is_active: boolean;
        parent_node_id: string | null; group_order: number;
      }>(
        `SELECT id, key, label, is_active, parent_node_id, group_order
           FROM public.project_type_question_nodes WHERE group_key='other' ORDER BY display_order`,
      );
      // One row per key — no duplicates, and the originals were reused, not replaced.
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe("11111111-1111-1111-1111-111111111111");
      expect(rows[1].id).toBe("22222222-2222-2222-2222-222222222222");
      // Reactivated, relabelled, reordered...
      expect(rows.every((r) => r.is_active)).toBe(true);
      expect(rows[0].label).toBe("Does another scope apply?");
      expect(rows[0].group_order).toBe(11);
      // ...and the description parents to the EXISTING applies-node, not the hard-coded literal.
      expect(rows[1].parent_node_id).toBe("11111111-1111-1111-1111-111111111111");

      // The render-critical fields are normalised, not just reactivated: a stray node_type would filter the
      // whole group out of the questionnaire, and stale options would render the textarea as a select.
      const { rows: shape } = await fresh.query<{ node_type: string; options: unknown; input_type: string }>(
        `SELECT node_type, options, input_type FROM public.project_type_question_nodes
          WHERE group_key='other' ORDER BY display_order`,
      );
      expect(shape.map((r) => r.node_type)).toEqual(["question", "question"]);
      expect(shape[1].input_type).toBe("textarea");
      expect(shape[1].options).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it("leaves the existing scopes untouched", async () => {
    const { rows } = await db.query<{ group_key: string; n: number }>(
      `SELECT group_key, count(*)::int AS n FROM public.project_type_question_nodes
        WHERE is_active AND group_key = 'water_intrusion' GROUP BY 1`,
    );
    expect(rows).toEqual([{ group_key: "water_intrusion", n: 2 }]);
  });
});
