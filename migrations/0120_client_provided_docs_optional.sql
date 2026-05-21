-- Client Provided Docs remains uploadable on the lead form, but it should not
-- block advancement into Sales Validation when stale questionnaire rows still
-- mark it as required.
UPDATE public.project_type_question_nodes
SET is_required = false,
    updated_at = now()
WHERE key = 'client_provided_docs'
  AND project_type_id IS NULL
  AND is_required = true;
