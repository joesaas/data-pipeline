import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // Absolute asset base, not "./". The API is reached through an nginx
  // proxy that strips the /data-pipeline prefix, and the console must
  // work with or without a trailing slash on its URL. A relative base
  // resolves assets against the page URL's parent directory, which is
  // wrong for the bare /data-pipeline/console URL (assets would resolve
  // to /data-pipeline/assets/... and 404). The absolute base resolves
  // identically under both proxy shapes: preserving proxies serve it
  // from the /data-pipeline/console mount, stripping proxies from the
  // /console mount. This assumes the public mount prefix stays
  // /data-pipeline/console (the documented PUBLIC_BASE).
  base: "/data-pipeline/console/",
  build: { outDir: "dist", emptyOutDir: true },
});
