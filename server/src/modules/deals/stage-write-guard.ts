import { AppError } from "../../middleware/error-handler.js";

export const INACTIVE_DEAL_STAGE_ERROR_CODE = "INACTIVE_DEAL_STAGE";
export const INACTIVE_DEAL_STAGE_MESSAGE = "Cannot set deal stage to inactive pipeline stage.";

export function assertActiveDealStageWriteTarget(
  stage: { isActivePipeline: boolean } | null | undefined
) {
  if (stage?.isActivePipeline !== true) {
    throw new AppError(400, INACTIVE_DEAL_STAGE_MESSAGE, INACTIVE_DEAL_STAGE_ERROR_CODE);
  }
}
