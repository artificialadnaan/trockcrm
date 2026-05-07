export class ExternalFetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalFetchTimeoutError";
  }
}

interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs: number;
  timeoutLabel: string;
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  { timeoutMs, timeoutLabel, ...init }: FetchWithTimeoutOptions
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new ExternalFetchTimeoutError(`${timeoutLabel} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
