import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "pwa-*.png"],
      manifest: {
        id: "/",
        name: "term-server",
        short_name: "term-server",
        description: "A fast, secure terminal workspace that lives in your browser.",
        theme_color: "#181818",
        background_color: "#181818",
        display: "standalone",
        orientation: "any",
        scope: "/",
        start_url: "/",
        categories: ["developer", "productivity", "utilities"],
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{css,html,ico,js,png,svg,woff2}"],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/healthz$/],
      },
    }),
  ],
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
