/**
 * 多项目管理：项目 = 本地文件夹路径。
 * - projects.json 存最近列表 + activeId（单用户本地应用，active 即全局状态：
 *   前端切换项目 → POST /api/projects select → 服务端切 active → 全站跟随）
 * - 默认项目 = 环境变量工作区（与老版本行为兼容，id 固定 "default"）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { createSqliteSessionStore, type SqliteSessionStore } from "@zmzai/agent-framework";
import { dataDir, defaultWorkspaceRoot } from "./runtime-constants.js";

const projectsFile = resolve(dataDir, "projects.json");

export type Project = { id: string; name: string; path: string; createdAt: string };

type ProjectsState = { activeId: string; projects: Project[] };

export const DEFAULT_PROJECT: Project = {
  id: "default",
  name: basename(defaultWorkspaceRoot) || "default",
  path: defaultWorkspaceRoot,
  createdAt: "1970-01-01T00:00:00.000Z",
};

function load(): ProjectsState {
  try {
    const raw = JSON.parse(readFileSync(projectsFile, "utf8")) as Partial<ProjectsState>;
    const projects = (raw.projects ?? []).filter((p) => p && p.id && p.path && p.id !== DEFAULT_PROJECT.id);
    const activeId = raw.activeId ?? DEFAULT_PROJECT.id;
    return { activeId, projects };
  } catch {
    return { activeId: DEFAULT_PROJECT.id, projects: [] };
  }
}

function save(state: ProjectsState) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(projectsFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function listProjects(): Project[] {
  return [DEFAULT_PROJECT, ...load().projects.filter((p) => existsSync(p.path) && statSync(p.path).isDirectory())];
}

/** Ownership lookup must include registered projects on temporarily missing disks. */
export function registeredProjects(): Project[] {
  return [DEFAULT_PROJECT, ...load().projects];
}

export function getActiveProject(): Project {
  const state = load();
  if (state.activeId === DEFAULT_PROJECT.id) return DEFAULT_PROJECT;
  return state.projects.find((p) => p.id === state.activeId && existsSync(p.path)) ?? DEFAULT_PROJECT;
}

export function setActiveProject(id: string): Project {
  const state = load();
  if (id === DEFAULT_PROJECT.id) {
    state.activeId = id;
  } else {
    const found = state.projects.find((p) => p.id === id);
    if (!found) throw new Error(`项目不存在: ${id}`);
    state.activeId = id;
  }
  save(state);
  return getActiveProject();
}

/** 添加项目（本地文件夹路径）。已存在时直接返回并激活。 */
export function addProject(rawPath: string): Project {
  const path = resolve(rawPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`文件夹不存在: ${path}`);
  if (path === resolve(DEFAULT_PROJECT.path)) return setActiveProject(DEFAULT_PROJECT.id);
  const state = load();
  const existing = state.projects.find((p) => resolve(p.path) === path);
  if (existing) return setActiveProject(existing.id);
  const project: Project = {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: basename(path),
    path,
    createdAt: new Date().toISOString(),
  };
  state.projects.push(project);
  state.activeId = project.id;
  save(state);
  return project;
}

/** 会话数据按项目分库：data/projects/<id>/（默认项目沿用旧 dataDir，兼容老数据）。 */
export function dataDirFor(project: Project): string {
  if (project.id === DEFAULT_PROJECT.id) return dataDir;
  return resolve(dataDir, "projects", project.id);
}

/** 按项目 id 取数据目录；未知项目不能回落到活动项目的数据目录。 */
export function dataDirForId(id: string): string {
  const project = registeredProjects().find((p) => p.id === id);
  if (!project) throw new Error("项目不存在");
  return dataDirFor(project);
}

declare global {
  // eslint-disable-next-line no-var
  var __lecternProjectStores: Map<string, SqliteSessionStore> | undefined;
}

/** 轻量 per-project store（跨项目会话列表 ?all=1 用）：只开一条 SQLite 连接读
 *  会话库，不装配 runtime/MCP/终端。WAL 模式多连接并发读安全；globalThis
 *  缓存避免 dev 热重载重复开连接。 */
export function projectStore(id: string): SqliteSessionStore {
  const cache = (globalThis.__lecternProjectStores ??= new Map());
  const cached = cache.get(id);
  if (cached) return cached;
  const project = id === DEFAULT_PROJECT.id ? DEFAULT_PROJECT : load().projects.find((p) => p.id === id);
  if (!project) throw new Error(`项目不存在: ${id}`);
  const dir = dataDirFor(project);
  mkdirSync(dir, { recursive: true });
  const store = createSqliteSessionStore({ dataDir: dir });
  cache.set(id, store);
  return store;
}

/** 工作区路径逃逸守卫（fs API 公共入口）。 */
export function resolveWithinWorkspace(root: string, relPath: string | null): string {
  const raw = (relPath ?? "").replace(/^\/+/, "");
  const abs = resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error("路径越出工作区");
  return abs;
}
