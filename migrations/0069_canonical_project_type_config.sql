ALTER TABLE public.project_type_config
  ADD COLUMN IF NOT EXISTS code varchar(8);

UPDATE public.project_type_config
   SET is_active = false
 WHERE slug NOT IN (
   'exterior-renovation',
   'interior-renovation',
   'roofing',
   'service',
   'commercial',
   'hospitality',
   'emergency',
   'development',
   'residential'
 );

INSERT INTO public.project_type_config (name, slug, code, parent_id, display_order, is_active)
VALUES
  ('Exterior Renovation', 'exterior-renovation', '1', NULL, 1, true),
  ('Interior Renovation', 'interior-renovation', '2', NULL, 2, true),
  ('Roofing', 'roofing', '3', NULL, 3, true),
  ('Service', 'service', '4', NULL, 4, true),
  ('Commercial', 'commercial', '5', NULL, 5, true),
  ('Hospitality', 'hospitality', '6', NULL, 6, true),
  ('Emergency', 'emergency', '7', NULL, 7, true),
  ('Development', 'development', '8', NULL, 8, true),
  ('Residential', 'residential', '9', NULL, 9, true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  code = EXCLUDED.code,
  parent_id = NULL,
  display_order = EXCLUDED.display_order,
  is_active = true;
