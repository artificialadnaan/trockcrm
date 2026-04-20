export async function runEstimateGeneration(payload: { documentId?: string; dealId?: string }, officeId: string | null) {
  console.log("[Worker:estimate-generation] Placeholder generation job", {
    payload,
    officeId,
  });
}
