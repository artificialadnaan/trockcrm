-- Migration 0011: Add touchpoint_alert to notification_type enum
-- The notification_type enum lives in the public schema

DO $$
BEGIN
  ALTER TYPE public.notification_type ADD VALUE 'touchpoint_alert';
EXCEPTION WHEN duplicate_object THEN
  NULL; -- Already exists, skip
END $$;
