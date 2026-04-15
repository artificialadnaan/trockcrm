import type { DealCopilotPromptInput, DealCopilotPromptOutput } from "./prompt-contract.js";

export interface AiCopilotProvider {
  generateCopilotPacket(input: DealCopilotPromptInput): Promise<DealCopilotPromptOutput>;
}
