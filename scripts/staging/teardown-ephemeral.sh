#!/usr/bin/env bash
set -euo pipefail

# Deletes a named ephemeral Railway service created by ephemeral-staging.sh.
# Guardrails require the default staging-ephemeral-* prefix unless --force is used.

PROJECT_ID="${RAILWAY_PROJECT_ID:-53fbadb4-b2aa-4fe3-8f6d-4d8d3c2a2f9c}"
ENVIRONMENT_ID="${RAILWAY_ENVIRONMENT_ID:-8d35be1c-b4c2-4752-9aa3-08dfda944e1c}"
SERVICE_NAME="${1:-}"
FORCE="${2:-}"

if [ -z "$SERVICE_NAME" ]; then
  echo "Usage: $0 staging-ephemeral-YYYYMMDD-HHMM [--force]" >&2
  exit 1
fi

if [[ ! "$SERVICE_NAME" =~ ^staging-ephemeral-[0-9]{8}-[0-9]{4}$ && "$FORCE" != "--force" ]]; then
  echo "Refusing to delete '${SERVICE_NAME}'." >&2
  echo "Expected staging-ephemeral-YYYYMMDD-HHMM, or pass --force as the second argument." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Missing required command: node" >&2
  exit 1
fi

node - "$PROJECT_ID" "$ENVIRONMENT_ID" "$SERVICE_NAME" <<'NODE'
const fs = require('fs');

const [projectId, environmentId, serviceName] = process.argv.slice(2);
const configPath = `${process.env.HOME}/.railway/config.json`;
const token = process.env.RAILWAY_TOKEN || JSON.parse(fs.readFileSync(configPath, 'utf8')).user?.token;

if (!token) {
  console.error('Missing Railway token. Run railway login or set RAILWAY_TOKEN.');
  process.exit(1);
}

const endpoint = 'https://backboard.railway.com/graphql/v2';

async function graphql(query, variables) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(JSON.stringify(payload.errors, null, 2));
  }
  return payload.data;
}

async function main() {
  const query = `
    query($projectId: String!) {
      project(id: $projectId) {
        services(first: 100) {
          edges {
            node { id name }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { projectId });
  const services = data.project.services.edges.map((edge) => edge.node);
  const matches = services.filter((service) => service.name === serviceName);

  if (matches.length === 0) {
    console.error(`No Railway service found named ${serviceName}`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple Railway services found named ${serviceName}; refusing to delete.`);
    process.exit(1);
  }

  const service = matches[0];
  const mutation = `
    mutation($id: String!, $environmentId: String) {
      serviceDelete(id: $id, environmentId: $environmentId)
    }
  `;
  const result = await graphql(mutation, { id: service.id, environmentId });
  console.log(JSON.stringify({
    deleted: result.serviceDelete,
    serviceName: service.name,
    serviceId: service.id,
    environmentId,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
NODE
