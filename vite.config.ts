import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // Expose to network for mobile testing
    port: 3000,
  },
  optimizeDeps: {
    exclude: ["@anthropic-ai/sdk"],
  },
});
