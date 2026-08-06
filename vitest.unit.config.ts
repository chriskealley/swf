import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "extensions/pi/test/**/*.test.ts",
    ],
    environment: "node",
  },
});
