# Track F2 Internal Review Iteration 1

## Scope

Refactor `client/src/pages/files/files-page.tsx` to match the Files preview surface while preserving the existing file browser data flow:

- `useFiles`
- `useDeals`
- `useContacts`
- `useAuth`
- `downloadFile`
- `deleteFileRecord`
- `FileUploadZone`

No backend, upload handler, storage, signed URL, or shared component code was modified.

## Initial Verification

- `npm run typecheck`: passed
- `npx vitest run client/src/pages/files/files-page.test.tsx`: 6 passed
- Files test sweep: 3 files, 12 tests passed

## Review Ask

Check visual fidelity, data preservation, accessibility, type/null safety, and test quality.
