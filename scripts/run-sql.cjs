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
 *   The caller's SQL is wrapped in `BEGIN TRANSACTION READ ONLY` / `COMMIT`.
 *   After BEGIN, the script issues a harmless sentinel SELECT before user SQL.
 *   That freezes PostgreSQL transaction characteristics so a later
 *   `SET TRANSACTION READ WRITE` in user SQL is rejected instead of overriding
 *   the mode before the first data statement. Transaction-boundary statements
 *   are rejected before execution so user SQL cannot COMMIT/ROLLBACK out of the
 *   wrapper. Any accidental INSERT/UPDATE/DELETE/DDL is rejected by the server.
 *   NOTIFY and pg_notify() are rejected before execution too: PostgreSQL
 *   read-only mode does NOT block notifications, and a worker consumes the
 *   crm_events channel, so they would be real production side effects.
 *   For the same reason — read-only mode does not stop them — DO blocks
 *   (opaque code body), LOCK statements (ACCESS EXCLUSIVE; can block production),
 *   and COPY to a file / TO|FROM PROGRAM (server-side file/command I/O) are also
 *   rejected before execution. Only COPY ... TO STDOUT (a client export) is allowed.
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
      .map((r) =>
        JSON.stringify({
          command: r.command,
          rowCount: r.rowCount,
          fields: (r.fields || []).map((f) => f.name),
          rows: r.rows,
        })
      )
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

function maskSqlLiteralsAndComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < sql.length) {
        out += ' ';
        if (sql[i] === quote) {
          if (quote === "'" && sql[i + 1] === "'") {
            i += 2;
            out += ' ';
            continue;
          }
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      out += '  ';
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      if (i < sql.length) out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < sql.length) {
        out += ' ';
        if (sql[i] === '*' && sql[i + 1] === '/') {
          out += ' ';
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '$') {
      const rest = sql.slice(i);
      const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          const length = end + tag.length - i;
          out += ' '.repeat(length);
          i += length - 1;
          continue;
        }
      }
    }

    out += ch;
  }
  return out;
}

function maskSqlLiteralsAndCommentsNormalizeIdentifiers(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < sql.length) {
        out += ' ';
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            out += ' ';
            continue;
          }
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      out += '  ';
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      if (i < sql.length) out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < sql.length) {
        out += ' ';
        if (sql[i] === '*' && sql[i + 1] === '/') {
          out += ' ';
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '$') {
      const rest = sql.slice(i);
      const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          const length = end + tag.length - i;
          out += ' '.repeat(length);
          i += length - 1;
          continue;
        }
      }
    }

    out += ch;
  }
  return out;
}

// Split SQL into normalized, lower-cased statements with string literals and
// comments already blanked out (see maskSqlLiteralsAndComments). Shared by the
// transaction-boundary check so it sees only real statement-leading tokens —
// never text that merely appears inside a string, comment, or quoted identifier.
function maskedStatements(sql) {
  return maskSqlLiteralsAndComments(sql)
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean);
}

// Split SQL for side-effecting function/statement scans. String literals and
// comments stay blanked to avoid false positives from data, but double-quoted
// identifiers are normalized by removing the quotes. That is intentional:
// "pg_notify" is an identifier that PostgreSQL resolves to the same function
// name as pg_notify, so blanking it would hide a real side-effecting call.
function sideEffectScanStatements(sql) {
  return maskSqlLiteralsAndCommentsNormalizeIdentifiers(sql)
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean);
}

function assertNoTransactionBoundaryStatements(sql) {
  const statements = maskedStatements(sql);

  // SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK TO SAVEPOINT do not end the parent
  // READ ONLY transaction, so they are not escape vectors and remain allowed.
  // PREPARE TRANSACTION ends the current transaction for two-phase commit, so it
  // is blocked; plain PREPARE name AS ... only prepares a statement and is safe.
  const forbidden =
    /^(begin\b|start\s+transaction\b|commit\b|rollback\b(?!\s+to\b)|end\b|abort\b|prepare\s+transaction\b)/;
  if (statements.some((statement) => forbidden.test(statement))) {
    throw new Error('Transaction boundary statements are not allowed in read-only SQL.');
  }
}

// Block NOTIFY and pg_notify() even though the wrapper runs READ ONLY.
// PostgreSQL read-only mode prevents durable data changes but does NOT block
// notifications: NOTIFY events are queued and delivered on COMMIT, and a worker
// LISTENs on the crm_events channel (worker/src/listener.ts), so a payload like
// `NOTIFY crm_events, '...'` or `SELECT pg_notify('crm_events', '...')` would
// commit and fire a real production side effect from a tool that claims to be
// read-only.
//   - NOTIFY is its own statement -> caught by a prefix-anchored ^notify match.
//     The anchor means an identifier like notify_col (which has no word boundary
//     after "notify") and any SELECT that merely references such a column are
//     NOT flagged.
//   - pg_notify() is a function call inside another statement (typically
//     SELECT pg_notify(...)), so the statement still starts with "select" and
//     the prefix match cannot see it. It is caught by a separate scan for the
//     pg_notify( call token after normalizing identifiers. This catches
//     pg_notify(...), pg_catalog.pg_notify(...), pg_catalog."pg_notify"(...),
//     and "pg_notify"(...), while leaving string literals and comments blanked
//     so 'pg_notify(' as data does not trigger a false positive.
//
// Defensive sweep: pg_notify is the only side-effecting function with a live
// consumer in this codebase, so it is the one we explicitly block. Functions
// that write durable data are already rejected by the server inside a READ ONLY
// transaction. The pg_advisory_lock* family takes session/transaction locks but
// writes nothing durable and has no listener here, so it is intentionally left
// allowed (revisit if a consumer is added). The structural fix that retires all
// of these string checks is a SELECT-only database role (tracked separately).
function assertNoSideEffectingStatements(sql) {
  const statements = sideEffectScanStatements(sql);
  const forbiddenStatement = /^notify\b/; // NOTIFY channel [, payload]
  const forbiddenCall = /(^|[^a-z0-9_$])pg_notify\s*\(/; // SELECT ... [schema.]pg_notify (...) ...
  if (statements.some((statement) => forbiddenStatement.test(statement) || forbiddenCall.test(statement))) {
    throw new Error(
      'NOTIFY and pg_notify() are not allowed in read-only SQL: read-only transactions do not block notifications and a worker consumes the crm_events channel.',
    );
  }
}

// Reject statements that PostgreSQL's READ ONLY transaction mode does NOT prevent
// but which still reach OUTSIDE the database's row data — server-side I/O, an
// opaque code body, or production-blocking locks:
//
//   - DO ... : runs an anonymous PL/pgSQL block. Its dollar-quoted body is blanked
//     by the literal scan (so a `PERFORM pg_notify(...)` inside it would slip past
//     the NOTIFY guard above), and read-only mode does not block notifications
//     raised from inside a function/block. A read-only ad-hoc runner has no reason
//     to execute anonymous code, so the whole statement is rejected.
//   - LOCK [TABLE] ... : defaults to ACCESS EXCLUSIVE and writes no rows, so the
//     server allows it in a READ ONLY transaction — but it can block production
//     reads/writes for the life of the (sleeping) transaction.
//   - COPY ... TO '<file>' / TO|FROM PROGRAM ... : performs server-side file or
//     command I/O (with a superuser / pg_*_server_files / pg_execute_server_program
//     role) that read-only mode does not stop. Only COPY ... TO STDOUT — a pure
//     result export streamed to the client — is permitted.
//
// The structural fix that retires every one of these string checks is a SELECT-only
// database role (tracked separately).
function assertNoServerSideEffectStatements(sql) {
  const statements = sideEffectScanStatements(sql);
  for (const statement of statements) {
    if (/^do\b/.test(statement)) {
      throw new Error(
        'DO blocks are not allowed in read-only SQL: an anonymous code body is opaque to the safety scan and can raise notifications or other side effects that read-only mode does not block.',
      );
    }
    if (/^lock\b/.test(statement)) {
      throw new Error(
        'LOCK statements are not allowed in read-only SQL: they take an ACCESS EXCLUSIVE lock by default and can block production traffic for the life of the transaction.',
      );
    }
    if (/^copy\b/.test(statement)) {
      // The COPY target path is a string literal (already blanked), so detect the
      // SAFE shape positively: COPY ... TO STDOUT with no PROGRAM. Everything else
      // (TO a file, TO/FROM PROGRAM, FROM STDIN) is server-side I/O or a write.
      const isStdoutExport = /\bto\s+stdout\b/.test(statement) && !/\bprogram\b/.test(statement);
      if (!isStdoutExport) {
        throw new Error(
          'COPY to a file or PROGRAM is not allowed in read-only SQL: it performs server-side file/command I/O that read-only mode does not prevent. Only COPY ... TO STDOUT is permitted.',
        );
      }
    }
  }
}

// BEGIN TRANSACTION READ ONLY is the structural read-only guarantee. The
// sentinel SELECT is intentionally before user SQL: it freezes transaction
// characteristics so PostgreSQL rejects SET TRANSACTION READ WRITE attempts.
// Boundary statements are blocked so user SQL cannot COMMIT out and continue in
// a new transaction. NOTIFY / pg_notify() are blocked too because read-only mode
// does not stop them and a worker consumes the crm_events channel.
async function runQuery(client, sql) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await client.query('SELECT 1');
    assertNoTransactionBoundaryStatements(sql);
    assertNoSideEffectingStatements(sql);
    assertNoServerSideEffectStatements(sql);
    const result = await client.query(sql);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // best-effort rollback; preserve the original query error
    }
    throw err;
  }
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
