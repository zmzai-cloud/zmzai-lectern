import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // Release scripts use node:test so they exercise the production Node loader.
    // .worktrees/ 是隔离工作副本（已 gitignore）：不排除会把副本测试在主 checkout 上下文里重跑，产生假失败
    exclude: [...configDefaults.exclude, "scripts/**/*.test.mjs", ".worktrees/**"],
  },
});
