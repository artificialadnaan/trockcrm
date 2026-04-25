-- Migration 0054: seed lead questionnaire nodes for inherited project-type templates
-- Adds baseline questions plus root-family question sets for multifamily, commercial, and restoration.

INSERT INTO public.project_type_question_nodes (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
VALUES
  ('40000000-0000-4000-8000-000000000001', NULL, NULL, NULL, 'question', 'bid_due_date', 'Bid Due Date', NULL, 'date', '[]'::jsonb, true, 10, true),
  ('40000000-0000-4000-8000-000000000002', NULL, NULL, NULL, 'question', 'budget', 'Budget', NULL, 'currency', '[]'::jsonb, true, 20, true),
  ('40000000-0000-4000-8000-000000000003', NULL, NULL, NULL, 'question', 'number_of_bidders', 'Number of Bidders', NULL, 'number', '[]'::jsonb, true, 30, true),
  ('40000000-0000-4000-8000-000000000004', NULL, NULL, NULL, 'question', 'client_bid_portal_requirements', 'Client Bid Portal / Bid Format Requirements', NULL, 'textarea', '[]'::jsonb, true, 40, true),
  ('40000000-0000-4000-8000-000000000005', NULL, NULL, NULL, 'question', 'poc', 'POC', NULL, 'text', '[]'::jsonb, true, 50, true),
  ('40000000-0000-4000-8000-000000000006', NULL, NULL, NULL, 'question', 'timeline', 'Timeline', NULL, 'textarea', '[]'::jsonb, true, 60, true),
  ('40000000-0000-4000-8000-000000000007', NULL, NULL, NULL, 'question', 'client_provided_docs', 'Client Provided Docs (Plans, Scope, Specs)', NULL, 'textarea', '[]'::jsonb, true, 70, true),
  ('40000000-0000-4000-8000-000000000008', NULL, NULL, NULL, 'question', 'project_permitted', 'Is this project Permitted', NULL, 'boolean', '[]'::jsonb, true, 80, true),
  ('40000000-0000-4000-8000-000000000009', NULL, NULL, NULL, 'question', 'market_type', 'Market Type', NULL, 'select', '[{"value":"market_rate","label":"Market Rate"},{"value":"student_housing","label":"Student Housing"},{"value":"senior_living","label":"Senior Living"},{"value":"lihtc","label":"LIHTC"}]'::jsonb, true, 90, true),
  ('40000000-0000-4000-8000-000000000010', NULL, NULL, NULL, 'question', 'life_safety', 'Life Safety', NULL, 'textarea', '[]'::jsonb, true, 100, true)
ON CONFLICT (id) DO UPDATE
SET
  key = EXCLUDED.key,
  label = EXCLUDED.label,
  prompt = EXCLUDED.prompt,
  input_type = EXCLUDED.input_type,
  options = EXCLUDED.options,
  is_required = EXCLUDED.is_required,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

WITH multifamily AS (
  SELECT id
  FROM public.project_type_config
  WHERE slug = 'multifamily'
)
INSERT INTO public.project_type_question_nodes (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
SELECT *
FROM (
  VALUES
    ('40000000-0000-4000-8000-000000000101'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'number_of_units', 'Number of Units', NULL, 'number', '[]'::jsonb, true, 110, true),
    ('40000000-0000-4000-8000-000000000102'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'number_of_units_executed', 'Number of Units Executed', NULL, 'number', '[]'::jsonb, false, 120, true),
    ('40000000-0000-4000-8000-000000000103'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'unit_matrix', 'Number of Units by Type (Unit Matrix)', NULL, 'textarea', '[]'::jsonb, true, 130, true),
    ('40000000-0000-4000-8000-000000000104'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'cost_per_unit_average_budget', 'Cost per Unit / Average Budget', NULL, 'currency', '[]'::jsonb, false, 140, true),
    ('40000000-0000-4000-8000-000000000105'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'scope_and_specs', 'Scope and Specs', NULL, 'textarea', '[]'::jsonb, true, 150, true),
    ('40000000-0000-4000-8000-000000000106'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'renewals_or_non_renewals', 'Renewals or Non-renewals', NULL, 'text', '[]'::jsonb, false, 160, true)
) AS seed_rows (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
WHERE project_type_id IS NOT NULL
ON CONFLICT (id) DO UPDATE
SET
  project_type_id = EXCLUDED.project_type_id,
  parent_node_id = EXCLUDED.parent_node_id,
  parent_option_value = EXCLUDED.parent_option_value,
  key = EXCLUDED.key,
  label = EXCLUDED.label,
  prompt = EXCLUDED.prompt,
  input_type = EXCLUDED.input_type,
  options = EXCLUDED.options,
  is_required = EXCLUDED.is_required,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

WITH commercial AS (
  SELECT id
  FROM public.project_type_config
  WHERE slug = 'commercial'
)
INSERT INTO public.project_type_question_nodes (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
SELECT *
FROM (
  VALUES
    ('40000000-0000-4000-8000-000000000201'::uuid, (SELECT id FROM commercial), NULL::uuid, NULL::varchar, 'question', 'scope_type', 'Scope Type', NULL, 'text', '[]'::jsonb, true, 110, true),
    ('40000000-0000-4000-8000-000000000202'::uuid, (SELECT id FROM commercial), NULL::uuid, NULL::varchar, 'question', 'site_access', 'Access', NULL, 'textarea', '[]'::jsonb, false, 120, true),
    ('40000000-0000-4000-8000-000000000203'::uuid, (SELECT id FROM commercial), NULL::uuid, NULL::varchar, 'question', 'occupancy_constraints', 'Occupancy Constraints', NULL, 'textarea', '[]'::jsonb, false, 130, true)
) AS seed_rows (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
WHERE project_type_id IS NOT NULL
ON CONFLICT (id) DO UPDATE
SET
  project_type_id = EXCLUDED.project_type_id,
  parent_node_id = EXCLUDED.parent_node_id,
  parent_option_value = EXCLUDED.parent_option_value,
  key = EXCLUDED.key,
  label = EXCLUDED.label,
  prompt = EXCLUDED.prompt,
  input_type = EXCLUDED.input_type,
  options = EXCLUDED.options,
  is_required = EXCLUDED.is_required,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

WITH restoration AS (
  SELECT id
  FROM public.project_type_config
  WHERE slug = 'restoration'
)
INSERT INTO public.project_type_question_nodes (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
SELECT *
FROM (
  VALUES
    ('40000000-0000-4000-8000-000000000301'::uuid, (SELECT id FROM restoration), NULL::uuid, NULL::varchar, 'question', 'fire_or_flood', 'Fire or Flood', NULL, 'select', '[{"value":"fire","label":"Fire"},{"value":"flood","label":"Flood"}]'::jsonb, true, 110, true),
    ('40000000-0000-4000-8000-000000000302'::uuid, (SELECT id FROM restoration), NULL::uuid, NULL::varchar, 'question', 'insurance_claim', 'Insurance Claim', NULL, 'boolean', '[]'::jsonb, true, 120, true),
    ('40000000-0000-4000-8000-000000000303'::uuid, (SELECT id FROM restoration), '40000000-0000-4000-8000-000000000302'::uuid, 'true', 'question', 'xactimate', 'Xactimate?', NULL, 'boolean', '[]'::jsonb, false, 130, true),
    ('40000000-0000-4000-8000-000000000304'::uuid, (SELECT id FROM restoration), NULL::uuid, NULL::varchar, 'question', 'emergency_response', 'Emergency Response', NULL, 'boolean', '[]'::jsonb, false, 140, true),
    ('40000000-0000-4000-8000-000000000305'::uuid, (SELECT id FROM restoration), '40000000-0000-4000-8000-000000000304'::uuid, 'true', 'question', 'emergency_response_details', 'Emergency Response Details', NULL, 'textarea', '[]'::jsonb, false, 150, true),
    ('40000000-0000-4000-8000-000000000306'::uuid, (SELECT id FROM restoration), NULL::uuid, NULL::varchar, 'question', 'number_of_units_affected', 'Number of Units Affected', NULL, 'number', '[]'::jsonb, true, 160, true)
) AS seed_rows (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active
)
WHERE project_type_id IS NOT NULL
ON CONFLICT (id) DO UPDATE
SET
  project_type_id = EXCLUDED.project_type_id,
  parent_node_id = EXCLUDED.parent_node_id,
  parent_option_value = EXCLUDED.parent_option_value,
  key = EXCLUDED.key,
  label = EXCLUDED.label,
  prompt = EXCLUDED.prompt,
  input_type = EXCLUDED.input_type,
  options = EXCLUDED.options,
  is_required = EXCLUDED.is_required,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
