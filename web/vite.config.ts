import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Output: dist/assets/{app.js,app.css,chunks}; web/public/* is copied to dist/ root (not assets/).
export default defineConfig({
  base: "/assets/",
  publicDir: false,
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  plugins: [
    {
      name: "copy-public-to-dist-root",
      apply: "build",
      closeBundle() {
        cpSync(here("./public"), here("./dist"), { recursive: true });
      },
    },
  ],
  build: {
    outDir: here("./dist/assets"),
    emptyOutDir: true,
    assetsDir: "",
    target: "es2022",
    cssCodeSplit: false,
    rollupOptions: {
      input: here("./src/main.ts"),
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: (a) => (a.names?.some((n) => n.endsWith(".css")) ? "app.css" : "[name]-[hash][extname]"),
      },
    },
  },
});
