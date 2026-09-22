/** M2b（B1）：Host 进程内的真实 runtime 装配入口。
 *  lib/ 代码不搬不改——host 构建把 lib 连带编译进 dist。
 *  R-1 spike 已验证：lib 相对导入补 .js 后缀（Next/vitest 兼容），
 *  host NodeNext 可连带编译。 */
export { runtimeFor, sessionRuntime, cloudRuntime, defaultWorkspaceRoot, setSessionCredentialProvider } from "../../lib/runtime.js";
export { listProjects, dataDirFor } from "../../lib/projects.js";
export { resolveSessionOwner } from "../../lib/session-owner.js";
