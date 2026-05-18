ALTER TYPE photo_audit_event_type ADD VALUE IF NOT EXISTS 'voice_description_transcribed';

CREATE TABLE IF NOT EXISTS photo_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID NOT NULL REFERENCES public.users(id),
  CONSTRAINT photo_tags_photo_id_tag_pk UNIQUE (photo_id, tag)
);

CREATE INDEX IF NOT EXISTS photo_tags_photo_idx ON photo_tags(photo_id);
CREATE INDEX IF NOT EXISTS photo_tags_tag_idx ON photo_tags(tag);
CREATE INDEX IF NOT EXISTS photo_tags_created_at_idx ON photo_tags(created_at DESC);
CREATE INDEX IF NOT EXISTS photo_tags_photo_created_idx ON photo_tags(photo_id, created_at DESC);
