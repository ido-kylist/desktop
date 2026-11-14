import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve(root, "src/shared"),
        "@main": resolve(root, "src/main"),
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(root, "src/main/index.ts") } },
    },
  },
  preload: {
    // No externalizeDepsPlugin here, deliberately. A sandboxed preload's `require`
    // is restricted to a tiny allowlist (electron and a few builtins), so every
    // other dependency — zod included, via the shared contract — must be bundled.
    resolve: {
      alias: { "@shared": resolve(root, "src/shared") },
    },
    build: {
      // Sandboxed preloads cannot be ESM, so this target is always CommonJS
      // regardless of the package's "type": "module".
      rollupOptions: {
        external: ["electron"],
        input: { index: resolve(root, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(root, "src/renderer/src"),
        "@shared": resolve(root, "src/shared"),
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(root, "src/renderer/index.html") } },
    },
  },
});
