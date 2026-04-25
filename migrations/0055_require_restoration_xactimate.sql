-- Migration 0055: make restoration Xactimate follow-up required when revealed
-- The restoration cascade expects Insurance Claim = true to reveal a required Xactimate answer.

UPDATE public.project_type_question_nodes AS node
SET
  is_required = true,
  updated_at = NOW()
FROM public.project_type_config AS project_type
WHERE node.project_type_id = project_type.id
  AND project_type.slug = 'restoration'
  AND node.key = 'xactimate'
  AND node.is_required IS DISTINCT FROM true;
