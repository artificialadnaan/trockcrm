CREATE TABLE IF NOT EXISTS public.geocoding_cache (
  latitude numeric(8,5) NOT NULL,
  longitude numeric(9,5) NOT NULL,
  address text,
  formatted_components jsonb,
  cached_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL DEFAULT 'google_geocoding',
  PRIMARY KEY (latitude, longitude, provider)
);

CREATE INDEX IF NOT EXISTS geocoding_cache_cached_at_idx
  ON public.geocoding_cache(cached_at);
