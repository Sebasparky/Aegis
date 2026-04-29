/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aegis: {
          bg: "#0a0f1a",
          surface: "#111827",
          border: "#1f2937",
          accent: "#6366f1",
        },
      },
    },
  },
  plugins: [],
};
