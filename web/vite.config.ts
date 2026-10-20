import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: { proxy: { "/api": "http://localhost:8787", "/auth": "http://localhost:8787", "/ws": { target: "ws://localhost:8787", ws: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
