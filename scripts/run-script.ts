import path from "node:path";
import { pathToFileURL } from "node:url";
import { runBackfill as runProjectNumberBackfill } from "./backfill-project-numbers.js";
import { runBackfill as runProjectTypeBackfill } from "./backfill-project-types.js";
import { runNormalizeProjectNumberCase } from "./normalize-project-number-case.js";
import { runBackfillProjectsActiveFlag } from "./backfill-projects-active-flag.js";
import { runReassignHubspotImportStages } from "./reassign-hubspot-import-stages.js";
import { runReseedSmokeCleanup } from "./reseed-smoke-cleanup.js";
import { runAuditTempPasswordUsers } from "./audit-tempassword-users.js";

export async function runScript(argv = process.argv.slice(2)): Promise<void> {
  const [scriptName, ...rest] = argv;

  if (scriptName === "backfill-project-types") {
    await runProjectTypeBackfill(argv);
    return;
  }

  if (scriptName === "backfill-project-numbers") {
    await runProjectNumberBackfill(rest);
    return;
  }

  if (scriptName === "normalize-project-number-case") {
    await runNormalizeProjectNumberCase(rest);
    return;
  }

  if (scriptName === "backfill-projects-active-flag") {
    await runBackfillProjectsActiveFlag(rest);
    return;
  }

  if (scriptName === "reassign-hubspot-import-stages") {
    await runReassignHubspotImportStages(rest);
    return;
  }

  if (scriptName === "reseed-smoke-cleanup") {
    await runReseedSmokeCleanup(rest);
    return;
  }

  if (scriptName === "audit-tempassword-users") {
    await runAuditTempPasswordUsers(rest);
    return;
  }

  if (!scriptName || scriptName.startsWith("--")) {
    await runProjectNumberBackfill(argv);
    return;
  }

  throw new Error(`Unknown script '${scriptName}'. Expected backfill-project-types, backfill-project-numbers, normalize-project-number-case, backfill-projects-active-flag, reassign-hubspot-import-stages, reseed-smoke-cleanup, or audit-tempassword-users.`);
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runScript().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
