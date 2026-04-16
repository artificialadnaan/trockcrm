// The workspace package entrypoint currently resolves shared artifacts from the
// primary repo checkout, not this worktree. Centralize the worktree-local
// contract imports here so targeted schema tests stay truthful without spreading
// fragile relative source imports across test files.
export { LEAD_STATUSES } from "../../../shared/src/types/enums.js";
export {
  deals,
  leadStageHistory,
  leads,
  properties,
} from "../../../shared/src/schema/index.js";
