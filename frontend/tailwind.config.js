/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        vscode: {
          bg: "#1e1e1e",
          sidebar: "#252526",
          panel: "#1e1e1e",
          border: "#3e3e42",
          accent: "#0078d4",
          text: "#cccccc",
          muted: "#858585",
          hover: "#2a2d2e",
          active: "#37373d",
          tab: "#2d2d2d",
          tabActive: "#1e1e1e",
          statusbar: "#007acc",
        },
      },
      fontFamily: {
        mono: ["Consolas", "Monaco", "Courier New", "monospace"],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
