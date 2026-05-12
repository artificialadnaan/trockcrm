#!/usr/bin/env bash
# Verifies that .husky/pre-commit blocks commits introducing the canonical
# secret patterns and lets a clean commit through. Self-cleaning: never
# leaves a real commit on the branch and restores the prior working tree.
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
  echo "WARN: core.hooksPath is '$CORE_HOOKS_PATH'. Run 'npm install' (or 'npx husky') so git knows to call the hook." >&2
fi

TMP_FILE=".precommit-hook-fixture.tmp.txt"
trap 'rm -f "$TMP_FILE"; git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true' EXIT

assert_blocked () {
  local label="$1"
  local fixture="$2"
  printf "%s\n" "$fixture" > "$TMP_FILE"
  git add "$TMP_FILE"
  set +e
  output=$(git commit -m "test: should be blocked - $label" 2>&1)
  rc=$?
  set -e
  git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true
  rm -f "$TMP_FILE"
  if [ $rc -eq 0 ]; then
    echo "FAIL: commit succeeded but the hook should have blocked it." >&2
    echo "Fixture: $label" >&2
    echo "Output:" >&2
    echo "$output" >&2
    git reset --soft HEAD~1 >/dev/null 2>&1 || true
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
  output=$(git commit -m "test: should be allowed - $label" 2>&1)
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    echo "FAIL: commit was blocked but the fixture is clean." >&2
    echo "Fixture: $label" >&2
    echo "Output:" >&2
    echo "$output" >&2
    git reset HEAD -- "$TMP_FILE" >/dev/null 2>&1 || true
    rm -f "$TMP_FILE"
    exit 1
  fi
  # Roll the test commit back so we never leave it on the branch.
  git reset --soft HEAD~1 >/dev/null 2>&1
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

echo ""
echo "PASS: pre-commit hook behaves as designed (4 blocked, 2 allowed)."
