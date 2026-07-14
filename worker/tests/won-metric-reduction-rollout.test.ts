import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const jobsIndexPath = fileURLToPath(new URL("../src/jobs/index.ts", import.meta.url));

describe("Won-metric reduction alert rollout", () => {
  it("keeps the handler registered without opening the delivery gate at worker startup", () => {
    const workerIndexSource = fs.readFileSync(workerIndexPath, "utf8");
    const jobsIndexSource = fs.readFileSync(jobsIndexPath, "utf8");

    expect(workerIndexSource).toContain("registerAllJobs();");
    expect(workerIndexSource).not.toContain("enableWonMetricReductionAlertDelivery");
    expect(jobsIndexSource).toContain(
      "registerJobHandler(WON_METRIC_REDUCTION_ALERT_JOB, handleWonMetricReductionAlert);",
    );
  });
});
