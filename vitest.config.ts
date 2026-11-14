import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e is Playwright's; vitest owns unit and integration.
    include: ["tests/unit/**/*.spec.ts", "tests/integration/**/*.spec.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
