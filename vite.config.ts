import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // Browser-mode debugging: api.skillsafe.ai's CORS only accepts the
    // skillsafe.ai origin, so proxy /v1/* through Vite and rewrite the Origin
    // header. The Tauri build bypasses this entirely (it uses plugin-http on
    // the Rust side, which has no CORS).
    proxy: {
      "/v1": {
        target: "https://api.skillsafe.ai",
        changeOrigin: true,
        secure: true,
        headers: { Origin: "https://skillsafe.ai" },
      },
    },
  },
  build: {
    // Desktop app — the binary ships once; sub-MB JS chunks aren't
    // bandwidth-critical, so the 500 KB nag is just noise.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // gray-matter's optional engine-resolver uses eval(); we don't
        // exercise that code path. Silence the noise but keep all other
        // eval warnings visible (e.g. from our own code).
        if (
          warning.code === "EVAL" &&
          typeof warning.id === "string" &&
          warning.id.includes("gray-matter")
        ) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
