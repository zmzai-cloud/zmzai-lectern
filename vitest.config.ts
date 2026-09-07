import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Release scripts use node:test so they exercise the production Node loader.
    exclude: [...configDefaults.exclude, "scripts/**/*.test.mjs"],
  },
});
