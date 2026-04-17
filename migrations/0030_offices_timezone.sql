-- Migration 0030: Add office timezone storage

ALTER TABLE public.offices
  ADD COLUMN IF NOT EXISTS timezone varchar(100) NOT NULL DEFAULT 'America/Chicago';
