// Pure-logic suite (grouping/filtering, the API client with a mocked fetch, the
// concurrency pool). Provide a harmless API host so config.ts / the apiFetch
// missing-host guard never trips during tests (the npm "test" script also sets
// it before Jest starts, which is the load-bearing one for babel inlining).
process.env.EXPO_PUBLIC_API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || "https://api.test.local";

export {};
