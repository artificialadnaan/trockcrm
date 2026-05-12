# Smoke — Credentials and Disclosure Cleanup

Doc/hook-only PR. No runtime endpoints touched. Smoke confirms the test-account passwords still work after the scrub (we redacted documentation, not the password values).

## Account login probes

Run 2026-05-11. `POST https://<prod-api-host>/api/auth/local/login` with each fixture account.

| Account | Result |
|---|---|
| `test-admin@trock.test` | HTTP 200 |
| `test-director@trock.test` | HTTP 200 |
| `test-sales@trock.test` | HTTP 200 |

All three accounts authenticate successfully on the live API. The scrub did not affect runtime credential storage.

## Pre-commit hook self-test

```
$ bash scripts/test-precommit-hook.sh
OK   : literal admin password was blocked
OK   : literal shared password was blocked
OK   : password assignment regex was blocked
OK   : railway prod hostname was blocked
OK   : clean prose was allowed
OK   : redacted password was allowed

PASS: pre-commit hook behaves as designed (4 blocked, 2 allowed).
```

## Verification gates

- `npm run typecheck` — exit 0
- repo-wide grep for the two canonical test-account password literals — only the hook's own pattern declarations and the test script's fixture strings appear (necessary for the security tool to function); zero hits in `.reviews/`, source code, or any other doc
- `.reviews/`-scoped grep for the production Railway hostname — zero hits
- pre-commit hook self-test — PASS
- live login for all three test accounts — HTTP 200

No runtime / deploy needed for this track.
