DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.deals
          ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

        ALTER TABLE %1$I.leads
          ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

        CREATE TABLE IF NOT EXISTS %1$I.deal_subscriptions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id uuid NOT NULL REFERENCES %1$I.deals(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS deal_subscriptions_deal_user_uidx
          ON %1$I.deal_subscriptions (deal_id, user_id);

        CREATE INDEX IF NOT EXISTS deal_subscriptions_user_idx
          ON %1$I.deal_subscriptions (user_id, deleted_at);

        CREATE TABLE IF NOT EXISTS %1$I.lead_subscriptions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          lead_id uuid NOT NULL REFERENCES %1$I.leads(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS lead_subscriptions_lead_user_uidx
          ON %1$I.lead_subscriptions (lead_id, user_id);

        CREATE INDEX IF NOT EXISTS lead_subscriptions_user_idx
          ON %1$I.lead_subscriptions (user_id, deleted_at);
      $sql$,
      schema_name
    );
  END LOOP;
END
$tenant$;
