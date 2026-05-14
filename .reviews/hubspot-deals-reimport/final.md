# HubSpot Deals Re-Import Final

Date: 2026-05-14
Branch: `feat/hubspot-deals-reimport`

## Dry-run baseline

- CSV rows: `802`
- Active Dallas deals before apply: `801`
- Dry-run before apply:
  - `EXISTS_UNCHANGED`: `724`
  - `EXISTS_NEWER_IN_CSV`: `57`
  - `MISSING`: `19`
  - `AMBIGUOUS`: `0`
  - `SOFT_DELETED`: `2`
  - skipped field-clears under the non-destructive policy: `1` (`323528551136` / `Rayside Apartments` `project_type`)

## Policy decision applied

- Null/blank CSV values are treated as **no opinion** during updates.
- The reconciliation **never clears a non-null CRM field because the CSV is blank**.
- Concrete protected case:
  - `323528551136` / `Rayside Apartments`
  - preserved `project_type = 'roofing'`
  - still applied:
    - `amount: 700000.00 -> 1000001.01`
    - `deal_name: "Rayside Apartments Property" -> "Rayside Apartments"`

## Apply results

- Creates executed: `19`
- Real updates executed: `42`
- Timestamp-only updates skipped: `15`
- Soft-deleted deals left untouched: `2`
- Errors: `0`

### Created HubSpot Record IDs

```text
324441141968
324290152132
324283668202
324283670257
324441152235
324291439321
324840803038
324816322282
324940328678
324845105909
324845147845
324845154005
324817168103
324841644784
324845155013
324842371803
324845238976
324965692122
324965696186
```

### Updated HubSpot Record IDs

```text
34647608675
35751364370
35753414773
35753414993
36810838026
36810624568
37238223875
37634970686
38229449506
38286299824
38370146480
38547950995
38960329631
39329513574
39327730213
39900363374
40249383469
40789931894
40982044505
41045985061
41437971127
41540750658
43013818142
43156477601
43524436024
43514182455
43524436117
43660621859
43899073919
43948381353
173703281353
173499433676
194132514491
195160421089
202354957048
216534909689
221599584969
40832572577
257975707383
272705595119
323528551136
323517814463
```

### Timestamp-only update IDs intentionally skipped

```text
259776511728
259780904640
262368118502
264972024515
276777157317
288839537381
315770603207
315801099985
316634100467
316625530589
318904216306
323231764174
323527098093
324282042060
324287813317
```

### Row-level errors

None.

## Production verification evidence

### Post-apply reconciliation state

Fresh dry-run after apply and the created-row `updated_at` correction:

- `EXISTS_UNCHANGED`: `785`
- `EXISTS_NEWER_IN_CSV`: `15`
- `MISSING`: `0`
- `AMBIGUOUS`: `0`
- `SOFT_DELETED`: `2`

This matches the intended end state:

- `19` missing rows created
- `42` real updates resolved
- only the `15` timestamp-only rows remain intentionally unapplied

### Created rows exist in Dallas with HubSpot IDs and project numbers

Read-only production query on `office_dallas.deals` with `source = 'hubspot_deals_reimport_2026_05_14'` returned exactly `19` active rows, including:

- `324441141968` -> `DFW-1-13126-aa`
- `324845155013` -> `DFW-4-13226-ae`
- `324965696186` -> `DFW-4-13326-ac`

All 19 created rows were written to `office_dallas`.

### Rayside preservation check

Read-only production query for `hubspot_deal_id = '323528551136'` returned:

- `name = 'Rayside Apartments'`
- `project_type = 'roofing'`
- `bid_estimate = 1000001.01`

That confirms the non-destructive null policy worked: `project_type` stayed `roofing`.

### Soft-deleted deals remained untouched

Read-only production query confirmed both records remain inactive:

- `323231075004` / `The Avenues at Holcomb Bridge` -> `is_active = false`
- `324288514808` / `4600 Ross` -> `is_active = false`

## Notes

- The create path now stamps new rows with HubSpot `Last Modified Date` in `updated_at` so future reruns stay idempotent.
- Project type writes are normalized to the CRM allowlist. Blank CSV values do not clear CRM data; invalid non-allowlist labels are skipped rather than forced through.
