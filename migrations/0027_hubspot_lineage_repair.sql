-- Migration 0027: HubSpot lineage repair
-- Repairs legacy deal primary contact / company linkage from promoted HubSpot
-- staging records when contact_deal_associations did not survive migration,
-- then re-runs synthesized property/lead creation for the newly linked deals.

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
        WITH staged_contact_candidates AS (
          SELECT
            d.id AS deal_id,
            (ARRAY_AGG(DISTINCT sc.promoted_contact_id ORDER BY sc.promoted_contact_id::text))[1] AS primary_contact_id
          FROM %I.deals d
          JOIN migration.staged_deals sd
            ON sd.promoted_deal_id = d.id
            OR (
              sd.promoted_deal_id IS NULL
              AND d.hubspot_deal_id IS NOT NULL
              AND sd.hubspot_deal_id = d.hubspot_deal_id
            )
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(sd.raw_data -> 'associations' -> 'contacts' -> 'results', '[]'::jsonb)
          ) AS assoc(item)
          JOIN migration.staged_contacts sc
            ON sc.hubspot_contact_id = assoc.item ->> 'id'
          WHERE sc.promoted_contact_id IS NOT NULL
          GROUP BY d.id
          HAVING COUNT(DISTINCT sc.promoted_contact_id) = 1
        )
        UPDATE %I.deals d
        SET primary_contact_id = candidates.primary_contact_id
        FROM staged_contact_candidates candidates
        WHERE d.id = candidates.deal_id
          AND d.primary_contact_id IS NULL
      $sql$, office_schema, office_schema);

      EXECUTE format($sql$
        WITH staged_company_candidates AS (
          SELECT
            d.id AS deal_id,
            (ARRAY_AGG(DISTINCT c.company_id ORDER BY c.company_id::text))[1] AS company_id
          FROM %I.deals d
          JOIN migration.staged_deals sd
            ON sd.promoted_deal_id = d.id
            OR (
              sd.promoted_deal_id IS NULL
              AND d.hubspot_deal_id IS NOT NULL
              AND sd.hubspot_deal_id = d.hubspot_deal_id
            )
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(sd.raw_data -> 'associations' -> 'contacts' -> 'results', '[]'::jsonb)
          ) AS assoc(item)
          JOIN migration.staged_contacts sc
            ON sc.hubspot_contact_id = assoc.item ->> 'id'
           AND sc.promoted_contact_id IS NOT NULL
          JOIN %I.contacts c
            ON c.id = sc.promoted_contact_id
           AND c.is_active = true
          WHERE c.company_id IS NOT NULL
          GROUP BY d.id
          HAVING COUNT(DISTINCT c.company_id) = 1
        ),
        candidates AS (
          SELECT
            d.id AS deal_id,
            COALESCE(primary_contact.company_id, staged_company_candidates.company_id) AS company_id
          FROM %I.deals d
          LEFT JOIN %I.contacts primary_contact
            ON primary_contact.id = d.primary_contact_id
           AND primary_contact.is_active = true
          LEFT JOIN staged_company_candidates
            ON staged_company_candidates.deal_id = d.id
          WHERE d.company_id IS NULL
        )
        UPDATE %I.deals d
        SET company_id = candidates.company_id
        FROM candidates
        WHERE d.id = candidates.deal_id
          AND d.company_id IS NULL
          AND candidates.company_id IS NOT NULL
      $sql$, office_schema, office_schema, office_schema, office_schema, office_schema, office_schema);

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
