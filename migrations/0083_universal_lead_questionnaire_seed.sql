-- This migration was rewritten on 2026-05-05 after the original version
-- crashed in production with PG error 21000 ("ON CONFLICT DO UPDATE
-- command cannot affect row a second time"). The original transaction
-- rolled back cleanly, so no DB has the previous version applied. See
-- the hotfix PR for the full incident notes.
--
-- This rewritten version is idempotent: safe to run on a fresh DB and
-- safe to re-run on any partial state.

UPDATE public.project_type_question_nodes
SET is_active = false, updated_at = now()
WHERE project_type_id IS NOT NULL
  AND is_active = true;

UPDATE public.project_type_question_nodes
SET is_active = false, updated_at = now()
WHERE project_type_id IS NULL
  AND key = 'poc'
  AND is_active = true;

CREATE TEMP TABLE tmp_universal_lead_questionnaire_seed (
  id UUID NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  input_type TEXT NOT NULL,
  options JSONB NOT NULL,
  is_required BOOLEAN NOT NULL,
  display_order INTEGER NOT NULL,
  section_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  group_label TEXT NOT NULL,
  group_order INTEGER NOT NULL,
  parent_key TEXT,
  parent_option_value TEXT
) ON COMMIT DROP;

INSERT INTO tmp_universal_lead_questionnaire_seed (
  id,
  key,
  label,
  input_type,
  options,
  is_required,
  display_order,
  section_key,
  group_key,
  group_label,
  group_order,
  parent_key,
  parent_option_value
)
  VALUES
    ('40000000-0000-4000-8000-000000000001'::uuid, 'bid_due_date', 'Bid Due Date', 'date', '[]'::jsonb, true, 100, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000002'::uuid, 'budget', 'Budget', 'currency', '[]'::jsonb, true, 200, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000003'::uuid, 'number_of_bidders', 'Number of Bidders', 'number', '[]'::jsonb, false, 300, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000004'::uuid, 'client_bid_portal_requirements', 'Client Bid Portal / Bid Format Requirements', 'textarea', '[]'::jsonb, true, 400, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000006'::uuid, 'timeline', 'Timeline', 'textarea', '[]'::jsonb, true, 500, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000007'::uuid, 'client_provided_docs', 'Client Provided Docs (Plans, Scope, Specs)', 'textarea', '[]'::jsonb, false, 600, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000008'::uuid, 'project_permitted', 'Is this project Permitted', 'boolean', '[]'::jsonb, true, 700, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000009'::uuid, 'market_type', 'Market Type', 'select', '[{"value":"market_rate","label":"Market Rate"},{"value":"student_housing","label":"Student Housing"},{"value":"senior_living","label":"Senior Living"},{"value":"lihtc","label":"LIHTC"}]'::jsonb, true, 800, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),
    ('40000000-0000-4000-8000-000000000010'::uuid, 'life_safety', 'Life Safety', 'textarea', '[]'::jsonb, true, 900, 'baseline', 'baseline', 'Universal Baseline', 0, NULL, NULL),

    ('50000000-0000-4000-8000-000000001000'::uuid, 'building_type', 'Building Type', 'select', '[{"value":"garden_style","label":"Garden Style"},{"value":"midrise","label":"Midrise"},{"value":"highrise","label":"Highrise"}]'::jsonb, true, 1000, 'property', 'property', 'Property/Building Info', 0, NULL, NULL),
    ('50000000-0000-4000-8000-000000001100'::uuid, 'number_of_buildings', 'Number of Buildings', 'number', '[]'::jsonb, true, 1100, 'property', 'property', 'Property/Building Info', 0, NULL, NULL),
    ('50000000-0000-4000-8000-000000001200'::uuid, 'number_of_stories', 'Number of Stories', 'number', '[]'::jsonb, true, 1200, 'property', 'property', 'Property/Building Info', 0, NULL, NULL),
    ('50000000-0000-4000-8000-000000001300'::uuid, 'site_access', 'Access', 'textarea', '[]'::jsonb, true, 1300, 'property', 'property', 'Property/Building Info', 0, NULL, NULL),
    ('50000000-0000-4000-8000-000000001400'::uuid, 'number_of_units', 'Number of Units', 'number', '[]'::jsonb, true, 1400, 'property', 'property', 'Property/Building Info', 0, NULL, NULL),
    ('50000000-0000-4000-8000-000000001500'::uuid, 'courtyards', 'Courtyards', 'select', '[{"value":"enclosed","label":"Enclosed"},{"value":"wrapped","label":"Wrapped"},{"value":"other","label":"Other"}]'::jsonb, true, 1500, 'property', 'property', 'Property/Building Info', 0, NULL, NULL),
    ('50000000-0000-4000-8000-000000001510'::uuid, 'courtyards_other_detail', 'Courtyard Detail', 'text', '[]'::jsonb, true, 1510, 'property', 'property', 'Property/Building Info', 0, 'courtyards', 'other'),

    ('60000000-0000-4000-8000-000000000100'::uuid, 'roofing_applies', 'Does roofing scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'roofing', 'Roofing', 1, NULL, NULL),
    ('60000000-0000-4000-8000-000000000101'::uuid, 'roof_type', 'Roof Type', 'text', '[]'::jsonb, true, 1, 'scope', 'roofing', 'Roofing', 1, 'roofing_applies', 'true'),
    ('60000000-0000-4000-8000-000000000102'::uuid, 'roof_specs', 'Roof Specs', 'textarea', '[]'::jsonb, true, 2, 'scope', 'roofing', 'Roofing', 1, 'roofing_applies', 'true'),
    ('60000000-0000-4000-8000-000000000103'::uuid, 'gutters_downspouts', 'Gutters / Downspouts', 'boolean', '[]'::jsonb, true, 3, 'scope', 'roofing', 'Roofing', 1, 'roofing_applies', 'true'),
    ('60000000-0000-4000-8000-000000000104'::uuid, 'roofing_insurance_claim', 'Insurance Claim', 'boolean', '[]'::jsonb, true, 4, 'scope', 'roofing', 'Roofing', 1, 'roofing_applies', 'true'),
    ('60000000-0000-4000-8000-000000000105'::uuid, 'roofing_xactimate', 'Xactimate', 'boolean', '[]'::jsonb, true, 5, 'scope', 'roofing', 'Roofing', 1, 'roofing_insurance_claim', 'true'),

    ('60000000-0000-4000-8000-000000000200'::uuid, 'exterior_paint_applies', 'Does exterior paint scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'exterior_paint', 'Exterior Paint', 2, NULL, NULL),
    ('60000000-0000-4000-8000-000000000201'::uuid, 'paint_metal', 'Metal', 'boolean', '[]'::jsonb, true, 1, 'scope', 'exterior_paint', 'Exterior Paint', 2, 'exterior_paint_applies', 'true'),
    ('60000000-0000-4000-8000-000000000202'::uuid, 'paint_metal_scope', 'Metal Scope / Specs', 'textarea', '[]'::jsonb, true, 2, 'scope', 'exterior_paint', 'Exterior Paint', 2, 'paint_metal', 'true'),
    ('60000000-0000-4000-8000-000000000203'::uuid, 'paint_facade_repairs', 'Façade Repairs (Carpentry, Brick, Siding)', 'boolean', '[]'::jsonb, true, 3, 'scope', 'exterior_paint', 'Exterior Paint', 2, 'exterior_paint_applies', 'true'),
    ('60000000-0000-4000-8000-000000000204'::uuid, 'paint_facade_repairs_scope', 'Façade Repairs Scope / Specs', 'textarea', '[]'::jsonb, true, 4, 'scope', 'exterior_paint', 'Exterior Paint', 2, 'paint_facade_repairs', 'true'),
    ('60000000-0000-4000-8000-000000000205'::uuid, 'paint_doors_breezeways', 'Doors and Breezeways', 'boolean', '[]'::jsonb, true, 5, 'scope', 'exterior_paint', 'Exterior Paint', 2, 'exterior_paint_applies', 'true'),
    ('60000000-0000-4000-8000-000000000206'::uuid, 'paint_doors_breezeways_scope', 'Doors and Breezeways Scope / Specs', 'textarea', '[]'::jsonb, true, 6, 'scope', 'exterior_paint', 'Exterior Paint', 2, 'paint_doors_breezeways', 'true'),

    ('60000000-0000-4000-8000-000000000300'::uuid, 'parking_lot_applies', 'Does parking lot scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'parking_lot', 'Parking Lot', 3, NULL, NULL),
    ('60000000-0000-4000-8000-000000000301'::uuid, 'parking_surface_type', 'Concrete or Asphalt', 'multiselect', '[{"value":"concrete","label":"Concrete"},{"value":"asphalt","label":"Asphalt"}]'::jsonb, true, 1, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_lot_applies', 'true'),
    ('60000000-0000-4000-8000-000000000302'::uuid, 'parking_seal_coat', 'Seal Coat', 'boolean', '[]'::jsonb, true, 2, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_lot_applies', 'true'),
    ('60000000-0000-4000-8000-000000000303'::uuid, 'parking_seal_coat_scope', 'Seal Coat Scope / Specs', 'textarea', '[]'::jsonb, true, 3, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_seal_coat', 'true'),
    ('60000000-0000-4000-8000-000000000304'::uuid, 'parking_restripe', 'Restripe', 'boolean', '[]'::jsonb, true, 4, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_lot_applies', 'true'),
    ('60000000-0000-4000-8000-000000000305'::uuid, 'parking_restripe_scope', 'Restripe Scope / Specs', 'textarea', '[]'::jsonb, true, 5, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_restripe', 'true'),
    ('60000000-0000-4000-8000-000000000306'::uuid, 'parking_spot_repairs', 'Spot Repairs', 'boolean', '[]'::jsonb, true, 6, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_lot_applies', 'true'),
    ('60000000-0000-4000-8000-000000000307'::uuid, 'parking_spot_repairs_scope', 'Spot Repairs Scope / Specs', 'textarea', '[]'::jsonb, true, 7, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_spot_repairs', 'true'),
    ('60000000-0000-4000-8000-000000000308'::uuid, 'parking_overlay', 'Overlay', 'boolean', '[]'::jsonb, true, 8, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_lot_applies', 'true'),
    ('60000000-0000-4000-8000-000000000309'::uuid, 'parking_overlay_scope', 'Overlay Scope / Specs', 'textarea', '[]'::jsonb, true, 9, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_overlay', 'true'),
    ('60000000-0000-4000-8000-000000000310'::uuid, 'parking_curb_repairs', 'Curb Repairs', 'boolean', '[]'::jsonb, true, 10, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_lot_applies', 'true'),
    ('60000000-0000-4000-8000-000000000311'::uuid, 'parking_curb_repairs_scope', 'Curb Repairs Scope / Specs', 'textarea', '[]'::jsonb, true, 11, 'scope', 'parking_lot', 'Parking Lot', 3, 'parking_curb_repairs', 'true'),

    ('60000000-0000-4000-8000-000000000400'::uuid, 'balconies_applies', 'Does balcony scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'balconies', 'Balconies', 4, NULL, NULL),
    ('60000000-0000-4000-8000-000000000401'::uuid, 'balcony_type', 'Balcony Type', 'select', '[{"value":"concrete_cantilever","label":"Concrete Cantilever"},{"value":"post_tensioned","label":"Post-Tensioned"},{"value":"other","label":"Other"}]'::jsonb, true, 1, 'scope', 'balconies', 'Balconies', 4, 'balconies_applies', 'true'),
    ('60000000-0000-4000-8000-000000000402'::uuid, 'balcony_type_other_detail', 'Balcony Type Detail', 'text', '[]'::jsonb, true, 2, 'scope', 'balconies', 'Balconies', 4, 'balcony_type', 'other'),
    ('60000000-0000-4000-8000-000000000403'::uuid, 'balcony_deficiencies', 'Clarification of Deficiency', 'multiselect', '[{"value":"water_intrusion","label":"Water Intrusion"},{"value":"structural","label":"Structural"},{"value":"cosmetic","label":"Cosmetic"}]'::jsonb, true, 3, 'scope', 'balconies', 'Balconies', 4, 'balconies_applies', 'true'),
    ('60000000-0000-4000-8000-000000000404'::uuid, 'balcony_count', 'How Many Balconies', 'number', '[]'::jsonb, true, 4, 'scope', 'balconies', 'Balconies', 4, 'balconies_applies', 'true'),

    ('60000000-0000-4000-8000-000000000500'::uuid, 'water_intrusion_applies', 'Does water intrusion scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'water_intrusion', 'Water Intrusion', 5, NULL, NULL),
    ('60000000-0000-4000-8000-000000000501'::uuid, 'leak_locations', 'Locations of Leak', 'textarea', '[]'::jsonb, true, 1, 'scope', 'water_intrusion', 'Water Intrusion', 5, 'water_intrusion_applies', 'true'),
    ('60000000-0000-4000-8000-000000000502'::uuid, 'number_of_leaks', 'Number of Leaks', 'number', '[]'::jsonb, true, 2, 'scope', 'water_intrusion', 'Water Intrusion', 5, 'water_intrusion_applies', 'true'),
    ('60000000-0000-4000-8000-000000000503'::uuid, 'leak_cause', 'Cause of Leak', 'textarea', '[]'::jsonb, true, 3, 'scope', 'water_intrusion', 'Water Intrusion', 5, 'water_intrusion_applies', 'true'),

    ('60000000-0000-4000-8000-000000000600'::uuid, 'windows_doors_applies', 'Does windows and doors scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'windows_doors', 'Windows and Doors', 6, NULL, NULL),
    ('60000000-0000-4000-8000-000000000601'::uuid, 'facade_type', 'Façade Type', 'select', '[{"value":"brick","label":"Brick"},{"value":"stucco","label":"Stucco"},{"value":"eifs","label":"EIFS"},{"value":"siding","label":"Siding"},{"value":"other","label":"Other"}]'::jsonb, true, 1, 'scope', 'windows_doors', 'Windows and Doors', 6, 'windows_doors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000602'::uuid, 'facade_type_other_detail', 'Façade Type Detail', 'text', '[]'::jsonb, true, 2, 'scope', 'windows_doors', 'Windows and Doors', 6, 'facade_type', 'other'),
    ('60000000-0000-4000-8000-000000000603'::uuid, 'full_property_replacement', 'Full Property Replacement', 'boolean', '[]'::jsonb, true, 3, 'scope', 'windows_doors', 'Windows and Doors', 6, 'windows_doors_applies', 'true'),

    ('60000000-0000-4000-8000-000000000700'::uuid, 'unit_upgrades_applies', 'Does unit upgrades scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, NULL, NULL),
    ('60000000-0000-4000-8000-000000000701'::uuid, 'unit_upgrades_number_of_units', 'Number of Units', 'number', '[]'::jsonb, true, 1, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, 'unit_upgrades_applies', 'true'),
    ('60000000-0000-4000-8000-000000000702'::uuid, 'unit_upgrades_number_executed', 'Number of Units Executed', 'number', '[]'::jsonb, true, 2, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, 'unit_upgrades_applies', 'true'),
    ('60000000-0000-4000-8000-000000000703'::uuid, 'unit_upgrades_unit_matrix', 'Number of Units by Type (Unit Matrix)', 'textarea', '[]'::jsonb, true, 3, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, 'unit_upgrades_applies', 'true'),
    ('60000000-0000-4000-8000-000000000704'::uuid, 'unit_upgrades_cost_per_unit', 'Cost per Unit / Average Budget', 'currency', '[]'::jsonb, true, 4, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, 'unit_upgrades_applies', 'true'),
    ('60000000-0000-4000-8000-000000000705'::uuid, 'unit_upgrades_scope_specs', 'Scope and Specs', 'textarea', '[]'::jsonb, true, 5, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, 'unit_upgrades_applies', 'true'),
    ('60000000-0000-4000-8000-000000000706'::uuid, 'unit_upgrades_renewals', 'Renewals or Non-renewals', 'text', '[]'::jsonb, true, 6, 'scope', 'unit_upgrades', 'Unit Upgrades', 7, 'unit_upgrades_applies', 'true'),

    ('60000000-0000-4000-8000-000000000800'::uuid, 'corridors_applies', 'Does corridor scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'corridors', 'Corridors', 8, NULL, NULL),
    ('60000000-0000-4000-8000-000000000801'::uuid, 'corridor_number_of_doors', 'Number of Doors', 'number', '[]'::jsonb, true, 1, 'scope', 'corridors', 'Corridors', 8, 'corridors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000802'::uuid, 'corridor_closed_open_air', 'Closed or Open Air', 'select', '[{"value":"closed","label":"Closed"},{"value":"open_air","label":"Open Air"}]'::jsonb, true, 2, 'scope', 'corridors', 'Corridors', 8, 'corridors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000803'::uuid, 'corridor_color_change', 'Color Change', 'boolean', '[]'::jsonb, true, 3, 'scope', 'corridors', 'Corridors', 8, 'corridors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000804'::uuid, 'corridor_lighting', 'Lighting', 'boolean', '[]'::jsonb, true, 4, 'scope', 'corridors', 'Corridors', 8, 'corridors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000805'::uuid, 'corridor_lighting_count', 'Lighting Count', 'number', '[]'::jsonb, true, 5, 'scope', 'corridors', 'Corridors', 8, 'corridor_lighting', 'true'),
    ('60000000-0000-4000-8000-000000000806'::uuid, 'corridor_lighting_provided_by_client', 'Lights Provided by Client', 'boolean', '[]'::jsonb, true, 6, 'scope', 'corridors', 'Corridors', 8, 'corridor_lighting', 'true'),
    ('60000000-0000-4000-8000-000000000807'::uuid, 'corridor_flooring_type', 'Flooring Type', 'select', '[{"value":"carpet","label":"Carpet"},{"value":"lvp","label":"LVP"},{"value":"tile","label":"Tile"},{"value":"concrete","label":"Concrete"},{"value":"other","label":"Other"}]'::jsonb, true, 7, 'scope', 'corridors', 'Corridors', 8, 'corridors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000808'::uuid, 'corridor_flooring_type_other_detail', 'Flooring Type Detail', 'text', '[]'::jsonb, true, 8, 'scope', 'corridors', 'Corridors', 8, 'corridor_flooring_type', 'other'),
    ('60000000-0000-4000-8000-000000000809'::uuid, 'corridor_stairwells', 'Stairwells', 'boolean', '[]'::jsonb, true, 9, 'scope', 'corridors', 'Corridors', 8, 'corridors_applies', 'true'),
    ('60000000-0000-4000-8000-000000000810'::uuid, 'corridor_stairwells_scope', 'Stairwells Scope / Specs', 'textarea', '[]'::jsonb, true, 10, 'scope', 'corridors', 'Corridors', 8, 'corridor_stairwells', 'true'),

    ('60000000-0000-4000-8000-000000000900'::uuid, 'exterior_amenities_applies', 'Does exterior amenities scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, NULL, NULL),
    ('60000000-0000-4000-8000-000000000901'::uuid, 'amenity_pool', '[Review with estimators] Pool / Spa', 'boolean', '[]'::jsonb, true, 1, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000902'::uuid, 'amenity_pool_scope', '[Review with estimators] Pool / Spa Scope / Specs', 'textarea', '[]'::jsonb, true, 2, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_pool', 'true'),
    ('60000000-0000-4000-8000-000000000903'::uuid, 'amenity_gates_fencing', '[Review with estimators] Gates / Fencing', 'boolean', '[]'::jsonb, true, 3, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000904'::uuid, 'amenity_gates_fencing_scope', '[Review with estimators] Gates / Fencing Scope / Specs', 'textarea', '[]'::jsonb, true, 4, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_gates_fencing', 'true'),
    ('60000000-0000-4000-8000-000000000905'::uuid, 'amenity_dumpster_enclosures', '[Review with estimators] Dumpster Enclosures', 'boolean', '[]'::jsonb, true, 5, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000906'::uuid, 'amenity_dumpster_enclosures_scope', '[Review with estimators] Dumpster Enclosures Scope / Specs', 'textarea', '[]'::jsonb, true, 6, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_dumpster_enclosures', 'true'),
    ('60000000-0000-4000-8000-000000000907'::uuid, 'amenity_mailbox_kiosks', '[Review with estimators] Mailbox Kiosks', 'boolean', '[]'::jsonb, true, 7, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000908'::uuid, 'amenity_mailbox_kiosks_scope', '[Review with estimators] Mailbox Kiosks Scope / Specs', 'textarea', '[]'::jsonb, true, 8, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_mailbox_kiosks', 'true'),
    ('60000000-0000-4000-8000-000000000909'::uuid, 'amenity_outdoor_lighting', '[Review with estimators] Outdoor Lighting', 'boolean', '[]'::jsonb, true, 9, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000910'::uuid, 'amenity_outdoor_lighting_scope', '[Review with estimators] Outdoor Lighting Scope / Specs', 'textarea', '[]'::jsonb, true, 10, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_outdoor_lighting', 'true'),
    ('60000000-0000-4000-8000-000000000911'::uuid, 'amenity_signage', '[Review with estimators] Signage', 'boolean', '[]'::jsonb, true, 11, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000912'::uuid, 'amenity_signage_scope', '[Review with estimators] Signage Scope / Specs', 'textarea', '[]'::jsonb, true, 12, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_signage', 'true'),
    ('60000000-0000-4000-8000-000000000913'::uuid, 'amenity_clubhouse_exterior', '[Review with estimators] Clubhouse / Leasing Office Exterior', 'boolean', '[]'::jsonb, true, 13, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000914'::uuid, 'amenity_clubhouse_exterior_scope', '[Review with estimators] Clubhouse Exterior Scope / Specs', 'textarea', '[]'::jsonb, true, 14, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_clubhouse_exterior', 'true'),
    ('60000000-0000-4000-8000-000000000915'::uuid, 'amenity_sport_courts', '[Review with estimators] Sport Courts (Tennis / Pickleball / Basketball)', 'boolean', '[]'::jsonb, true, 15, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000916'::uuid, 'amenity_sport_courts_scope', '[Review with estimators] Sport Courts Scope / Specs', 'textarea', '[]'::jsonb, true, 16, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_sport_courts', 'true'),
    ('60000000-0000-4000-8000-000000000917'::uuid, 'amenity_playground', '[Review with estimators] Playground', 'boolean', '[]'::jsonb, true, 17, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'exterior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000000918'::uuid, 'amenity_playground_scope', '[Review with estimators] Playground Scope / Specs', 'textarea', '[]'::jsonb, true, 18, 'scope', 'exterior_amenities', 'Exterior Amenities', 9, 'amenity_playground', 'true'),

    ('60000000-0000-4000-8000-000000001000'::uuid, 'interior_amenities_applies', 'Does interior amenities scope apply?', 'boolean', '[]'::jsonb, false, 0, 'scope', 'interior_amenities', 'Interior Amenities', 10, NULL, NULL),
    ('60000000-0000-4000-8000-000000001001'::uuid, 'interior_amenity_clubhouse', '[Review with estimators] Clubhouse / Leasing Office Interior', 'boolean', '[]'::jsonb, true, 1, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001002'::uuid, 'interior_amenity_clubhouse_scope', '[Review with estimators] Clubhouse Interior Scope / Specs', 'textarea', '[]'::jsonb, true, 2, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_clubhouse', 'true'),
    ('60000000-0000-4000-8000-000000001003'::uuid, 'interior_amenity_fitness', '[Review with estimators] Fitness Center / Gym', 'boolean', '[]'::jsonb, true, 3, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001004'::uuid, 'interior_amenity_fitness_scope', '[Review with estimators] Fitness Center Scope / Specs', 'textarea', '[]'::jsonb, true, 4, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_fitness', 'true'),
    ('60000000-0000-4000-8000-000000001005'::uuid, 'interior_amenity_lounge', '[Review with estimators] Game Room / Lounge', 'boolean', '[]'::jsonb, true, 5, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001006'::uuid, 'interior_amenity_lounge_scope', '[Review with estimators] Lounge Scope / Specs', 'textarea', '[]'::jsonb, true, 6, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_lounge', 'true'),
    ('60000000-0000-4000-8000-000000001007'::uuid, 'interior_amenity_business_center', '[Review with estimators] Business Center / Co-working', 'boolean', '[]'::jsonb, true, 7, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001008'::uuid, 'interior_amenity_business_center_scope', '[Review with estimators] Business Center Scope / Specs', 'textarea', '[]'::jsonb, true, 8, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_business_center', 'true'),
    ('60000000-0000-4000-8000-000000001009'::uuid, 'interior_amenity_theater', '[Review with estimators] Theater / Media Room', 'boolean', '[]'::jsonb, true, 9, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001010'::uuid, 'interior_amenity_theater_scope', '[Review with estimators] Theater Scope / Specs', 'textarea', '[]'::jsonb, true, 10, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_theater', 'true'),
    ('60000000-0000-4000-8000-000000001011'::uuid, 'interior_amenity_kids_play', '[Review with estimators] Kids'' Play Area', 'boolean', '[]'::jsonb, true, 11, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001012'::uuid, 'interior_amenity_kids_play_scope', '[Review with estimators] Kids'' Play Area Scope / Specs', 'textarea', '[]'::jsonb, true, 12, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_kids_play', 'true'),
    ('60000000-0000-4000-8000-000000001013'::uuid, 'interior_amenity_common_baths', '[Review with estimators] Common Area Restrooms', 'boolean', '[]'::jsonb, true, 13, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001014'::uuid, 'interior_amenity_common_baths_scope', '[Review with estimators] Common Area Restrooms Scope / Specs', 'textarea', '[]'::jsonb, true, 14, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_common_baths', 'true'),
    ('60000000-0000-4000-8000-000000001015'::uuid, 'interior_amenity_kitchen_catering', '[Review with estimators] Kitchen / Catering Area', 'boolean', '[]'::jsonb, true, 15, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenities_applies', 'true'),
    ('60000000-0000-4000-8000-000000001016'::uuid, 'interior_amenity_kitchen_catering_scope', '[Review with estimators] Kitchen / Catering Scope / Specs', 'textarea', '[]'::jsonb, true, 16, 'scope', 'interior_amenities', 'Interior Amenities', 10, 'interior_amenity_kitchen_catering', 'true');

WITH seed AS (
  SELECT DISTINCT ON (key) *
  FROM tmp_universal_lead_questionnaire_seed
  ORDER BY key, display_order, id
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
  is_active,
  section_key,
  group_key,
  group_label,
  group_order,
  created_at,
  updated_at
)
SELECT
  seed.id,
  NULL,
  NULL,
  seed.parent_option_value,
  'question',
  seed.key,
  seed.label,
  NULL,
  seed.input_type,
  seed.options,
  seed.is_required,
  seed.display_order,
  true,
  seed.section_key,
  seed.group_key,
  seed.group_label,
  seed.group_order,
  now(),
  now()
FROM seed
WHERE NOT EXISTS (
  SELECT 1
  FROM public.project_type_question_nodes existing
  WHERE existing.project_type_id IS NULL
    AND existing.key = seed.key
);

WITH seed AS (
  SELECT DISTINCT ON (key) *
  FROM tmp_universal_lead_questionnaire_seed
  ORDER BY key, display_order, id
)
UPDATE public.project_type_question_nodes AS target
SET
  label = seed.label,
  prompt = NULL,
  input_type = seed.input_type,
  options = seed.options,
  is_required = seed.is_required,
  display_order = seed.display_order,
  is_active = true,
  section_key = seed.section_key,
  group_key = seed.group_key,
  group_label = seed.group_label,
  group_order = seed.group_order,
  parent_option_value = seed.parent_option_value,
  updated_at = now()
FROM seed
WHERE target.project_type_id IS NULL
  AND target.key = seed.key;

WITH seed AS (
  SELECT DISTINCT ON (key) *
  FROM tmp_universal_lead_questionnaire_seed
  ORDER BY key, display_order, id
)
UPDATE public.project_type_question_nodes AS child
SET
  parent_node_id = NULL,
  parent_option_value = NULL,
  updated_at = now()
FROM seed
WHERE child.project_type_id IS NULL
  AND child.key = seed.key
  AND seed.parent_key IS NULL
  AND (child.parent_node_id IS NOT NULL OR child.parent_option_value IS NOT NULL);

WITH seed AS (
  SELECT DISTINCT ON (key) *
  FROM tmp_universal_lead_questionnaire_seed
  ORDER BY key, display_order, id
)
UPDATE public.project_type_question_nodes AS child
SET
  parent_node_id = parent.id,
  parent_option_value = seed.parent_option_value,
  updated_at = now()
FROM seed
JOIN public.project_type_question_nodes AS parent
  ON parent.project_type_id IS NULL
  AND parent.key = seed.parent_key
WHERE child.project_type_id IS NULL
  AND child.key = seed.key
  AND seed.parent_key IS NOT NULL
  AND (child.parent_node_id IS DISTINCT FROM parent.id
       OR child.parent_option_value IS DISTINCT FROM seed.parent_option_value);

DROP TABLE IF EXISTS tmp_universal_lead_questionnaire_seed;
