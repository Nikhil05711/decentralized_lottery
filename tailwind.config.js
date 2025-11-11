/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          blue: "#38bdf8",
          cyan: "#22d3ee",
          midnight: "#020617",
        },
      },
      animation: {
        "slow-spin": "spin 18s linear infinite",
      },
    },
  },
  plugins: [],
};

