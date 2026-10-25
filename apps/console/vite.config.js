import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // Relative asset URLs so the same build works under both /console and
  // /data-pipeline/console (the API mounts the SPA at both prefixes).
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
