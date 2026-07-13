import { useEffect, useState } from "react";
import type {
  EstimatorPipelineBucket,
  EstimatorPipelineCohort,
  EstimatorPipelineEvidenceResponse,
  EstimatorPipelineReport,
  EstimatorPipelineTargetKey,
} from "@trock-crm/shared/types";
import { api } from "@/lib/api";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

export function useEstimatorPipelineReport(officeScopeKey?: string | null) {
  const [data, setData] = useState<EstimatorPipelineReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);

    api<{ data: EstimatorPipelineReport }>("/reports/estimator-pipeline", { signal: controller.signal })
      .then((result) => setData(result.data))
      .catch((requestError: unknown) => {
        if (!isAbortError(requestError)) {
          setError(errorMessage(requestError, "Failed to load the estimator pipeline report"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [officeScopeKey, refreshToken]);

  return { data, loading, error, refetch: () => setRefreshToken((value) => value + 1) };
}

export interface EstimatorPipelineEvidenceRequest {
  cohort: EstimatorPipelineCohort;
  asOf?: string;
  bucket: EstimatorPipelineBucket;
  estimatorKey?: EstimatorPipelineTargetKey;
  stageSlug?: string;
  page: number;
  pageSize: number;
}

export function useEstimatorPipelineEvidence(
  request: EstimatorPipelineEvidenceRequest | null,
  officeScopeKey?: string | null,
) {
  const [data, setData] = useState<EstimatorPipelineEvidenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!request) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({
      cohort: request.cohort,
      bucket: request.bucket,
      page: String(request.page),
      pageSize: String(request.pageSize),
    });
    if (request.estimatorKey) params.set("estimatorKey", request.estimatorKey);
    if (request.stageSlug) params.set("stageSlug", request.stageSlug);
    if (request.asOf) params.set("asOf", request.asOf);

    setLoading(true);
    setError(null);
    setData(null);
    api<{ data: EstimatorPipelineEvidenceResponse }>(
      `/reports/estimator-pipeline/evidence?${params.toString()}`,
      { signal: controller.signal },
    )
      .then((result) => setData(result.data))
      .catch((requestError: unknown) => {
        if (!isAbortError(requestError)) {
          setError(errorMessage(requestError, "Failed to load estimator project evidence"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [request, officeScopeKey, refreshToken]);

  return { data, loading, error, refetch: () => setRefreshToken((value) => value + 1) };
}
