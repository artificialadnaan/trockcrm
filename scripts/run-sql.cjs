'use strict';
/**
 * scripts/run-sql.cjs — permanent, read-only ad-hoc SQL runner.
 *
 * WHAT IT DOES
 *   Runs a single SQL statement (passed as the first CLI argument) against the
 *   production Postgres and prints the result as JSON
 *   ({ command, rowCount, fields, rows }). It is the stable replacement for the
 *   per-discovery-worktree run-sql.cjs helpers that vanished when worktrees were
 *   pruned. Invocation path is now fixed at scripts/run-sql.cjs.
 *
 * ENV VARS (read from the repo's gitignored .env, or the ambient environment)
 *   DATABASE_PUBLIC_URL  — preferred. The externally-reachable connection string.
 *   CRM_DATABASE_URL     — fallback, matching scripts/backfill-deal-regions.ts.
 *   DATABASE_URL         — DELIBERATELY NEVER USED. It points at
 *                          postgres.railway.internal, which is unreachable from a
 *                          local machine; falling back to it would lock this
 *                          script out of local invocation.
 *   Already-set process env wins over .env file values (the .env file never
 *   overrides an exported variable).
 *
 * READ-ONLY GUARANTEE
 *   `SET default_transaction_read_only = on` is issued on the session BEFORE the
 *   caller's SQL runs, so any accidental INSERT/UPDATE/DELETE/DDL is rejected by
 *   the server. This is enforced at the connection level, not by string-matching
 *   the SQL.
 *
 * EXAMPLE
 *   node scripts/run-sql.cjs "SELECT count(*) FROM office_dallas.deals;"
 *
 * DO NOT add a --execute / --commit / --write flag. This script is read-only by
 * design; there is no write mode and there should never be one. If you need to
 * mutate data, write a dedicated, reviewed migration or operational script.
 *
 * The connection string is never printed — not on success and not on error — so
 * it cannot leak into shell history or conversation logs.
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const USAGE = 'Usage: node scripts/run-sql.cjs "<SQL>"';

// Load KEY=VALUE pairs from the first existing .env candidate into process.env,
// without overriding values already present in the environment.
function loadEnv(candidatePaths) {
  for (const envPath of candidatePaths) {
    let content;
    try {
      content = fs.readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
    return; // first existing file wins
  }
}

// Precedence: DATABASE_PUBLIC_URL > CRM_DATABASE_URL. DATABASE_URL is NEVER read.
function resolveConnectionString(env) {
  const preferred = env.DATABASE_PUBLIC_URL && env.DATABASE_PUBLIC_URL.trim();
  if (preferred) return preferred;
  const fallback = env.CRM_DATABASE_URL && env.CRM_DATABASE_URL.trim();
  if (fallback) return fallback;
  return '';
}

// Match the canonical helper's output shape. A multi-statement query returns an
// array of results; a single statement returns one result object.
function formatResult(res) {
  if (Array.isArray(res)) {
    return res
      .map((r) => JSON.stringify({ command: r.command, rowCount: r.rowCount, rows: r.rows }))
      .join('\n');
  }
  return JSON.stringify(
    {
      command: res.command,
      rowCount: res.rowCount,
      fields: (res.fields || []).map((f) => f.name),
      rows: res.rows,
    },
    null,
    2,
  );
}

// Enforce read-only on the session BEFORE running the caller's SQL.
async function runQuery(client, sql) {
  await client.query('SET default_transaction_read_only = on');
  return client.query(sql);
}

// Dependency-injected entry point. Returns the intended process exit code so the
// caller (and tests) can act on it without the function calling process.exit.
async function main(deps) {
  const { argv, env, log, error, createClient } = deps;

  const sql = argv[2];
  if (!sql) {
    error(USAGE);
    return 2;
  }

  const url = resolveConnectionString(env);
  if (!url) {
    error('No database URL. Set DATABASE_PUBLIC_URL (preferred) or CRM_DATABASE_URL.');
    return 3;
  }

  const client = createClient(url);
  let exitCode = 0;
  try {
    await client.connect();
    log(formatResult(await runQuery(client, sql)));
  } catch (e) {
    error('SQL ERROR: ' + e.message);
    exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch {
      // best-effort cleanup; the primary error (if any) is already reported
    }
  }
  return exitCode;
}

if (require.main === module) {
  loadEnv([path.join(__dirname, '..', '.env'), path.join(process.cwd(), '.env')]);
  main({
    argv: process.argv,
    env: process.env,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    createClient: (connectionString) => new Client({ connectionString }),
  })
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('SQL ERROR: ' + e.message);
      process.exit(1);
    });
}

module.exports = { loadEnv, resolveConnectionString, formatResult, runQuery, main, USAGE };
