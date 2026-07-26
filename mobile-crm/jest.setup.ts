// Provide a harmless API host so config.ts and the apiFetch missing-host guard never trip during tests.
// The npm "test" script also sets it before Jest starts, which is the load-bearing one for babel inlining
// of process.env.EXPO_PUBLIC_*.
process.env.EXPO_PUBLIC_API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || "https://api.test.local";

export {};
