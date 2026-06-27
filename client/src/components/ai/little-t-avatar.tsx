/** Little T — the T Rock assistant mascot: a friendly construction buddy in a red hard hat. */
export function LittleTAvatar({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <svg
      className={`lt-avatar ${size === "lg" ? "is-lg" : "is-sm"}`}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Little T"
      fill="none"
    >
      {/* antenna with a friendly amber bobble */}
      <g className="lt-antenna">
        <line x1="32" y1="12" x2="32" y2="19" stroke="#b51f27" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="32" cy="9.5" r="3.2" fill="#f4a81d" />
      </g>
      {/* red hard hat */}
      <path d="M14 28a18 16 0 0 1 36 0Z" fill="#d4252e" />
      <rect x="10.5" y="26" width="43" height="5.5" rx="2.75" fill="#b51f27" />
      {/* soft rounded head */}
      <rect x="16" y="30" width="32" height="27" rx="13" fill="#f5f0e7" stroke="#e4ddd0" strokeWidth="1.4" />
      {/* rosy cheeks */}
      <circle cx="21.5" cy="47" r="3" fill="#d4252e" opacity="0.16" />
      <circle cx="42.5" cy="47" r="3" fill="#d4252e" opacity="0.16" />
      {/* big friendly eyes with sparkle highlights */}
      <g className="lt-eye">
        <circle cx="26" cy="42" r="4.7" fill="#ffffff" stroke="#e4ddd0" strokeWidth="0.8" />
        <circle cx="38" cy="42" r="4.7" fill="#ffffff" stroke="#e4ddd0" strokeWidth="0.8" />
        <circle cx="26.7" cy="42.6" r="2.4" fill="#2b2a33" />
        <circle cx="38.7" cy="42.6" r="2.4" fill="#2b2a33" />
        <circle cx="25.8" cy="41.6" r="0.85" fill="#ffffff" />
        <circle cx="37.8" cy="41.6" r="0.85" fill="#ffffff" />
      </g>
      {/* happy smile */}
      <path d="M27 49.5q5 4 10 0" stroke="#d4252e" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
