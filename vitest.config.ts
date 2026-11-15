import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  /**
   * The same `@shared/*` alias the app builds with (`tsconfig.base.json`). It is only needed
   * by a test that imports a main-process module which itself imports the contract at
   * runtime — `attachments/handlers.ts` is the first, because it registers IPC channels.
   * Without this, vitest cannot resolve the specifier and the import fails at load.
   */
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared"),
    },
  },
  test: {
    // e2e is Playwright's; vitest owns unit and integration.
    include: ["tests/unit/**/*.spec.ts", "tests/integration/**/*.spec.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
