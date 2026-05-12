#!/usr/bin/env bash
# Verifies that .husky/pre-commit blocks staged additions introducing the
# canonical secret patterns and lets clean staged additions through.
#
# Run: bash scripts/test-precommit-hook.sh
# Exits 0 on success (hook behaves correctly) and non-zero on failure.

set -e

cd "$(git rev-parse --show-toplevel)"

if [ ! -x .husky/pre-commit ]; then
  echo "FAIL: .husky/pre-commit is missing or not executable." >&2
  exit 1
fi

CORE_HOOKS_PATH=$(git config --get core.hooksPath || echo "")
if [ "$CORE_HOOKS_PATH" != ".husky/_" ] && [ "$CORE_HOOKS_PATH" != ".husky" ]; then
  echo "WARN: core.hooksPath is '$CORE_HOOKS_PATH'. Testing .husky/pre-commit directly." >&2
fi

TMP_FILE=".precommit-hook-fixture.tmp.txt"
trap 'rm -f "$TMP_FILE"; git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true' EXIT

assert_blocked () {
  local label="$1"
  local fixture="$2"
  printf "%s\n" "$fixture" > "$TMP_FILE"
  git add "$TMP_FILE"
  set +e
  output=$(.husky/pre-commit 2>&1)
  rc=$?
  set -e
  git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true
  rm -f "$TMP_FILE"
  if [ $rc -eq 0 ]; then
    echo "FAIL: hook succeeded but should have blocked the staged fixture." >&2
    echo "Fixture: $label" >&2
    echo "Output:" >&2
    echo "$output" >&2
    exit 1
  fi
  if ! echo "$output" | grep -q "pre-commit blocked"; then
    echo "FAIL: commit failed but the failure was not from our hook." >&2
    echo "Fixture: $label" >&2
    echo "Output:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "OK   : $label was blocked"
}

assert_allowed () {
  local label="$1"
  local fixture="$2"
  printf "%s\n" "$fixture" > "$TMP_FILE"
  git add "$TMP_FILE"
  set +e
  output=$(.husky/pre-commit 2>&1)
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    echo "FAIL: hook blocked a clean staged fixture." >&2
    echo "Fixture: $label" >&2
    echo "Output:" >&2
    echo "$output" >&2
    git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true
    rm -f "$TMP_FILE"
    exit 1
  fi
  git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true
  rm -f "$TMP_FILE"
  echo "OK   : $label was allowed"
}

assert_blocked "literal admin password" "fixture line containing dev123! sentinel"
assert_blocked "literal shared password" "fixture line containing TrockTest123! sentinel"
assert_blocked "password assignment regex" 'const cfg = { password: "supersecret" };'
assert_blocked "railway prod hostname" "curl https://api-production-xyz123.up.railway.app/api/health"
assert_allowed "clean prose" "the quick brown fox jumped over the lazy dog"
assert_allowed "redacted password" 'password: <redacted - test creds in ops vault>'

original_smoke_doc=""
if [ -f docs/smoke-credentials.md ]; then
  original_smoke_doc=$(mktemp)
  cp docs/smoke-credentials.md "$original_smoke_doc"
fi
mkdir -p docs
printf "%s\n" "test-only smoke credential fixture may mention TrockTest123! here" > docs/smoke-credentials.md
git add docs/smoke-credentials.md
set +e
output=$(.husky/pre-commit 2>&1)
rc=$?
set -e
if [ $rc -ne 0 ]; then
  echo "FAIL: docs/smoke-credentials.md should be the only literal credential exception." >&2
  echo "$output" >&2
  git reset HEAD -- docs/smoke-credentials.md >/dev/null 2>&1 || true
  if [ -n "$original_smoke_doc" ]; then
    cp "$original_smoke_doc" docs/smoke-credentials.md
    rm -f "$original_smoke_doc"
  else
    rm -f docs/smoke-credentials.md
  fi
  exit 1
fi
git reset HEAD -- docs/smoke-credentials.md >/dev/null 2>&1 || true
if [ -n "$original_smoke_doc" ]; then
  cp "$original_smoke_doc" docs/smoke-credentials.md
else
  rm -f docs/smoke-credentials.md
fi
echo "OK   : smoke credential doc exception was allowed"

printf "%s\n" 'password: "should-still-be-blocked"' >> docs/smoke-credentials.md
git add docs/smoke-credentials.md
set +e
output=$(.husky/pre-commit 2>&1)
rc=$?
set -e
git reset HEAD -- docs/smoke-credentials.md >/dev/null 2>&1 || true
if [ -n "$original_smoke_doc" ]; then
  cp "$original_smoke_doc" docs/smoke-credentials.md
  rm -f "$original_smoke_doc"
else
  rm -f docs/smoke-credentials.md
fi
if [ $rc -eq 0 ]; then
  echo "FAIL: docs/smoke-credentials.md must still block generic password assignments." >&2
  echo "$output" >&2
  exit 1
fi
if ! echo "$output" | grep -q "pre-commit blocked"; then
  echo "FAIL: smoke credential doc regex failure was not from our hook." >&2
  echo "$output" >&2
  exit 1
fi
echo "OK   : smoke credential doc generic password assignment was blocked"

echo ""
echo "PASS: pre-commit hook behaves as designed (5 blocked, 3 allowed)."
