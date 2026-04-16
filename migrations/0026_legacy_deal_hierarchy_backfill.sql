-- Migration 0026: Legacy deal hierarchy backfill
-- Re-links historical post-RFP deals into the company/property/lead hierarchy
-- after older promotion flows left company_id / property_id / source_lead_id null.

DO $$
DECLARE
  office_schema text;
  converted_stage_id uuid;
  deal_row record;
  created_property_id uuid;
  created_lead_id uuid;
BEGIN
  SELECT id
  INTO converted_stage_id
  FROM public.pipeline_stage_config
  WHERE workflow_family = 'lead'
    AND slug = 'converted'
  LIMIT 1;

  FOR office_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'deals'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'contacts'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'companies'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'properties'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'leads'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'contact_deal_associations'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS legacy_property_key text',
        office_schema
      );

      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS properties_legacy_property_key_uidx
           ON %I.properties (legacy_property_key)',
        office_schema
      );

      EXECUTE format($sql$
        UPDATE %I.contacts c
        SET company_id = company_match.id
        FROM %I.companies company_match
        WHERE c.company_id IS NULL
          AND c.company_name IS NOT NULL
          AND btrim(c.company_name) <> ''
          AND lower(btrim(c.company_name)) = lower(btrim(company_match.name))
      $sql$, office_schema, office_schema);

      EXECUTE format($sql$
        WITH candidates AS (
          SELECT
            cda.deal_id,
            MIN(cda.contact_id) AS contact_id
          FROM %I.contact_deal_associations cda
          JOIN %I.contacts c ON c.id = cda.contact_id
          WHERE c.is_active = true
          GROUP BY cda.deal_id
          HAVING COUNT(DISTINCT cda.contact_id) = 1
        )
        UPDATE %I.deals d
        SET primary_contact_id = candidates.contact_id
        FROM candidates
        WHERE d.id = candidates.deal_id
          AND d.primary_contact_id IS NULL
      $sql$, office_schema, office_schema, office_schema);

      EXECUTE format($sql$
        WITH association_companies AS (
          SELECT
            cda.deal_id,
            MIN(c.company_id) AS company_id
          FROM %I.contact_deal_associations cda
          JOIN %I.contacts c ON c.id = cda.contact_id
          WHERE c.is_active = true
            AND c.company_id IS NOT NULL
          GROUP BY cda.deal_id
          HAVING COUNT(DISTINCT c.company_id) = 1
        ),
        candidates AS (
          SELECT
            d.id AS deal_id,
            COALESCE(primary_contact.company_id, association_companies.company_id) AS company_id
          FROM %I.deals d
          LEFT JOIN %I.contacts primary_contact
            ON primary_contact.id = d.primary_contact_id
           AND primary_contact.is_active = true
          LEFT JOIN association_companies
            ON association_companies.deal_id = d.id
          WHERE d.company_id IS NULL
        )
        UPDATE %I.deals d
        SET company_id = candidates.company_id
        FROM candidates
        WHERE d.id = candidates.deal_id
          AND d.company_id IS NULL
          AND candidates.company_id IS NOT NULL
      $sql$, office_schema, office_schema, office_schema, office_schema, office_schema);

      FOR deal_row IN EXECUTE format(
        'SELECT
           id AS deal_id,
           company_id,
           deal_number,
           name,
           property_address,
           property_city,
           property_state,
           property_zip,
           created_at
         FROM %I.deals
         WHERE company_id IS NOT NULL
           AND property_id IS NULL
         ORDER BY created_at ASC',
        office_schema
      )
      LOOP
        EXECUTE format($sql$
          INSERT INTO %I.properties (
            company_id,
            name,
            address,
            city,
            state,
            zip,
            is_active,
            created_at,
            updated_at,
            legacy_property_key
          ) VALUES ($1,$2,$3,$4,$5,$6,true,COALESCE($7,NOW()),NOW(),$8)
          ON CONFLICT (legacy_property_key) DO UPDATE
          SET company_id = EXCLUDED.company_id,
              name = EXCLUDED.name,
              address = COALESCE(EXCLUDED.address, properties.address),
              city = COALESCE(EXCLUDED.city, properties.city),
              state = COALESCE(EXCLUDED.state, properties.state),
              zip = COALESCE(EXCLUDED.zip, properties.zip),
              updated_at = NOW()
          RETURNING id
        $sql$, office_schema)
        INTO created_property_id
        USING
          deal_row.company_id,
          LEFT(
            COALESCE(
              NULLIF(BTRIM(deal_row.property_address), ''),
              NULLIF(BTRIM(deal_row.name), ''),
              'Legacy Property ' || deal_row.deal_number
            ),
            500
          ),
          NULLIF(BTRIM(deal_row.property_address), ''),
          NULLIF(BTRIM(deal_row.property_city), ''),
          NULLIF(BTRIM(deal_row.property_state), ''),
          NULLIF(BTRIM(deal_row.property_zip), ''),
          deal_row.created_at,
          format('legacy:%s', deal_row.deal_id);

        EXECUTE format(
          'UPDATE %I.deals SET property_id = $1 WHERE id = $2 AND property_id IS NULL',
          office_schema
        )
        USING created_property_id, deal_row.deal_id;
      END LOOP;

      IF converted_stage_id IS NOT NULL THEN
        FOR deal_row IN EXECUTE format(
          'SELECT
             id AS deal_id,
             company_id,
             property_id,
             primary_contact_id,
             name,
             assigned_rep_id,
             source,
             description,
             last_activity_at,
             stage_entered_at,
             created_at
           FROM %I.deals
           WHERE source_lead_id IS NULL
             AND company_id IS NOT NULL
             AND property_id IS NOT NULL
           ORDER BY created_at ASC',
          office_schema
        )
        LOOP
          EXECUTE format($sql$
            INSERT INTO %I.leads (
              company_id,
              property_id,
              primary_contact_id,
              name,
              stage_id,
              assigned_rep_id,
              status,
              source,
              description,
              last_activity_at,
              stage_entered_at,
              converted_at,
              is_active,
              created_at,
              updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,
              'converted',$7,$8,$9,
              COALESCE($10,$11,NOW()),
              COALESCE($9,$11,NOW()),
              false,
              COALESCE($11,NOW()),
              NOW()
            )
            RETURNING id
          $sql$, office_schema)
          INTO created_lead_id
          USING
            deal_row.company_id,
            deal_row.property_id,
            deal_row.primary_contact_id,
            LEFT(COALESCE(NULLIF(BTRIM(deal_row.name), ''), 'Legacy Lead'), 500),
            converted_stage_id,
            deal_row.assigned_rep_id,
            deal_row.source,
            deal_row.description,
            deal_row.last_activity_at,
            deal_row.stage_entered_at,
            deal_row.created_at;

          EXECUTE format(
            'UPDATE %I.deals SET source_lead_id = $1 WHERE id = $2 AND source_lead_id IS NULL',
            office_schema
          )
          USING created_lead_id, deal_row.deal_id;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
END $$;
