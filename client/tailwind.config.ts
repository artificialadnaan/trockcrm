import type { Config } from "tailwindcss";
import tailwindAnimate from "tailwindcss-animate";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          purple: "#7C3AED",
          cyan: "#06B6D4",
        },
        sidebar: {
          bg: "#0F172A",
          hover: "#1E293B",
          active: "#7C3AED22",
        },
      },
    },
  },
  plugins: [tailwindAnimate],
} satisfies Config;
