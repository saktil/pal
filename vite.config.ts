import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const SERVER = "http://127.0.0.1:7338";

export default defineConfig({
  root: "web",
  plugins: [svelte()],
  build: { outDir: "../dist/public", emptyOutDir: true },
  // Development only: Vite serves the UI and forwards the API to `pnpm dev:server`. The server accepts only its own
  // host and origin, so the proxy presents the request as the server's own.
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: SERVER,
        changeOrigin: true,
        configure: (proxy) =>
          proxy.on("proxyReq", (request) => {
            if (request.getHeader("origin") !== undefined) request.setHeader("origin", SERVER);
          }),
      },
    },
  },
});
