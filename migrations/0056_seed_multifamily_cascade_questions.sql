-- Migration 0056: add multifamily cascade questions to lead questionnaire v2
-- The v2 questionnaire seed is idempotent; these nodes extend the inherited
-- Traditional Multifamily template without modifying earlier migrations.

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
    ('40000000-0000-4000-8000-000000000401'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'lighting_count', 'Lighting Count', NULL, 'number', '[]'::jsonb, false, 170, true),
    ('40000000-0000-4000-8000-000000000402'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000401'::uuid, NULL::varchar, 'question', 'lighting_provided_by_client', 'Lighting provided by client?', NULL, 'boolean', '[]'::jsonb, true, 171, true),

    ('40000000-0000-4000-8000-000000000410'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'roofing_scope', 'Roofing Scope', NULL, 'boolean', '[]'::jsonb, false, 180, true),
    ('40000000-0000-4000-8000-000000000411'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000410'::uuid, 'true', 'question', 'roof_type', 'Roof Type', NULL, 'text', '[]'::jsonb, true, 181, true),
    ('40000000-0000-4000-8000-000000000412'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000410'::uuid, 'true', 'question', 'roof_specs', 'Roof Specs', NULL, 'textarea', '[]'::jsonb, true, 182, true),
    ('40000000-0000-4000-8000-000000000413'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000410'::uuid, 'true', 'question', 'gutters_downspouts', 'Gutters / Downspouts', NULL, 'boolean', '[]'::jsonb, true, 183, true),
    ('40000000-0000-4000-8000-000000000414'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000410'::uuid, 'true', 'question', 'roofing_insurance_claim', 'Insurance Claim', NULL, 'boolean', '[]'::jsonb, true, 184, true),

    ('40000000-0000-4000-8000-000000000420'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'exterior_paint', 'Exterior Paint', NULL, 'boolean', '[]'::jsonb, false, 190, true),
    ('40000000-0000-4000-8000-000000000421'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000420'::uuid, 'true', 'question', 'exterior_paint_scope', 'Exterior Paint Scope / Specs', NULL, 'textarea', '[]'::jsonb, true, 191, true),

    ('40000000-0000-4000-8000-000000000430'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'parking_lot', 'Parking Lot', NULL, 'boolean', '[]'::jsonb, false, 200, true),
    ('40000000-0000-4000-8000-000000000431'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000430'::uuid, 'true', 'question', 'parking_lot_scope', 'Parking Lot Scope', NULL, 'textarea', '[]'::jsonb, true, 201, true),

    ('40000000-0000-4000-8000-000000000440'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'balconies', 'Balconies', NULL, 'boolean', '[]'::jsonb, false, 210, true),
    ('40000000-0000-4000-8000-000000000441'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000440'::uuid, 'true', 'question', 'balcony_scope', 'Balcony Scope', NULL, 'textarea', '[]'::jsonb, true, 211, true),

    ('40000000-0000-4000-8000-000000000450'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'water_intrusion', 'Water Intrusion', NULL, 'boolean', '[]'::jsonb, false, 220, true),
    ('40000000-0000-4000-8000-000000000451'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000450'::uuid, 'true', 'question', 'water_intrusion_scope', 'Water Intrusion Scope', NULL, 'textarea', '[]'::jsonb, true, 221, true),

    ('40000000-0000-4000-8000-000000000460'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'windows_doors', 'Windows / Doors', NULL, 'boolean', '[]'::jsonb, false, 230, true),
    ('40000000-0000-4000-8000-000000000461'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000460'::uuid, 'true', 'question', 'windows_doors_scope', 'Windows / Doors Scope', NULL, 'textarea', '[]'::jsonb, true, 231, true),

    ('40000000-0000-4000-8000-000000000470'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'unit_upgrades', 'Unit Upgrades', NULL, 'boolean', '[]'::jsonb, false, 240, true),
    ('40000000-0000-4000-8000-000000000471'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000470'::uuid, 'true', 'question', 'unit_upgrade_number_of_units', 'Number of Units', NULL, 'number', '[]'::jsonb, true, 241, true),
    ('40000000-0000-4000-8000-000000000472'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000470'::uuid, 'true', 'question', 'unit_upgrade_number_executed', 'Number Executed', NULL, 'number', '[]'::jsonb, false, 242, true),
    ('40000000-0000-4000-8000-000000000473'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000470'::uuid, 'true', 'question', 'unit_upgrade_unit_matrix', 'Unit Matrix', NULL, 'textarea', '[]'::jsonb, true, 243, true),
    ('40000000-0000-4000-8000-000000000474'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000470'::uuid, 'true', 'question', 'unit_upgrade_cost_per_unit', 'Cost per Unit', NULL, 'currency', '[]'::jsonb, false, 244, true),
    ('40000000-0000-4000-8000-000000000475'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000470'::uuid, 'true', 'question', 'unit_upgrade_scope_specs', 'Scope / Specs', NULL, 'textarea', '[]'::jsonb, true, 245, true),
    ('40000000-0000-4000-8000-000000000476'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000470'::uuid, 'true', 'question', 'unit_upgrade_renewals', 'Renewals', NULL, 'text', '[]'::jsonb, false, 246, true),

    ('40000000-0000-4000-8000-000000000480'::uuid, (SELECT id FROM multifamily), NULL::uuid, NULL::varchar, 'question', 'corridors', 'Corridors', NULL, 'boolean', '[]'::jsonb, false, 250, true),
    ('40000000-0000-4000-8000-000000000481'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000480'::uuid, 'true', 'question', 'number_of_doors', 'Number of Doors', NULL, 'number', '[]'::jsonb, true, 251, true),
    ('40000000-0000-4000-8000-000000000482'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000480'::uuid, 'true', 'question', 'corridor_closed_open_air', 'Closed / Open Air', NULL, 'select', '[{"value":"closed","label":"Closed"},{"value":"open_air","label":"Open Air"}]'::jsonb, true, 252, true),
    ('40000000-0000-4000-8000-000000000483'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000480'::uuid, 'true', 'question', 'corridor_color_change', 'Color Change', NULL, 'boolean', '[]'::jsonb, true, 253, true),
    ('40000000-0000-4000-8000-000000000484'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000480'::uuid, 'true', 'question', 'corridor_lighting', 'Lighting', NULL, 'textarea', '[]'::jsonb, true, 254, true),
    ('40000000-0000-4000-8000-000000000485'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000480'::uuid, 'true', 'question', 'corridor_flooring', 'Flooring', NULL, 'textarea', '[]'::jsonb, true, 255, true),
    ('40000000-0000-4000-8000-000000000486'::uuid, (SELECT id FROM multifamily), '40000000-0000-4000-8000-000000000480'::uuid, 'true', 'question', 'corridor_stairwells', 'Stairwells', NULL, 'textarea', '[]'::jsonb, true, 256, true)
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
