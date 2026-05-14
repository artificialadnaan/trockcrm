# Life Safety Migration Log

Date: 2026-05-14  
Policy: preserve every non-empty free-text Life Safety answer in `public.lead_form_field_batch_life_safety_audit`, then convert stored answers to boolean JSON. Recognizable negative/not-applicable values (`no`, `n/a`, `na`, `none`, `not applicable`) become `false`; other non-empty values become `true` for manual review without blocking required-question gates.

Update: blank JSON string Life Safety answers are normalized to JSON `null` during the same tenant-schema pass. They are not written to the audit table because they contain no recoverable answer text; the `UPDATE` is idempotent because reruns no longer match `jsonb_typeof(value_json) = 'string'`.

## Discovery Counts

| Schema | Non-empty Life Safety free-text answers |
| --- | ---: |
| `office_atlanta` | 0 |
| `office_dallas` | 15 |
| `office_pwauditoffice` | 0 |

## Sample Values From Production

- `Smoke test answer`
- `standard access`
- `fdsa`
- `fsda`
- `sure`
- `NA`
- `N/A`
- `n/a`
- `no`
- `No`

## Migration Audit Destination

The migration will create and write to:

- `public.lead_form_field_batch_life_safety_audit`

Expected columns:

- `tenant_schema`
- `lead_id`
- `question_id`
- `original_value_json`
- `logged_at`

The audit table is the durable record of exact original values. This file records the discovery summary without embedding every production lead row.
