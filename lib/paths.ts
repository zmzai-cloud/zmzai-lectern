import { resolve, sep } from "node:path";

import { activeWorkspaceRoot } from "./runtime.js";

/**
 * 把用户提供的相对路径安全解析到 workspaceRoot 内。
 * 拒绝符号逃逸（.. 越界）与绝对路径注入，是 fs/git API 的公共守卫。
 */
export function resolveWithinWorkspace(relPath: string | null, root = activeWorkspaceRoot()): string {
  const raw = (relPath ?? "").replace(/^\/+/, "");
  const workspaceRoot = resolve(root);
  const abs = resolve(workspaceRoot, raw);
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + sep)) {
    throw new Error("路径越出工作区");
  }
  return abs;
}
