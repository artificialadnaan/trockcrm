ALTER TABLE public.project_type_question_nodes
  ADD COLUMN IF NOT EXISTS section_key TEXT,
  ADD COLUMN IF NOT EXISTS group_key TEXT,
  ADD COLUMN IF NOT EXISTS group_label TEXT,
  ADD COLUMN IF NOT EXISTS group_order INTEGER;

CREATE INDEX IF NOT EXISTS idx_pt_question_nodes_section_group
  ON public.project_type_question_nodes (section_key, group_key, group_order);

CREATE UNIQUE INDEX IF NOT EXISTS project_type_question_nodes_universal_key_uidx
  ON public.project_type_question_nodes (key)
  WHERE project_type_id IS NULL;
