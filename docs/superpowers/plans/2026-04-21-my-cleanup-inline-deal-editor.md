# Implementation Plan: My Cleanup Inline Deal Editor

1. Add an in-place deal editor dialog to `MyCleanupPage`
- Track selected cleanup row and dialog open state
- Restrict inline editing to `deal` rows only

2. Load selected deal data for the dialog
- Reuse the existing deal fetch path
- Show loading and error states inside the dialog shell

3. Render `DealForm` in the dialog
- Pass the loaded `deal`
- Use `onSuccess` to close the dialog and refetch the cleanup queue
- Keep the user on `/pipeline/my-cleanup`

4. Preserve lead cleanup behavior
- Leave lead rows non-inline-editable
- Keep a lead-specific navigation CTA instead of modal editing

5. Add focused UI tests
- Deal row opens editor dialog
- Lead row does not
- Successful save triggers queue refresh path

6. Run review and verification
- review loop on the UI change
- run targeted tests
- run production validation after deploy
