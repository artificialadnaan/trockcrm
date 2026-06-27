/** The T Rock logo, used as Little T's mark throughout the demo. Served from /logo.png. */
export function LittleTAvatar({ size = "sm" }: { size?: "sm" | "lg" | "hero" }) {
  const cls = size === "hero" ? "is-hero" : size === "lg" ? "is-lg" : "is-sm";
  return <img className={`lt-avatar ${cls}`} src="/logo.png" alt="T Rock" />;
}
