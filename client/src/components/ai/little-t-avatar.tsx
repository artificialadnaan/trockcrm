/** Little T — the T Rock assistant mascot: a friendly bot in a hard hat with a "T" badge. */
export function LittleTAvatar({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <svg
      className={`lt-avatar ${size === "lg" ? "is-lg" : "is-sm"}`}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Little T"
      fill="none"
    >
      {/* antenna */}
      <g className="lt-antenna">
        <line x1="32" y1="8" x2="32" y2="15" stroke="#232227" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="32" cy="6.5" r="3" fill="#f4a81d" />
      </g>
      {/* hard hat */}
      <path d="M13 26c0-11 8.5-18 19-18s19 7 19 18z" fill="#d4252e" />
      <rect x="9" y="25" width="46" height="5.5" rx="2.75" fill="#9e1b1f" />
      <rect x="29.5" y="9" width="5" height="17" rx="2.5" fill="#9e1b1f" opacity="0.55" />
      {/* head */}
      <rect x="15" y="30" width="34" height="27" rx="8" fill="#2e2d33" />
      <rect x="15" y="30" width="34" height="27" rx="8" stroke="#43424a" strokeWidth="1.5" />
      {/* face screen */}
      <rect x="20" y="35" width="24" height="14" rx="4" fill="#15141a" />
      {/* eyes */}
      <g className="lt-eye">
        <circle cx="27.5" cy="42" r="2.6" fill="#f4a81d" />
        <circle cx="36.5" cy="42" r="2.6" fill="#f4a81d" />
      </g>
      {/* smile */}
      <path d="M27 52.5q5 3 10 0" stroke="#d4252e" strokeWidth="2" strokeLinecap="round" />
      {/* T badge on the chin/neck */}
      <text x="32" y="56.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="#f4a81d" fontFamily="Saira Condensed, sans-serif">T</text>
    </svg>
  );
}
