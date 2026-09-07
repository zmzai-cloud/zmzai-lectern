"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, SlidersHorizontal, ShieldCheck, History, KeyRound, Plug, Blocks, Sparkles } from "lucide-react";
import { Button, Navbar } from "@zmzai/theme";

import AccountBlock from "@/components/AccountBlock";
import ThemeToggle from "@/components/ThemeToggle";
import { client } from "@/lib/client";
import { readPref, writePref } from "@/lib/prefs";
import type { KeyStatus, McpStatuses, PermissionDomain, PermissionSettings, PluginInfo, RelayKeyInfo, SkillOption, FailoverEventView } from "@/lib/types";

/**
 * 设置中心（独立页，替代旧版弹窗）：左侧导航 + 右侧分区内容。
 * 通用（外观、relay 服务端点）/ Agent 与权限 / 权限日志 /
 * 模型与凭据（个人 key、轮换、本地 Ollama）/ 插件组（MCP、插件、技能）。
 * 所有修改保存即生效，无需重启。
 */

type SectionId = "general" | "agent" | "audit" | "credentials" | "mcp" | "plugins" | "skills";

const PRIMARY_NAV: { id: SectionId; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "agent", label: "Agent 与权限" },
  { id: "audit", label: "权限日志" },
  { id: "credentials", label: "模型与凭据" },
];

const EXTENSION_NAV: { id: Extract<SectionId, "mcp" | "plugins" | "skills">; label: string }[] = [
  { id: "mcp", label: "MCP" },
  { id: "plugins", label: "插件" },
  { id: "skills", label: "技能" },
];
const SECTION_ICON = { general: SlidersHorizontal, agent: ShieldCheck, audit: History, credentials: KeyRound, mcp: Plug, plugins: Blocks, skills: Sparkles };
const SECTION_DESCRIPTION: Record<SectionId, string> = {
  general: "让 Lectern 适合你的工作习惯。",
  agent: "选择 Agent 在工作中可以执行的操作。",
  audit: "查看每一次授权决定及其来源。",
  credentials: "连接模型服务，管理访问凭据。",
  mcp: "连接外部工具和数据源。",
  plugins: "管理工作区与本机的扩展能力。",
  skills: "浏览 Agent 可以使用的技能。",
};

const SKILL_SOURCE: Record<SkillOption["source"], { label: string; detail: string }> = {
  workspace: { label: "工作区", detail: ".zmzai/skills" },
  codex: { label: "Codex", detail: "~/.codex/skills" },
  agents: { label: "本机 Agent", detail: "~/.agents/skills" },
};

/** 分区标题 + 卡片容器（Qoder 式设置分组）。 */
function Card({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section mb-8">
      <h2 className="mb-1 text-base font-semibold text-ink">{title}</h2>
      {desc && <p className="mb-3 text-xs leading-5 text-ink-3">{desc}</p>}
      <div className="settings-fields py-4">{children}</div>
    </section>
  );
}

const inputClass =
  "h-9 min-w-0 flex-1 rounded-sm border border-line bg-bg px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-ink";

const selectClass =
  "h-8 w-36 shrink-0 rounded-sm border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-ink";

/** 权限与自动执行（Qoder 同款）：敏感操作域可各自配置「逐次确认 / 自动执行」。
 *  对应 framework 权限键：terminal+bash / edit / task / git_write。 */
const PERM_ROWS: { domain: PermissionDomain; title: string; desc: string }[] = [
  { domain: "terminal", title: "终端", desc: "所有终端命令（bash 与交互式终端）自动运行，无需审批。" },
  { domain: "edit", title: "文件编辑", desc: "写文件 / 编辑文件自动执行，不再逐次确认。" },
  { domain: "task", title: "计划智能体", desc: "派生子代理执行子任务时自动运行。" },
  { domain: "gitWrite", title: "Git 写操作", desc: "commit 等写操作自动执行（diff 仍可在产物面板审查）。" },
];

function PermCard({ perm, onChange }: { perm: PermissionSettings; onChange: (domain: PermissionDomain, value: "ask" | "auto") => void }) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-base font-semibold text-ink">权限与自动执行</h2>
      <p className="mb-3 text-xs leading-5 text-ink-3">
        默认所有敏感操作逐次确认；将域切到「自动执行」后授权请求自动「始终允许」，工作流不再被打断。配置保存在 settings.json，全会话生效。
      </p>
      <div className="overflow-hidden rounded-md border border-line bg-surface">
        {PERM_ROWS.map((row, i) => (
          <div key={row.domain} className={"flex items-center gap-3 px-4 py-3 " + (i > 0 ? "border-t border-line" : "")}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">{row.title}</div>
              <div className="mt-0.5 text-xs leading-5 text-ink-3">{row.desc}</div>
            </div>
            <select
              value={perm[row.domain] ?? "ask"}
              onChange={(e) => onChange(row.domain, e.target.value as "ask" | "auto")}
              className={selectClass}
            >
              <option value="ask">每次确认</option>
              <option value="auto">自动执行</option>
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

const fmtMicros = (v: number) => (v >= 1_000_000 ? `¥${(v / 1_000_000).toFixed(2)}` : `¥${(v / 1_000_000).toFixed(4)}`);

/** 权限审计日志：最近 200 条授权决定（手动 / 自动档 / 细粒度自动三分）。 */
const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  manual: { label: "手动", cls: "bg-surface-2 text-ink-2" },
  auto: { label: "自动档", cls: "bg-live-tint text-live" },
  "fine-grained": { label: "细粒度自动", cls: "bg-warning-tint text-warning" },
};

function AuditCard() {
  const [rows, setRows] = useState<{ at: string; sessionId: string; permission: string; summary: string; decision: string; source: string }[]>([]);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    void client.auditList(filter || undefined).then(setRows).catch(() => setRows([]));
  }, [filter]);

  return (
    <section className="mb-8">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="mb-1 text-base font-semibold text-ink">权限日志</h2>
          <p className="mb-3 text-xs leading-5 text-ink-3">最近 200 条授权决定。自动档给 Agent 松绑后，这里是事后追溯的安全带。</p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={selectClass}>
          <option value="">全部工具域</option>
          {PERM_ROWS.map((r) => (
            <option key={r.domain} value={r.domain}>
              {r.title}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-surface">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs leading-5 text-ink-3">暂无记录。批准或拒绝授权后会出现在这里。</div>
        ) : (
          rows.map((row, i) => {
            const src = SOURCE_LABEL[row.source] ?? { label: row.source, cls: "bg-surface-2 text-ink-2" };
            return (
              <div key={`${row.at}-${i}`} className={"flex items-center gap-2.5 px-4 py-2 " + (i > 0 ? "border-t border-line" : "")}>
                <span className="w-8 shrink-0 text-center">
                  <span className={"inline-block rounded-sm px-1 py-0.5 text-[0.625rem] font-medium " + (row.decision === "reject" ? "bg-danger-tint text-danger" : "bg-success-tint text-success")}>
                    {row.decision === "reject" ? "拒绝" : "允许"}
                  </span>
                </span>
                <span className="w-20 shrink-0 truncate text-xs text-ink-2" title={row.permission}>
                  {PERM_ROWS.find((r) => r.domain === row.permission)?.title ?? row.permission}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink-3" title={row.summary}>
                  {row.summary || "—"}
                </span>
                <span className={"shrink-0 rounded-sm px-1.5 py-0.5 text-[0.625rem] font-medium " + src.cls}>{src.label}</span>
                <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">
                  {new Date(row.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** 降级端点（设置 → 模型与凭据 → 降级端点）：主 relay 端点首事件失败时依次切换。
 *  可增删改多个备用端点，apiKey 仅掩码回显（留掩码 = 沿用旧 key，空 = 清除）。 */
function FailoverCard() {
  const [rows, setRows] = useState<{ baseUrl: string; modelId: string; apiKey: string; apiKeyMasked: string | null; dirty: boolean }[]>([]);
  const [log, setLog] = useState<FailoverEventView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void client.failoverGet().then((r) => {
      setRows(r.endpoints.map((ep) => ({ baseUrl: ep.baseUrl, modelId: ep.modelId ?? "", apiKey: "", apiKeyMasked: ep.apiKeyMasked, dirty: false })));
      setLog(r.failover);
    }).catch(() => undefined);
  }, []);

  const add = () => setRows((r) => [...r, { baseUrl: "", modelId: "", apiKey: "", apiKeyMasked: null, dirty: true }]);

  const update = (i: number, patch: Partial<{ baseUrl: string; modelId: string; apiKey: string }>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch, dirty: true } : row)));

  const remove = (i: number) => setRows((r) => r.filter((_, j) => j !== i));

  const save = () =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const endpoints = rows
          .filter((r) => r.baseUrl.trim())
          .map((r) => ({
            baseUrl: r.baseUrl.trim(),
            modelId: r.modelId.trim() || null,
            // apiKey 空但 apiKeyMasked 存在 → 未改动，保留旧 key（服务端按掩码匹配沿用）
            apiKey: r.apiKey.trim() || null,
            apiKeyMasked: r.apiKeyMasked,
          }));
        const res = await client.failoverSave(endpoints);
        setRows(res.endpoints.map((ep) => ({ baseUrl: ep.baseUrl, modelId: ep.modelId ?? "", apiKey: "", apiKeyMasked: ep.apiKeyMasked, dirty: false })));
        setLog(res.failover);
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存失败");
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Card title="降级端点" desc="主 relay 端点首个事件失败时，依次切换到这些备用 OpenAI 兼容端点。留空 = 不降级（仅主端点）。">
      {rows.length === 0 ? (
        <div className="mb-3 rounded-sm bg-bg px-2.5 py-2 text-[0.6875rem] leading-5 text-ink-3">
          未配置降级端点。主端点不可用时请求会直接失败；配置一个备用端点可在主端点故障时自动切换。
        </div>
      ) : (
        <div className="mb-3 space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={row.baseUrl}
                onChange={(e) => update(i, { baseUrl: e.target.value })}
                placeholder="https://backup.zmzai.cloud/v1"
                spellCheck={false}
                autoComplete="off"
                className={inputClass}
              />
              <input
                value={row.modelId}
                onChange={(e) => update(i, { modelId: e.target.value })}
                placeholder="模型 id（可选）"
                spellCheck={false}
                autoComplete="off"
                className="h-9 w-36 shrink-0 rounded-sm border border-line bg-bg px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-ink"
              />
              <input
                value={row.apiKey}
                onChange={(e) => update(i, { apiKey: e.target.value })}
                placeholder={row.apiKeyMasked ?? "apiKey（可选）"}
                type="password"
                spellCheck={false}
                autoComplete="off"
                className="h-9 w-32 shrink-0 rounded-sm border border-line bg-bg px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-ink"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                className="shrink-0 rounded-sm px-1.5 py-1 text-xs text-ink-3 transition-colors hover:text-danger"
                aria-label="删除端点"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={add} className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink">
          + 添加端点
        </button>
        <Button variant="primary" size="sm" disabled={busy} onClick={save}>
          保存
        </Button>
        {saved && <span className="text-[0.6875rem] text-success">已保存，后续请求即时生效。</span>}
        {error && <span className="text-[0.6875rem] text-danger">{error}</span>}
      </div>

      {log.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-1.5 text-[0.6875rem] font-semibold text-ink-3">最近降级记录</div>
          <div className="space-y-1">
            {log.map((e, i) => (
              <div key={i} className="flex items-center gap-2 font-mono text-[0.625rem] text-ink-3">
                <span className="shrink-0 text-warning">#{e.attempt}</span>
                <span className="truncate">{e.from ?? "(主端点)"}</span>
                <span className="shrink-0 text-ink-3">→</span>
                <span className="truncate">{e.to}</span>
                <span className="ml-auto shrink-0 truncate text-ink-3" title={e.error}>{e.error.slice(0, 60)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const [section, setSection] = useState<SectionId>("general");
  // 左侧导航收起/展开（与工作台同一持久化键约定）
  const [navOpen, setNavOpen] = useState(true);
  const [status, setStatus] = useState<KeyStatus | null>(null);

  // ===== 通用：relay 端点 =====
  const [relayDraft, setRelayDraft] = useState("");
  const [relaySaved, setRelaySaved] = useState(false);
  // ===== 通用：权限与自动执行 =====
  const [perm, setPerm] = useState<PermissionSettings>({});
  const [permSaved, setPermSaved] = useState(false);
  // ===== 模型与凭据 =====
  const [keyDraft, setKeyDraft] = useState("");
  const [ollamaDraft, setOllamaDraft] = useState("");
  const [rotated, setRotated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // ===== MCP =====
  const [mcp, setMcp] = useState<McpStatuses | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  // ===== 插件 =====
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginDraft, setPluginDraft] = useState("");
  const [pluginBusy, setPluginBusy] = useState(false);
  // ===== Skills（工作区 + 已安装的本机 Codex/Agent 技能，只读发现） =====
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  // ===== relay 账号联动 =====
  const [relayKeys, setRelayKeys] = useState<RelayKeyInfo | null>(null);
  const [issuing, setIssuing] = useState(false);

  const refreshRelayKeys = useCallback(() => {
    void client.relayKeys().then(setRelayKeys).catch(() => undefined);
  }, []);

  useEffect(() => {
    void client.keyStatus().then((s) => {
      setStatus(s);
      setRelayDraft(s.relayUrl ?? "");
      setOllamaDraft(s.ollamaUrl ?? "");
    }).catch(() => undefined);
    void client.mcpStatus().then(setMcp).catch(() => undefined);
    void client.pluginsList().then((r) => setPlugins(r.plugins)).catch(() => undefined);
    void client.listSkills().then((r) => setSkills(r.skills)).catch(() => undefined);
    void client.permissionsGet().then(setPerm).catch(() => undefined);
    refreshRelayKeys();
  }, [refreshRelayKeys]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const saveRelay = () =>
    void run(async () => {
      setStatus(await client.keySaveRelay(relayDraft.trim() || null));
      setRelaySaved(true);
      setSaved(true);
    });

  // 恢复默认 = 清除 settings.json 里的 relayUrl（回到 env/默认端点）
  const resetRelay = () =>
    void run(async () => {
      setStatus(await client.keySaveRelay(null));
      setRelayDraft(status?.relayUrl ?? "");
      setRelaySaved(true);
    });

  // 权限域切换（保存即生效，进行中会话的下一次授权请求就按新档位处理）
  const setPermDomain = (domain: PermissionDomain, value: "ask" | "auto") =>
    void run(async () => {
      setPerm(await client.permissionsSave({ [domain]: value }));
      setPermSaved(true);
    });

  const saveKey = () =>
    void run(async () => {
      setStatus(await client.keySave(keyDraft.trim()));
      setKeyDraft("");
      setSaved(true);
    });

  const clearKey = () =>
    void run(async () => {
      setStatus(await client.keyClear());
      setSaved(false);
    });

  const rotate = () =>
    void run(async () => {
      await client.keyRotate();
      setRotated(true);
    });

  const saveOllama = () =>
    void run(async () => {
      setStatus(await client.keySaveOllama(ollamaDraft.trim() || null));
      setSaved(true);
    });

  // relay 联动：登录态一键在 relay 侧签发名为 harness 的 key 并绑定（明文不经过 UI/剪贴板）
  const issueKey = () =>
    void run(async () => {
      setIssuing(true);
      try {
        setStatus(await client.relayKeyIssue());
        setSaved(true);
        refreshRelayKeys();
      } finally {
        setIssuing(false);
      }
    });

  const rescanMcp = () =>
    void run(async () => {
      setMcpBusy(true);
      try {
        setMcp(await client.mcpRescan());
      } finally {
        setMcpBusy(false);
      }
    });

  const refreshPlugins = useCallback(async () => {
    try {
      setPlugins((await client.pluginsList()).plugins);
    } catch {
      // 列表刷新失败不阻塞页面
    }
  }, []);

  const refreshSkills = () =>
    void run(async () => {
      setSkillsBusy(true);
      try {
        setSkills((await client.listSkills()).skills);
      } finally {
        setSkillsBusy(false);
      }
    });

  const installPlugin = () =>
    void run(async () => {
      const sourcePath = pluginDraft.trim();
      if (!sourcePath) return;
      setPluginBusy(true);
      try {
        const res = await client.pluginInstall(sourcePath);
        if (!res.ok) throw new Error(res.error ?? "安装失败");
        setPluginDraft("");
        await refreshPlugins();
      } finally {
        setPluginBusy(false);
      }
    });

  const uninstallPlugin = (name: string) =>
    void run(async () => {
      setPluginBusy(true);
      try {
        await client.pluginUninstall(name);
        await refreshPlugins();
      } finally {
        setPluginBusy(false);
      }
    });

  const toggleNav = () =>
    setNavOpen((v) => {
      writePref("sidebar", v ? "0" : "1");
      return !v;
    });

  const toggleNavBtn = (
    <button
      type="button"
      onClick={toggleNav}
      title={navOpen ? "收起导航" : "展开导航"}
      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M6 2.5v11" />
      </svg>
    </button>
  );

  return (
    <div className="settings-page flex h-full flex-col bg-bg text-ink">
      <Navbar
        sublabel="设置"
        className="h-12"
        actions={toggleNavBtn}
      />

      <div className="flex min-h-0 flex-1">
        {/* 左侧导航（Qoder 式设置中心，可收起） */}
        {navOpen && (
        <aside className="settings-sidebar flex w-60 shrink-0 flex-col bg-surface p-4">
          <Link
            href="/"
            className="mb-3 inline-flex h-9 items-center gap-2 rounded-sm px-2.5 text-[0.8125rem] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
            返回任务
          </Link>
          <nav aria-label="设置分类" className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-0.5">
            {PRIMARY_NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
                className={
                  "flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors " +
                  (section === item.id ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-3")
                }
              >
                {(() => { const Icon = SECTION_ICON[item.id]; return <Icon size={16} strokeWidth={1.6} aria-hidden />; })()}{item.label}
              </button>
            ))}
            </div>
            <div className="mt-5">
              <div className="px-2.5 pb-2 text-[0.6875rem] font-medium text-ink-3">扩展能力</div>
              <div className="space-y-0.5">
                {EXTENSION_NAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={section === item.id ? "page" : undefined}
                    onClick={() => setSection(item.id)}
                    className={
                      "flex w-full items-center rounded-sm py-1.5 pr-2.5 pl-5 text-left text-[0.8125rem] transition-colors " +
                      (section === item.id ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-3")
                    }
                  >
                    {(() => { const Icon = SECTION_ICON[item.id]; return <Icon size={16} strokeWidth={1.6} aria-hidden />; })()}<span className="min-w-0 flex-1">{item.label}</span>
                    {item.id === "mcp" && mcp && <span className="font-mono text-[0.625rem] text-ink-3">{mcp.statuses.length}</span>}
                    {item.id === "plugins" && <span className="font-mono text-[0.625rem] text-ink-3">{plugins.length}</span>}
                    {item.id === "skills" && <span className="font-mono text-[0.625rem] text-ink-3">{skills.length}</span>}
                  </button>
                ))}
              </div>
            </div>
          </nav>

          {/* 底部账户块独立锚定：导航增长时只滚导航，账户始终贴住侧栏底部。 */}
          <div className="mt-auto border-t border-line pt-3">
            <AccountBlock onChange={() => refreshRelayKeys()} />
          </div>

        </aside>
        )}

        {/* 右侧内容区 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="settings-content mx-auto max-w-[820px] px-10 py-10">
            <div className="mb-9">
              <p className="mb-2 text-xs text-ink-3">设置</p>
              <h1 className="text-2xl font-semibold tracking-tight">{[...PRIMARY_NAV, ...EXTENSION_NAV].find((item) => item.id === section)?.label}</h1>
              <p className="mt-2 text-sm text-ink-3">{SECTION_DESCRIPTION[section]}</p>
            </div>
            {error && <div className="mb-4 rounded-sm border border-line bg-surface px-2.5 py-2 text-xs text-danger">{error}</div>}

            {section === "general" && (
              <>
                <Card title="外观" desc="选择 Lectern 的显示主题。设置会立即应用，并在下次启动时保留。">
                  <div className="flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink">界面主题</div>
                      <div className="mt-0.5 text-xs leading-5 text-ink-3">跟随系统、浅色和深色三种模式。</div>
                    </div>
                    <ThemeToggle />
                  </div>
                </Card>
                <Card title="模型服务地址" desc="用于获取可用模型和发送消息。保存后，从下一条消息开始使用新地址。">
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      value={relayDraft}
                      onChange={(e) => setRelayDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRelay();
                      }}
                      placeholder="https://relay.zmzai.cloud/api/v1"
                      spellCheck={false}
                      autoComplete="off"
                      className={inputClass}
                    />
                    <Button variant="primary" size="sm" disabled={busy} onClick={saveRelay}>
                      保存
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={resetRelay}>
                      恢复默认
                    </Button>
                  </div>
                  {relaySaved && <div className="mb-2 text-[0.6875rem] text-success">已保存，后续请求使用新端点。</div>}
                  <div className="rounded-sm bg-bg px-2.5 py-2 text-[0.6875rem] leading-5 text-ink-3">
                    <div>申请入口：relay 控制台 → API Keys → 新建 key（zrk_ 开头），配「模型与凭据」里的个人 key 使用。</div>
                  </div>
                </Card>
                <Card title="关于 Lectern" desc="在一个工作区中讨论想法、执行任务，并查看文件变更和成果。">
                  <div className="text-[0.6875rem] leading-5 text-ink-3">
                    <div>数据目录：data/（settings.json 0600、zmzai.db WAL、.secret 密钥文件）</div>
                    <div>插件目录：&lt;workspace&gt;/.zmzai/plugins/（项目）与 data/plugins/（全局）</div>
                  </div>
                </Card>
              </>
            )}

            {section === "agent" && (
              <>
                <PermCard perm={perm} onChange={setPermDomain} />
                {permSaved && <div className="-mt-5 mb-6 text-[0.6875rem] text-success">权限配置已保存，立即生效。</div>}
              </>
            )}

            {section === "audit" && <AuditCard />}

            {section === "credentials" && (
              <>
                <Card
                  title="个人 key"
                  desc="配置后模型请求以 Bearer 直连 relay（不依赖浏览器登录态），用量计入你的 relay 账户。key 全量不出服务端，仅掩码回显。"
                >
                  {/* relay 账号联动：一键签发 + 账号 key 列表 */}
                  {relayKeys?.loggedIn ? (
                    <div className="mb-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="min-w-0 flex-1 text-[0.6875rem] leading-5 text-ink-2">
                          relay 账号已登录，可一键签发专用 key（名为 harness）并自动绑定，明文不经过剪贴板。
                        </span>
                        <Button variant="primary" size="sm" disabled={issuing || busy} onClick={issueKey}>
                          {issuing ? "签发中…" : "一键签发并绑定"}
                        </Button>
                      </div>
                      {relayKeys.keys.length > 0 && (
                        <div className="space-y-1">
                          {relayKeys.keys.map((k) => {
                            const active = k.prefix && k.prefix === relayKeys.currentPrefix;
                            return (
                              <div key={k.id} className="flex items-center gap-2 rounded-sm border border-line bg-bg px-2.5 py-1.5">
                                <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (k.status === "active" ? "bg-success" : "bg-danger")} />
                                <span className="shrink-0 font-mono text-xs text-ink">{k.prefix}…</span>
                                <span className="min-w-0 truncate text-[0.6875rem] text-ink-2">{k.name || "未命名"}</span>
                                {active && (
                                  <span className="shrink-0 rounded-sm bg-ink px-1.5 py-0.5 text-[0.5625rem] font-medium text-bg">使用中</span>
                                )}
                                <span className="ml-auto shrink-0 text-[0.625rem] text-ink-3">
                                  本月 {fmtMicros(k.monthlySpendUsedMicros)}{k.monthlySpendLimitMicros > 0 ? ` / ${fmtMicros(k.monthlySpendLimitMicros)}` : "（不限）"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mb-4 flex items-center gap-2 rounded-sm bg-bg px-2.5 py-2">
                      <span className="min-w-0 flex-1 text-[0.6875rem] leading-5 text-ink-2">
                        {relayKeys?.error ?? "登录 relay 后可一键签发并绑定 key，无需手动复制粘贴。"}
                      </span>
                      <Link href="/login">
                        <Button variant="secondary" size="sm">去登录</Button>
                      </Link>
                    </div>
                  )}

                  <div className="mb-2 text-[0.625rem] font-medium uppercase tracking-wide text-ink-3">或手动粘贴 key</div>
                  {status?.configured ? (
                    <div className="mb-3 flex items-center gap-2 rounded-sm border border-line bg-bg px-2.5 py-2">
                      <span className="font-mono text-xs text-ink">{status.masked}</span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={clearKey}
                        className="text-[0.6875rem] text-ink-3 transition-colors hover:text-danger disabled:opacity-50"
                      >
                        清除
                      </button>
                    </div>
                  ) : (
                    <div className="mb-3 flex items-center gap-2">
                      <input
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveKey();
                        }}
                        placeholder="zrk_…（relay 控制台 → API Keys 签发）"
                        spellCheck={false}
                        autoComplete="off"
                        className={inputClass}
                      />
                      <Button variant="primary" size="sm" disabled={busy || !keyDraft.trim()} onClick={saveKey}>
                        保存
                      </Button>
                    </div>
                  )}
                  {saved && <div className="mb-2 text-[0.6875rem] text-success">已保存，后续请求将使用个人 key。</div>}
                  {rotated && <div className="mb-2 text-[0.6875rem] text-success">加密密钥已轮换，已存 key 自动重加密迁移。</div>}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={rotate}
                      className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink disabled:opacity-50"
                    >
                      轮换加密密钥
                    </button>
                    <span className="text-[0.625rem] text-ink-3">怀疑 data/.secret 泄露时使用；已存 key 自动重加密。</span>
                  </div>
                </Card>
                <Card title="本地 Ollama" desc="配置后模型选择器出现「本地 · Ollama」分组，本地模型不经 relay、零成本离线可用。">
                  <div className="flex items-center gap-2">
                    <input
                      value={ollamaDraft}
                      onChange={(e) => setOllamaDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveOllama();
                      }}
                      placeholder="http://127.0.0.1:11434/v1（留空则用 OLLAMA_URL）"
                      spellCheck={false}
                      autoComplete="off"
                      className={inputClass}
                    />
                    <Button variant="primary" size="sm" disabled={busy} onClick={saveOllama}>
                      保存
                    </Button>
                  </div>
                </Card>
                <FailoverCard />
              </>
            )}

            {section === "mcp" && (
              <Card
                title="MCP servers"
                desc="在项目 <workspace>/.zmzai/mcp.json 或全局 data/mcp.json 配置；配置文件与插件目录变更会自动热加载。"
              >
                {mcp && mcp.statuses.length > 0 ? (
                  <div className="mb-3 space-y-1">
                    {mcp.statuses.map((s) => (
                      <div key={s.name} className="flex items-center gap-2 rounded-sm border border-line bg-bg px-2.5 py-1.5">
                        <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (s.state === "connected" ? "bg-success" : "bg-danger")} />
                        <span className="truncate font-mono text-xs text-ink">{s.name}</span>
                        <span className="shrink-0 text-[0.625rem] text-ink-3">{s.transport}</span>
                        <span className="ml-auto shrink-0 text-[0.625rem] text-ink-3">
                          {s.state === "connected" ? `${s.tools.length} 工具` : (s.error ?? "连接失败")}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mb-3 rounded-sm bg-bg px-2.5 py-2 text-[0.6875rem] leading-5 text-ink-3">
                    未配置 MCP server。示例：
                    <code className="mt-1 block font-mono text-[0.625rem] text-ink-2">&#123;"mcpServers":&#123;"&lt;name&gt;":&#123;"type":"stdio","command":"…","args":[…]&#125;&#125;&#125;</code>
                  </div>
                )}
                {mcp && mcp.configErrors.length > 0 && (
                  <div className="mb-2 text-[0.6875rem] leading-5 text-danger">
                    {mcp.configErrors.slice(0, 3).map((e) => (
                      <div key={e} className="truncate">{e}</div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  disabled={mcpBusy}
                  onClick={rescanMcp}
                  className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink disabled:opacity-50"
                >
                  {mcpBusy ? "重新连接中…" : "重新扫描 mcp.json"}
                </button>
              </Card>
            )}

            {section === "plugins" && (
              <Card
                title="插件"
                desc="插件目录（Agent Plugins 1.0）：plugin.json 声明名称/版本，可选 mcp.json 与 skills/。安装到项目 .zmzai/plugins/，其 MCP server 即刻生效，配置变更热加载。"
              >
                {plugins.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {plugins.map((p) => (
                      <div key={`${p.scope}/${p.name}`} className="flex items-center gap-2 rounded-sm border border-line bg-bg px-2.5 py-1.5">
                        <span className="truncate font-mono text-xs text-ink">{p.name}</span>
                        {p.version && <span className="shrink-0 text-[0.625rem] text-ink-3">v{p.version}</span>}
                        <span className="shrink-0 text-[0.625rem] text-ink-3">{p.scope === "global" ? "全局" : "项目"}{p.hasMcp ? " · MCP" : ""}</span>
                        <span className="flex-1" />
                        {p.scope === "project" && (
                          <button
                            type="button"
                            disabled={pluginBusy}
                            onClick={() => uninstallPlugin(p.name)}
                            className="shrink-0 text-[0.6875rem] text-ink-3 transition-colors hover:text-danger disabled:opacity-50"
                          >
                            卸载
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mb-2 flex items-center gap-2">
                  <input
                    value={pluginDraft}
                    onChange={(e) => setPluginDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") installPlugin();
                    }}
                    placeholder="/path/to/plugin（含 plugin.json 的目录）"
                    spellCheck={false}
                    autoComplete="off"
                    className={inputClass}
                  />
                  <Button variant="primary" size="sm" disabled={pluginBusy || !pluginDraft.trim()} onClick={installPlugin}>
                    安装
                  </Button>
                </div>
              </Card>
            )}

            {section === "skills" && (
              <Card
                title="技能"
                desc="Lectern 会默认只读发现工作区和电脑里已有的 Skills。它们会出现在任务输入框的 Skill 选择器中；只有你选中某一个后，正文才会随这条消息注入，避免把整台电脑的技能一次塞进上下文。"
              >
                <div className="mb-3 flex items-center justify-between gap-3 rounded-sm bg-bg px-3 py-2">
                  <span className="text-[0.6875rem] leading-5 text-ink-3">默认关联：.zmzai/skills、~/.codex/skills、~/.agents/skills</span>
                  <button
                    type="button"
                    disabled={skillsBusy}
                    onClick={refreshSkills}
                    className="shrink-0 text-[0.6875rem] text-ink-3 transition-colors hover:text-ink disabled:opacity-50"
                  >
                    {skillsBusy ? "扫描中…" : "重新扫描"}
                  </button>
                </div>
                {skills.length > 0 ? (
                  <div className="overflow-hidden rounded-sm border border-line">
                    {skills.map((skill, index) => {
                      const source = SKILL_SOURCE[skill.source];
                      return (
                        <div key={skill.id} className={"flex items-center gap-3 bg-surface px-3 py-2.5 " + (index > 0 ? "border-t border-line" : "")}>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-ink">{skill.name}</div>
                            {skill.description && <div className="mt-0.5 truncate text-[0.6875rem] text-ink-3">{skill.description}</div>}
                          </div>
                          <span className="shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[0.625rem] text-ink-2" title={source.detail}>
                            {source.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-sm bg-bg px-3 py-5 text-center text-xs leading-5 text-ink-3">
                    尚未发现 Skill。可在任一关联目录内放置 &lt;名称&gt;/SKILL.md 后重新扫描。
                  </div>
                )}
              </Card>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
