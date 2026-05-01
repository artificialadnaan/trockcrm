#!/usr/bin/env bash
set -euo pipefail

# Creates a one-shot Railway Postgres clone for migration verification.
# This script intentionally does not run app migrations. It only dumps production,
# provisions an ephemeral Postgres service, restores the dump, and writes the
# resulting DATABASE_URL to a restricted env file for follow-up verification.

PROJECT_ID="${RAILWAY_PROJECT_ID:-53fbadb4-b2aa-4fe3-8f6d-4d8d3c2a2f9c}"
ENVIRONMENT_ID="${RAILWAY_ENVIRONMENT_ID:-8d35be1c-b4c2-4752-9aa3-08dfda944e1c}"
PRODUCTION_DB_SERVICE="${PRODUCTION_DB_SERVICE:-Postgres}"
STAMP="$(date -u +%Y%m%d-%H%M)"
SERVICE_NAME="${1:-staging-ephemeral-${STAMP}}"
DUMP_DIR="${DUMP_DIR:-tmp/staging-dumps}"
DUMP_FILE="${DUMP_DIR}/${SERVICE_NAME}.dump"
ENV_FILE="${DUMP_DIR}/ephemeral-${STAMP}.env"
RAILWAY_WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/trockcrm-railway.XXXXXX")"

cleanup() {
  rm -rf "$RAILWAY_WORKDIR"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

json_get() {
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const path=process.argv[1].split('.'); let v=data; for (const key of path) v=v?.[key]; if (v == null) process.exit(1); process.stdout.write(String(v));" "$1"
}

with_pg_env_from_url() {
  local url="$1"
  shift
  local parts

  mapfile -d '' -t parts < <(node - "$url" <<'NODE'
const { URL } = require('url');

const parsed = new URL(process.argv[2]);
const values = [
  parsed.hostname,
  parsed.port || '5432',
  decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  decodeURIComponent(parsed.username),
  decodeURIComponent(parsed.password),
  parsed.searchParams.get('sslmode') || 'require',
];

process.stdout.write(`${values.join('\0')}\0`);
NODE
)

  PGHOST="${parts[0]}" \
    PGPORT="${parts[1]}" \
    PGDATABASE="${parts[2]}" \
    PGUSER="${parts[3]}" \
    PGPASSWORD="${parts[4]}" \
    PGSSLMODE="${parts[5]}" \
    "$@"
}

redacted_url_summary() {
  node - "$1" <<'NODE'
const { URL } = require('url');

try {
  const parsed = new URL(process.argv[2]);
  const database = parsed.pathname.replace(/^\//, '') || '(none)';
  console.log(`Host: ${parsed.hostname}`);
  console.log(`Port: ${parsed.port || '(default)'}`);
  console.log(`Database: ${database}`);
} catch (error) {
  console.log('Host: (unavailable)');
  console.log('Port: (unavailable)');
  console.log('Database: (unavailable)');
}
NODE
}

railway_vars_kv() {
  local service="$1"
  (
    cd "$RAILWAY_WORKDIR"
    railway variable list \
      --environment "$ENVIRONMENT_ID" \
      --service "$service" \
      --kv
  )
}

extract_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { exit found ? 0 : 1 }'
}

wait_for_database_url() {
  local service="$1"
  local attempts="${2:-60}"

  for attempt in $(seq 1 "$attempts"); do
    if url="$(railway_vars_kv "$service" | extract_var DATABASE_PUBLIC_URL 2>/dev/null)" && [ -n "$url" ]; then
      printf '%s' "$url"
      return 0
    fi
    echo "Waiting for DATABASE_PUBLIC_URL on ${service} (${attempt}/${attempts})..."
    sleep 5
  done

  echo "Timed out waiting for DATABASE_PUBLIC_URL on ${service}" >&2
  return 1
}

wait_for_postgres() {
  local url="$1"
  local attempts="${2:-60}"

  for attempt in $(seq 1 "$attempts"); do
    if with_pg_env_from_url "$url" pg_isready >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for ephemeral Postgres to accept connections (${attempt}/${attempts})..."
    sleep 5
  done

  echo "Timed out waiting for ephemeral Postgres readiness" >&2
  return 1
}

require_command railway
require_command pg_dump
require_command pg_restore
require_command pg_isready
require_command node
require_command awk

if [[ ! "$SERVICE_NAME" =~ ^staging-ephemeral-[0-9]{8}-[0-9]{4}$ ]]; then
  echo "Refusing service name '${SERVICE_NAME}'." >&2
  echo "Expected format: staging-ephemeral-YYYYMMDD-HHMM" >&2
  exit 1
fi

mkdir -p "$DUMP_DIR"
umask 077

echo "Project: ${PROJECT_ID}"
echo "Environment: ${ENVIRONMENT_ID}"
echo "Production DB service: ${PRODUCTION_DB_SERVICE}"
echo "Ephemeral DB service: ${SERVICE_NAME}"
echo "Dump file: ${DUMP_FILE}"

echo
echo "Linking Railway project in temporary workdir ${RAILWAY_WORKDIR}..."
(
  cd "$RAILWAY_WORKDIR"
  railway link \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$PRODUCTION_DB_SERVICE" \
    --json >/dev/null
)

echo
echo "Fetching production DATABASE_PUBLIC_URL from Railway..."
PRODUCTION_DATABASE_URL="$(railway_vars_kv "$PRODUCTION_DB_SERVICE" | extract_var DATABASE_PUBLIC_URL)"

echo "Dumping production Postgres to ${DUMP_FILE}..."
with_pg_env_from_url "$PRODUCTION_DATABASE_URL" pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$DUMP_FILE"

echo
echo "Provisioning Railway Postgres service ${SERVICE_NAME}..."
ADD_JSON="$(
  cd "$RAILWAY_WORKDIR"
  railway add \
    --database postgres \
    --service "$SERVICE_NAME" \
    --json
)"

echo "$ADD_JSON" | json_get id >/dev/null 2>&1 || {
  echo "Railway add output did not include a top-level id. Raw output suppressed because it may contain service metadata." >&2
  exit 1
}

echo
echo "Waiting for ephemeral DATABASE_PUBLIC_URL..."
EPHEMERAL_DATABASE_URL="$(wait_for_database_url "$SERVICE_NAME")"

echo "Waiting for ephemeral database readiness..."
wait_for_postgres "$EPHEMERAL_DATABASE_URL"

echo
echo "Restoring dump into ${SERVICE_NAME}..."
with_pg_env_from_url "$EPHEMERAL_DATABASE_URL" pg_restore \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  "$DUMP_FILE"

echo
echo "Ephemeral staging database is ready."
echo
printf "export DATABASE_URL=%q\n" "$EPHEMERAL_DATABASE_URL" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Ephemeral database connection:"
redacted_url_summary "$EPHEMERAL_DATABASE_URL"
echo
echo "Credentials were written to ${ENV_FILE} with mode 600."
echo "Load them with:"
echo "source ${ENV_FILE}"
echo
echo "Suggested next commands:"
echo "npm run db:migrate"
echo "npx tsx scripts/verify-batch-migrations.ts"
echo
echo "Teardown when finished:"
echo "scripts/staging/teardown-ephemeral.sh ${SERVICE_NAME}"
