import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8090",
        ws: true,
      },
      "/healthz": "http://127.0.0.1:8090",
    },
  },
});
