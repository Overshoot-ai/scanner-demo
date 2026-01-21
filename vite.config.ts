import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    https: true, // Enable HTTPS for camera and sensor access
    host: true, // Expose to network for mobile testing
    port: 3001,
  },
  optimizeDeps: {
    exclude: ["@anthropic-ai/sdk"],
  },
});
