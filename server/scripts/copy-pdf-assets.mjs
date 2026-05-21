import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sourceDir = resolve(projectRoot, "src/modules/field/assets/fonts");
const targetDir = resolve(projectRoot, "dist/modules/field/assets/fonts");

if (!existsSync(sourceDir)) {
  throw new Error(`PDF font assets source directory is missing: ${sourceDir}`);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
