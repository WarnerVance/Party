import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        slate: {
          925: "#121621"
        }
      }
    }
  },
  plugins: []
} satisfies Config;
