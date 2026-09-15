import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // Release scripts use node:test so they exercise the production Node loader.
    exclude: [...configDefaults.exclude, "scripts/**/*.test.mjs"],
  },
});
