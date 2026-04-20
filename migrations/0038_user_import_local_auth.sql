CREATE TYPE external_user_source AS ENUM ('hubspot', 'procore');

CREATE TABLE user_external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  source_system external_user_source NOT NULL,
  external_user_id varchar(255) NOT NULL,
  external_email varchar(255),
  external_display_name varchar(255),
  last_imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_external_identities_source_uidx
  ON user_external_identities(source_system, external_user_id);

CREATE TABLE user_local_auth (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  invite_sent_at timestamptz,
  invite_sent_by_user_id uuid,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
