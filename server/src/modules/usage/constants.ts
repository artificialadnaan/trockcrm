/** Heartbeat cadence, in seconds. The client sends one heartbeat per interval while active. */
export const HEARTBEAT_INTERVAL_S = 30;
/** Merge tolerance, in seconds. Consecutive active windows within this gap are treated contiguous. */
export const HEARTBEAT_GRACE_S = 5;
/** Raw heartbeat/view rows are kept this many days before the gated prune removes them. */
export const RAW_RETENTION_DAYS = 14;
