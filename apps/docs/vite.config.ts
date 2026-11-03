import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "client"),
  plugins: [react(), tailwindcss()],
  build: { outDir: path.resolve(__dirname, "client/dist"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3001" },
  },
});
