export function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return current.toString();
      if (current instanceof Date && Number.isNaN(current.getTime())) return null;
      return current;
    })
  ) as T;
}
