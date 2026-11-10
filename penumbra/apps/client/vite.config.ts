import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const FEED = process.env.PENUMBRA_FEED ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/ws": { target: FEED.replace(/^http/, "ws"), ws: true }, "/api": { target: FEED } },
    fs: { allow: ["../.."] },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 2500 },
});
