import { describe, expect, it } from "vitest";
import {
  aiDocumentIndex,
  aiEmbeddingChunks,
  aiCopilotPackets,
  aiTaskSuggestions,
  aiRiskFlags,
  aiFeedback,
} from "../../../../shared/src/schema/index.js";

describe("AI copilot schema exports", () => {
  it("exports all tenant AI tables from the shared schema barrel", () => {
    expect(aiDocumentIndex).toBeDefined();
    expect(aiEmbeddingChunks).toBeDefined();
    expect(aiCopilotPackets).toBeDefined();
    expect(aiTaskSuggestions).toBeDefined();
    expect(aiRiskFlags).toBeDefined();
    expect(aiFeedback).toBeDefined();
  });

  it("exposes the expected AI table names for typed query construction", () => {
    expect(aiDocumentIndex[Symbol.for("drizzle:Name")]).toBe("ai_document_index");
    expect(aiEmbeddingChunks[Symbol.for("drizzle:Name")]).toBe("ai_embedding_chunks");
    expect(aiCopilotPackets[Symbol.for("drizzle:Name")]).toBe("ai_copilot_packets");
    expect(aiTaskSuggestions[Symbol.for("drizzle:Name")]).toBe("ai_task_suggestions");
    expect(aiRiskFlags[Symbol.for("drizzle:Name")]).toBe("ai_risk_flags");
    expect(aiFeedback[Symbol.for("drizzle:Name")]).toBe("ai_feedback");
  });
});
