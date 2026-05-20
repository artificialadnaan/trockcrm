ALTER TABLE public.user_graph_tokens
  ADD COLUMN IF NOT EXISTS last_inbox_delta_link text,
  ADD COLUMN IF NOT EXISTS last_sent_delta_link text,
  ADD COLUMN IF NOT EXISTS last_inbox_sync_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_sent_sync_at timestamptz NULL;

UPDATE public.user_graph_tokens
SET last_inbox_delta_link = last_delta_link
WHERE last_delta_link IS NOT NULL
  AND last_inbox_delta_link IS NULL;
