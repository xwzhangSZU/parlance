import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests under src/test import the `vscode` module, which only
    // exists inside the Extension Host. Keep vitest away from them — they run
    // via @vscode/test-cli (npm run test:integration), not vitest.
    exclude: ["src/test/**", "**/node_modules/**", "**/dist/**", "**/out-test/**"],
  },
});
