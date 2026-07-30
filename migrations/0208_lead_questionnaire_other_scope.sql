-- Migration 0208: an "Other" scope on the lead questionnaire.
--
-- The ten seeded scopes are the work T-Rock normally bids. A lead that falls outside all of them currently
-- cannot be created at all: the form refuses to submit without a scope ("Select at least one scope"), so the
-- only ways through are to pick a scope that is wrong or to abandon the lead. This adds a free-text escape
-- hatch for exactly that case.
--
-- Data-only. The scope grid renders whatever groups exist (label, status, answered count) and the question
-- renderer already handles `textarea`, so no client change is needed for the card to appear and work.
--
-- Shape follows the existing groups exactly (see water_intrusion):
--   * display_order 0, key `<group>_applies`, boolean, NOT required — the toggle the card's selected state
--     reads. lead-questionnaire-sections.tsx treats a parentless node as the group's applies-node when its
--     key ends `_applies` OR its display_order is 0; this satisfies both, so it cannot be missed.
--   * display_order 1+, the questions, required.
--
-- `is_required = true` on the description is safe and deliberate: required-ness is only enforced for VISIBLE
-- nodes (lead-form.tsx filters `v2VisibleQuestionNodes`), and a scope group's questions are visible only once
-- the group is selected. So it is required IF the user picks Other, and inert otherwise — which is the point.
-- An Other scope with no description would carry no information at all.
--
-- project_type_id IS NULL = the universal questionnaire (migration 0083), which is the set the lead form
-- renders. Idempotent: keyed on (key) among universal scope nodes, so a re-run updates rather than duplicates.

INSERT INTO public.project_type_question_nodes (
  id, project_type_id, parent_node_id, parent_option_value, node_type,
  key, label, prompt, input_type, options, is_required, display_order,
  is_active, section_key, group_key, group_label, group_order
)
VALUES
  (
    '0a4b1c9e-8f21-4d63-b7a5-2e6c9d10f001', NULL, NULL, NULL, 'question',
    'other_applies', 'Does another scope apply?', NULL, 'boolean', '[]'::jsonb, false, 0,
    true, 'scope', 'other', 'Other', 11
  ),
  (
    -- CHILD of the applies-node, with parent_option_value 'true'. The panel builds a group's question list as
    -- `node.parentNodeId === appliesNode.id` — a parentless question is in the group but renders NOWHERE, so
    -- the card would select and open onto an empty panel. Matches water_intrusion et al exactly.
    '0a4b1c9e-8f21-4d63-b7a5-2e6c9d10f002', NULL, '0a4b1c9e-8f21-4d63-b7a5-2e6c9d10f001', 'true', 'question',
    'other_scope_description', 'Describe the scope',
    'What work is needed? Use this when the project does not fit the scopes above.',
    'textarea', '[]'::jsonb, true, 1,
    true, 'scope', 'other', 'Other', 11
  )
ON CONFLICT (id) DO UPDATE SET
  parent_node_id      = EXCLUDED.parent_node_id,
  parent_option_value = EXCLUDED.parent_option_value,
  label         = EXCLUDED.label,
  prompt        = EXCLUDED.prompt,
  input_type    = EXCLUDED.input_type,
  is_required   = EXCLUDED.is_required,
  display_order = EXCLUDED.display_order,
  is_active     = true,
  section_key   = EXCLUDED.section_key,
  group_key     = EXCLUDED.group_key,
  group_label   = EXCLUDED.group_label,
  group_order   = EXCLUDED.group_order,
  updated_at    = now();

-- A prior partial run (or a hand-seeded node) could have created these keys under a different id. Fold any
-- such row into this group rather than leaving a duplicate card on the grid.
UPDATE public.project_type_question_nodes
   SET is_active = false, updated_at = now()
 WHERE project_type_id IS NULL
   AND key IN ('other_applies', 'other_scope_description')
   AND id NOT IN (
     '0a4b1c9e-8f21-4d63-b7a5-2e6c9d10f001',
     '0a4b1c9e-8f21-4d63-b7a5-2e6c9d10f002'
   );
