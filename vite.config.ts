import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [svelte()],
  build: { outDir: "../dist/public", emptyOutDir: true },
  // Development only: Vite serves the UI and forwards the API to `pnpm dev:server`.
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:7338" } },
});
