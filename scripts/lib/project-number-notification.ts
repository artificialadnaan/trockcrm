import type pg from "pg";

export function shouldSkipProjectNumberEmail(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(String(env.SKIP_PROJECT_NUMBER_EMAIL ?? "").trim().toLowerCase());
}

export async function applyProjectNumberEmailSkipSetting(
  client: Pick<pg.Client | pg.PoolClient, "query">,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!shouldSkipProjectNumberEmail(env)) return;
  await client.query("SELECT set_config('app.skip_project_number_email', 'true', true)");
}
