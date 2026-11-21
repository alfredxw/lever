import { defineConfig, normalizePath } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: ["cmaps", "standard_fonts", "wasm"].map((directory) => ({
        src: normalizePath(
          fileURLToPath(
            new URL(`./node_modules/pdfjs-dist/${directory}`, import.meta.url),
          ),
        ),
        dest: "pdfjs",
      })),
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5179,
    strictPort: true,
    proxy:
      mode === "desktop"
        ? undefined
        : { "/api": { target: "http://127.0.0.1:4778", ws: true } },
  },
  build: { target: "es2022" },
  worker: { format: "es" },
  // Imports reached through lazy panes or workers can trigger a desktop reload
  // when Vite first discovers them in dev mode.
  optimizeDeps: {
    include: [
      "@pierre/trees",
      "heic-to/csp",
      "tiff",
      "jszip",
      "sql.js",
      "mammoth",
      "read-excel-file/web-worker",
      "entities",
      "fast-xml-parser",
      "saxes",
      "image-size",
      "modern-tar",
    ],
  },
}));
