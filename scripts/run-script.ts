import path from "node:path";
import { pathToFileURL } from "node:url";
import { runBackfill as runProjectNumberBackfill } from "./backfill-project-numbers.js";
import { runBackfill as runProjectTypeBackfill } from "./backfill-project-types.js";
import { runNormalizeProjectNumberCase } from "./normalize-project-number-case.js";

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

  if (!scriptName || scriptName.startsWith("--")) {
    await runProjectNumberBackfill(argv);
    return;
  }

  throw new Error(`Unknown script '${scriptName}'. Expected backfill-project-types, backfill-project-numbers, or normalize-project-number-case.`);
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runScript().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
