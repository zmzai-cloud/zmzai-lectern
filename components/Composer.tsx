"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Textarea, cn } from "@zmzai/theme";

import { ComposerAttachmentList } from "@/components/AttachmentCards";
import { client } from "@/lib/client";
import { acceptAttribute } from "@/lib/attachments/limits";
import { useComposerAttachments } from "@/lib/attachments/queue";
import type { PermissionMode } from "@/lib/permission-mode";
import type { InputAttachmentRef, ModelRef, ModelsState, SkillOption, ThinkingEffort, TreeNode, UsageInfo } from "@/lib/types";

/**
 * 一次发送的完整输入（规格 2 §7.5）。
 *
 * 【为什么改成对象】原来 onSend 是 6 个位置参数，末两位是 references 和附件；
 * 附件换成描述符后参数只会更多，调用点把 skill 和 references 传反是迟早的事。
 * 对象参数也让「只有附件没有文字」这种组合读起来是显式的。
 */
export type ComposerSendInput = {
  text: string;
  /** **已就绪**的附件描述符（规格 2 §11）。只有 id 与元数据，内容不在请求里。 */
  attachmentRefs: InputAttachmentRef[];
  effort?: ThinkingEffort;
  skill?: { id: string; name: string };
  /** @ 引用的工作区路径。与本地附件是两种产品语义，不混用同一个字段。 */
  references?: string[];
};

/** token 数缩写：1234 → 1.2k */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

type ModelChoice = { id: string; name: string; channel: string; maxInputTokens?: number; routable: boolean; allowedReasoningEfforts?: string[] };

type FileHit = { path: string; type: "dir" | "file" };

/** 解析光标前的 @ 引用："@quer" → "quer"；不在 @ 引用中返回 null。 */
function parseAtQuery(value: string, caret: number): string | null {
  const m = value.slice(0, caret).match(/(^|\s)@([^\s@]*)$/);
  return m ? m[2] : null;
}

/** `/skill` and `/file` are resource commands, not prompt text. */
function parseSlashQuery(value: string, caret: number): string | null {
  const m = value.slice(0, caret).match(/(^|\s)\/([^\s/]*)$/);
  return m ? m[2].toLowerCase() : null;
}

const SLASH_COMMANDS = [
  { id: "skill", label: "Skill", description: "引用并强制使用一个 Skill", keywords: ["skill", "技能", "resource"] },
  { id: "file", label: "文件", description: "引用工作区中的文件或目录", keywords: ["file", "文件", "path"] },
  // Reserved commands intentionally stay disabled until their behavior is shipped.
  { id: "mcp", label: "MCP", description: "引用 MCP 资源", keywords: ["mcp"], enabled: false },
  { id: "model", label: "模型", description: "引用模型配置", keywords: ["model"], enabled: false },
] as const;

type Props = {
  sessionId: string | null;
  running: boolean;
  selectedModel: ModelRef | null;
  onSelectModel: (m: ModelRef | null) => void;
  onSend: (input: ComposerSendInput) => void | Promise<void>;
  onAbort: () => void;
  /** 会话级权限模式（Codex 基准 ④）：胶囊常驻展示，点击循环切换。 */
  permissionMode?: PermissionMode;
  onCyclePermissionMode?: () => void;
};

/** 权限胶囊三态表达（demo 基准）：完全访问 amber / 每次确认 蓝 / 只读与默认 灰。 */
const PERM_PILL: Record<PermissionMode, { label: string; cls: string }> = {
  default: { label: "默认", cls: "bg-surface-2 text-ink-3 border-line" },
  full: { label: "完全访问", cls: "bg-warning-tint text-warning border-warning/30" },
  ask: { label: "每次确认", cls: "bg-live-tint text-live border-live/30" },
  readonly: { label: "只读", cls: "bg-surface-2 text-ink-2 border-line" },
};

/**
 * 底部 Composer：输入区 + 能力条（模型选择 / Skill 注入 / 推理力度 / 上下文用量与压缩）。
 * 模型为 per-prompt 覆盖（framework runner.prompt 的 model 参数）；Skill 选中后把
 * SKILL.md 的 markdown 随本次 prompt 注入（与 framework PluginSkill 同源约定）；
 * 推理力度随本次 prompt 下发（relay reasoning_effort，framework thinkingLevel）。
 */
export default function Composer({ sessionId, running, selectedModel, onSelectModel, onSend, onAbort, permissionMode, onCyclePermissionMode }: Props) {
  const [text, setText] = useState("");
  const [models, setModels] = useState<ModelsState | null>(null);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skill, setSkill] = useState<SkillOption | null>(null);
  const [popup, setPopup] = useState<"config" | "model" | "skill" | "effort" | null>(null);
  // 推理力度（N3）：off = 不发字段（默认，对所有模型安全）
  const [effort, setEffort] = useState<ThinkingEffort>("off");
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [compacting, setCompacting] = useState(false);
  // 附件（规格 2 §8）：选择 / 粘贴 / 拖放三条路径共用同一个队列 hook。
  // 删除历史上「图片一套 data URL、普通附件一套 data URL」的两份平行状态——
  // 那是三种入口行为分叉的根源，也是 base64 进 prompt JSON 的来源。
  const attachments = useComposerAttachments(sessionId);
  // 回形针菜单与拖放高亮：纯呈现状态，不落任何持久化。
  const [attachMenu, setAttachMenu] = useState(false);
  const [dropping, setDropping] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // @ 文件引用：atQuery 非 null 表示浮层打开，值为 @ 后的过滤串
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [atItems, setAtItems] = useState<FileHit[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // 目录列表缓存：同一目录内只读一次，后续敲字符本地过滤（避免每次字符都全量 readdir）
  const atDirCacheRef = useRef<Map<string, TreeNode[]>>(new Map());
  // 取消上一次未完成的目录请求（防止快速输入时请求排队堆积）
  const atAbortRef = useRef<AbortController | null>(null);

  // 模型目录全局共享，进页面拉一次。
  useEffect(() => {
    void client.listModels().then(setModels).catch(() => undefined);
  }, []);

  // Skill 与 @ 文件都受会话 worktree 约束。切换隔离会话后必须重取，不能继续
  // 使用上一个工作区的目录缓存或技能清单。
  useEffect(() => {
    let disposed = false;
    atAbortRef.current?.abort();
    atAbortRef.current = null;
    atDirCacheRef.current.clear();
    setAtItems([]);
    void client.listSkills(sessionId).then((r) => {
      if (disposed) return;
      setSkills(r.skills);
      setSkill((current) => current && !r.skills.some((item) => item.id === current.id) ? null : current);
    }).catch(() => !disposed && setSkills([]));
    return () => { disposed = true; };
  }, [sessionId]);

  // @ 引用：按已输入路径懒加载目录，按最后一段过滤。
  // 优化：①目录级缓存（同目录不再重复请求）②150ms debounce（停止输入才请求）
  //      ③AbortController 取消过期请求。
  useEffect(() => {
    if (atQuery == null) {
      atAbortRef.current?.abort();
      atAbortRef.current = null;
      return;
    }
    const slash = atQuery.lastIndexOf("/");
    const dir = slash >= 0 ? atQuery.slice(0, slash) : "";
    const base = slash >= 0 ? atQuery.slice(slash + 1).toLowerCase() : atQuery.toLowerCase();
    const filterDir = (nodes: TreeNode[]) => {
      const hits = nodes
        .filter((n) => !base || n.name.toLowerCase().includes(base))
        .slice(0, 8)
        .map((n) => ({ path: dir ? `${dir}/${n.name}` : n.name, type: n.type }));
      setAtItems(hits);
      setAtIndex(0);
    };

    // 命中缓存：直接本地过滤，零网络请求
    const cached = atDirCacheRef.current.get(dir);
    if (cached) {
      filterDir(cached);
      return;
    }

    // debounce 150ms：停止输入后才真正发目录请求
    let disposed = false;
    const timer = setTimeout(() => {
      if (disposed) return;
      atAbortRef.current?.abort();
      const controller = new AbortController();
      atAbortRef.current = controller;
      void client
        .fsTree(dir, sessionId, controller.signal)
        .then((r) => {
          if (disposed) return;
          atDirCacheRef.current.set(dir, r.nodes);
          filterDir(r.nodes);
        })
        .catch(() => {
          if (disposed) return;
          setAtItems([]);
        });
    }, 150);

    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [atQuery, sessionId]);

  // 上下文用量轮询：空闲 6s、运行中 2.5s
  useEffect(() => {
    if (!sessionId) {
      setUsage(null);
      return;
    }
    let disposed = false;
    const tick = () => {
      if (disposed) return;
      void client.usage(sessionId).then((u) => !disposed && setUsage(u)).catch(() => undefined);
    };
    tick();
    const period = running ? 2500 : 6000;
    const timer = setInterval(tick, period);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sessionId, running]);

  // 弹层点击外部关闭
  useEffect(() => {
    if (!popup && !attachMenu) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPopup(null);
        setAttachMenu(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popup, attachMenu]);

  // 模型维度平铺：relay /v1/models 已按调用者身份过滤
  // （个人 key → allowedModels 子集；登录会话 → 全部），直接用它而非渠道分组视图
  const modelChoices = useMemo<ModelChoice[]>(() => {
    const seen = new Set<string>();
    const out: ModelChoice[] = [];
    for (const m of models?.models ?? []) {
      if (!m.model || seen.has(m.model)) continue;
      seen.add(m.model);
      const ch = m.availableChannels ?? 0;
      out.push({
        id: m.model,
        name: m.model,
        channel: ch > 0 ? `${ch} 渠道` : "无可用渠道",
        maxInputTokens: m.maxInputTokens,
        routable: ch > 0,
        allowedReasoningEfforts: m.allowedReasoningEfforts,
      });
    }
    return out;
  }, [models]);

  // 默认推荐模型（需求：侧栏去代理后，底部选择器默认选一个稳定模型）：
  // 优先 deepseek-v4-flash，否则第一个可路由模型；只在用户未手动选择时生效一次。
  const defaultModelApplied = useRef(false);
  useEffect(() => {
    if (defaultModelApplied.current || selectedModel) return;
    const routable = modelChoices.filter((m) => m.routable);
    if (routable.length === 0) return;
    const pick = routable.find((m) => m.id === "deepseek-v4-flash") ?? routable[0]!;
    defaultModelApplied.current = true;
    onSelectModel({ providerId: "openai", modelId: pick.id });
  }, [modelChoices, selectedModel, onSelectModel]);
  // 弹层内搜索过滤（模型可能很多）
  const [modelFilter, setModelFilter] = useState("");
  const shownModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    return q ? modelChoices.filter((m) => m.id.toLowerCase().includes(q)) : modelChoices;
  }, [modelChoices, modelFilter]);

  /** 选中 @ 浮层项：把光标前的 "@过滤串" 替换为完整路径。 */
  const pickAt = useCallback(
    (hit: FileHit) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? text.length;
      const start = caret - (atQuery?.length ?? 0) - 1;
      setText(text.slice(0, start) + `@${hit.path} ` + text.slice(caret));
      setAtQuery(null);
      requestAnimationFrame(() => {
        const pos = start + hit.path.length + 2;
        textareaRef.current?.setSelectionRange(pos, pos);
        textareaRef.current?.focus();
      });
    },
    [text, atQuery],
  );

  const onTextChange = useCallback((value: string, caret: number) => {
    setText(value);
    setAtQuery(parseAtQuery(value, caret));
    setSlashQuery(parseSlashQuery(value, caret));
    setSlashIndex(0);
  }, []);

  const slashItems = useMemo(() => {
    const query = slashQuery ?? "";
    return SLASH_COMMANDS.filter((item) => (!("enabled" in item && item.enabled === false)) && (!query || item.id.startsWith(query) || item.keywords.some((word) => word.includes(query))));
  }, [slashQuery]);

  const pickSlash = useCallback((id: typeof SLASH_COMMANDS[number]["id"]) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/(^|\s)\/[^\s/]*$/, "$1");
    const after = text.slice(caret);
    if (id === "skill") {
      setText(before + after);
      setPopup("skill");
    } else if (id === "file") {
      const next = `${before}@${after}`;
      setText(next);
      setAtQuery("");
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(before.length + 1, before.length + 1));
    }
    setSlashQuery(null);
  }, [text]);

  /** 已知不支持视觉输入的模型前缀（deepseek 官方 API 对 image content 直接 400，
   *  上游报错/挂起表现为会话「卡住」，发送前拦截）。 */
  const VISION_UNSAFE = /^(deepseek|o3-mini|gpt-4o-mini)/i;
  const currentModelId = selectedModel?.modelId ?? "deepseek-v4-flash";

  // 当前模型允许的推理档位（relay allowedReasoningEfforts 白名单）。
  // 未覆盖（目录没给 / 本地 Ollama）时 undefined = 不限制（沿用旧静态枚举行为，
  // 交给 relay 兜底校验）；有白名单则只放行白名单内的档位。
  const allowedEfforts = useMemo(() => {
    if (selectedModel?.providerId === "ollama") return undefined;
    const hit = modelChoices.find((m) => m.id === currentModelId);
    return hit?.allowedReasoningEfforts && hit.allowedReasoningEfforts.length > 0
      ? new Set(hit.allowedReasoningEfforts)
      : undefined;
  }, [modelChoices, currentModelId, selectedModel?.providerId]);

  // 模型切换后，若已选档位不在新模型白名单内（如选了 high 又切到只允许 low 的
  // 模型），自动回落 off，避免残留一个 relay 会 400 的档位。
  useEffect(() => {
    if (effort !== "off" && allowedEfforts !== undefined && !allowedEfforts.has(effort)) {
      setEffort("off");
    }
  }, [allowedEfforts, effort]);

  const submit = useCallback(async () => {
    const body = text.trim();
    const attachmentRefs = attachments.readyRefs;
    // 无会话也可发送（page.send 会自动建会话）；只有附件、没有文字也是合法消息
    if (!body && attachmentRefs.length === 0) return;
    // 附件未就绪就不发：不发半个包，也不静默丢掉未就绪的附件（规格 §7.5 / §18.8）
    if (attachments.blockedReason) {
      attachments.notify(attachments.blockedReason);
      return;
    }
    // 已知不支持视觉输入的模型：图片会让上游直接 400，表现为会话「卡住」，发送前拦。
    if (attachments.items.some((item) => item.kind === "image") && VISION_UNSAFE.test(currentModelId)) {
      attachments.notify(`${currentModelId} 不支持图片输入，请点击底部模型名切换（如 gpt-5.6-*）`);
      return;
    }
    // @ 引用的文件收集为上下文提示（agent 有 fs 工具，按路径自行读取）
    const references = [...new Set([...body.matchAll(/(^|\s)@([^\s@]+)/g)].map((m) => m[2]))];
    try {
      await onSend({
        text: body,
        attachmentRefs,
        ...(effort !== "off" ? { effort } : {}),
        ...(skill ? { skill: { id: skill.id, name: skill.name } } : {}),
        ...(references.length ? { references } : {}),
      });
    } catch (error) {
      // 发送失败时文字、附件与引用**完整保留**（规格 §7.5 / §18.9）：附件队列不动，
      // 服务端附件也还没绑定消息，重试复用同一批 id —— 不会重复上传。
      attachments.notify(error instanceof Error ? error.message : "发送失败，文字与附件已保留");
      return;
    }
    setText("");
    setSkill(null);
    setAtQuery(null);
    // 只有 API 接受消息后才清空附件（此时服务端已绑定，不能再删文件）
    attachments.clear();
  }, [text, skill, onSend, attachments, effort, currentModelId]);

  /** 在光标处插入文本：受控 textarea 里被 preventDefault 的粘贴必须手动补回。 */
  const insertAtCaret = useCallback(
    (snippet: string) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? caret;
      const next = text.slice(0, caret) + snippet + text.slice(end);
      const pos = caret + snippet.length;
      onTextChange(next, pos);
      requestAnimationFrame(() => el?.setSelectionRange(pos, pos));
    },
    [text, onTextChange],
  );

  /**
   * 粘贴（规格 2 §7.2）。
   *
   * 同时读 `clipboardData.items` 与 `files`：从 Finder / 资源管理器复制文件时，
   * 落到哪一处随平台而异，只认一处会漏（历史实现只筛 `image/*`，PDF 和 Word 直接丢）。
   * 有文件但不拦截 textarea 默认粘贴会连纯文本一起吞掉，所以这里拦截后自己补文本。
   */
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const fileItems = [...(e.clipboardData?.items ?? [])].filter((item) => item.kind === "file");
      const fromItems = fileItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
      const seen = new Set<string>();
      const files: File[] = [];
      for (const file of [...fromItems, ...(e.clipboardData?.files ?? [])]) {
        // items 与 files 常指向同一批文件；按「名+尺寸」去重，避免同一文件进两次
        const key = `${file.name}:${file.size}:${file.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(file);
      }
      if (files.length === 0) {
        // 剪贴板里确实有「文件」类条目却一个都读不出来：明确告知，不静默忽略
        if (fileItems.length > 0) attachments.notify("剪贴板里的文件无法读取，请改用拖放或文件选择");
        return; // 纯文本粘贴完全沿用 textarea 默认行为
      }
      e.preventDefault();
      attachments.ingestFiles(files, "paste");
      // 文件和文本同时存在时保留文本，避免丢掉用户的说明性文字；
      // 但 Finder 复制文件常把文件名塞进 text/plain，那种就别当说明粘进来。
      const pasted = (e.clipboardData?.getData("text/plain") ?? "").trim();
      const isJustFilename = files.some((file) => pasted === file.name || pasted.endsWith(`/${file.name}`));
      if (pasted && !isJustFilename) insertAtCaret(pasted);
    },
    [attachments, insertAtCaret],
  );

  // 拖放（规格 §7.3）：dragover 必须 preventDefault 才是「可放下」，
  // 同时阻止浏览器把窗口导航到本地文件（不给默认行为留口子）。
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 子元素之间移动也会触发 dragleave，只在真正离开 Composer 时收起高亮
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropping(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDropping(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) {
        if (e.dataTransfer?.types.includes("Files")) attachments.notify("拖入的内容里没有可读取的文件");
        return;
      }
      attachments.ingestFiles(files, "drop");
    },
    [attachments],
  );

  /**
   * 「引用项目文件」（规格 §7.1）：与输入 `@` 打开的是同一个工作区选择器，
   * 这里把 `@` 插到光标处并立刻弹出浮层——不另造一套引用 UI。
   */
  const openProjectPicker = useCallback(() => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    // 光标前若不是空白，@ 不会被 parseAtQuery 认成引用起点，补一个空格
    const pad = before.length === 0 || /\s$/.test(before) ? "" : " ";
    const pos = caret + pad.length + 1;
    setAttachMenu(false);
    setText(`${before}${pad}@${text.slice(caret)}`);
    setSlashQuery(null);
    setAtQuery("");
    requestAnimationFrame(() => {
      el?.setSelectionRange(pos, pos);
      el?.focus();
    });
  }, [text]);

  const compact = useCallback(async () => {
    if (!sessionId || compacting) return;
    setCompacting(true);
    try {
      await client.compact(sessionId);
      // 压缩完成后立刻刷新用量（摘要落库后下一次 step-finish 才反映，先给个即时反馈）
      await new Promise((r) => setTimeout(r, 800));
      setUsage(await client.usage(sessionId).catch(() => null));
    } finally {
      setCompacting(false);
    }
  }, [sessionId, compacting]);

  const modelLabel = selectedModel?.modelId ?? "默认模型";
  const pct = usage && usage.contextWindow > 0 ? Math.min(100, Math.round((usage.used / usage.contextWindow) * 100)) : 0;
  const pctColor = pct >= 85 ? "bg-danger" : pct >= 60 ? "bg-warning" : "bg-success";

  return (
    <div ref={rootRef} className="composer-root relative shrink-0 px-6 pb-4">
      {slashQuery != null && (
        <div className="absolute bottom-full left-1/2 mb-2 w-full max-w-3xl -translate-x-1/2 overflow-hidden rounded-md border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="px-2 py-1.5 text-[0.6875rem] font-semibold text-ink-3">命令 · 引用资源</div>
          {slashItems.map((item, index) => (
            <button key={item.id} type="button" onMouseEnter={() => setSlashIndex(index)} onClick={() => pickSlash(item.id)} className={cn("flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition-colors", index === slashIndex ? "bg-selected" : "hover:bg-surface-3")}>
              <span className="font-mono text-xs font-medium text-accent">/{item.id}</span>
              <span className="text-xs text-ink-3">{item.description}</span>
            </button>
          ))}
          {slashItems.length === 0 && <div className="px-2 py-3 text-xs text-ink-3">没有匹配的命令。</div>}
          <div className="border-t border-line px-2 pt-1.5 text-[0.625rem] text-ink-3">↑↓ 选择 · ⏎ 确认 · Esc 关闭</div>
        </div>
      )}
      {/* @ 文件引用浮层 */}
      {atQuery != null && (
        <div className="absolute bottom-full left-1/2 mb-2 max-h-64 w-full max-w-3xl -translate-x-1/2 overflow-y-auto rounded-md border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="px-2 py-1.5 text-[0.6875rem] font-semibold text-ink-3">引用文件 · @路径</div>
          {atItems.map((hit, i) => (
            <button
              key={hit.path}
              type="button"
              onClick={() => pickAt(hit)}
              onMouseEnter={() => setAtIndex(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
                i === atIndex ? "bg-selected" : "hover:bg-surface-3",
              )}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-ink-3">
                {hit.type === "dir" ? (
                  <path d="M1.5 4a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z" strokeLinejoin="round" />
                ) : (
                  <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2zM9 2v4h4" strokeLinejoin="round" />
                )}
              </svg>
              <span className="truncate font-mono text-xs text-ink">{hit.path}</span>
            </button>
          ))}
          {atItems.length === 0 && (
            <div className="px-2 py-3 text-xs leading-5 text-ink-3">没有匹配的文件或目录。</div>
          )}
          <div className="border-t border-line px-2 pt-1.5 text-[0.625rem] text-ink-3">↑↓ 选择 · ⏎ 确认 · Esc 关闭</div>
        </div>
      )}

      {popup === "config" && (
        <div className="run-config-popover absolute bottom-full left-1/2 mb-2 w-full max-w-3xl -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="px-2 py-2 text-xs font-semibold text-ink-2">运行配置</div>
          <button type="button" onClick={() => setPopup("model")} className="flex min-h-10 w-full items-center rounded-lg px-3 text-left text-xs transition-colors hover:bg-surface-2">
            <span>模型</span><span className="ml-auto max-w-[65%] truncate font-mono text-ink-3">{modelLabel}</span>
          </button>
          <button type="button" onClick={() => setPopup("effort")} className="flex min-h-10 w-full items-center rounded-lg px-3 text-left text-xs transition-colors hover:bg-surface-2">
            <span>推理力度</span><span className="ml-auto font-mono text-ink-3">{effort === "off" ? "默认" : effort}</span>
          </button>
          <button type="button" onClick={() => setPopup("skill")} className="flex min-h-10 w-full items-center rounded-lg px-3 text-left text-xs transition-colors hover:bg-surface-2">
            <span>Skill</span><span className="ml-auto max-w-[65%] truncate text-ink-3">{skill?.name ?? "未选择"}</span>
          </button>
          {permissionMode && onCyclePermissionMode && (
            <button type="button" onClick={onCyclePermissionMode} className="flex min-h-10 w-full items-center rounded-lg px-3 text-left text-xs transition-colors hover:bg-surface-2">
              <span>权限</span><span className="ml-auto text-ink-3">{PERM_PILL[permissionMode].label} · 点击切换</span>
            </button>
          )}
        </div>
      )}
      {/* 弹层：运行配置的二级选择（与输入卡片同宽） */}
      {popup === "model" && (
        <div className="absolute bottom-full left-1/2 mb-2 max-h-72 w-full max-w-3xl -translate-x-1/2 overflow-y-auto rounded-md border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[0.6875rem] font-semibold text-ink-3">模型 · 对本条消息生效</span>
            <span className="font-mono text-[0.625rem] text-ink-3">{modelChoices.length} 个可用</span>
          </div>
          {modelChoices.length > 6 && (
            <input
              autoFocus
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="搜索模型…"
              className="mx-1 mb-1 h-6 w-[calc(100%-0.5rem)] rounded-sm bg-surface-2 px-2 text-xs text-ink outline-none placeholder:text-ink-3"
            />
          )}
          <button
            type="button"
            onClick={() => {
              onSelectModel(null);
              setPopup(null);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
              !selectedModel ? "bg-selected" : "hover:bg-surface-3",
            )}
          >
            <span className="flex-1 truncate text-xs text-ink-2">跟随代理默认模型</span>
            {!selectedModel && <CheckIcon />}
          </button>
          {shownModels.map((m) => {
            const active = selectedModel?.modelId === m.id;
            return (
              <button
                key={m.id}
                type="button"
                disabled={!m.routable}
                title={m.routable ? undefined : "当前无健康渠道，提交会失败"}
                onClick={() => {
                  onSelectModel({ providerId: "openai", modelId: m.id });
                  setPopup(null);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
                  active ? "bg-selected" : "hover:bg-surface-3",
                  !m.routable && "opacity-50",
                )}
              >
                <span className="truncate text-xs font-medium text-ink">{m.name}</span>
                <span className={cn("ml-auto shrink-0 font-mono text-[0.625rem]", m.routable ? "text-ink-3" : "text-danger")}>
                  {m.channel}
                  {m.routable && m.maxInputTokens ? ` · ${fmtTokens(m.maxInputTokens)}` : ""}
                </span>
                {active && <CheckIcon />}
              </button>
            );
          })}
          {modelChoices.length === 0 && (
            <div className="px-2 py-3 text-xs leading-5 text-ink-3">
              {models && !models.authenticated ? (
                <Link
                  href="/settings"
                  onClick={() => setPopup(null)}
                  className="transition-colors hover:text-ink"
                >
                  未接入 relay，点击前往设置（登录或配置个人 key）
                </Link>
              ) : (
                "暂无可用模型"
              )}
            </div>
          )}
          {modelChoices.length > 0 && shownModels.length === 0 && (
            <div className="px-2 py-3 text-xs leading-5 text-ink-3">没有匹配的模型。</div>
          )}
          {/* 本地 Ollama（N2b）：在线时追加本地模型分组（runtime 分流到本地端点） */}
          {models?.failover && models.failover.length > 0 && (
            <div className="mx-1 mt-1 rounded-sm bg-surface px-2 py-1.5 text-[0.625rem] leading-4 text-ink-3">
              最近降级：{models.failover[0].from ?? "主端点"} → {models.failover[0].to}
            </div>
          )}
          {models?.ollama && models.ollama.models.length > 0 && (
            <>
              <div className="mt-1 border-t border-line px-2 pt-1.5 pb-0.5 text-[0.6875rem] font-semibold text-ink-3">
                本地 · Ollama（{models.ollama.baseUrl}）
              </div>
              {models.ollama.models.map((m) => {
                const active = selectedModel?.providerId === "ollama" && selectedModel?.modelId === m.id;
                return (
                  <button
                    key={`ollama:${m.id}`}
                    type="button"
                    onClick={() => {
                      onSelectModel({ providerId: "ollama", modelId: m.id });
                      setPopup(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
                      active ? "bg-selected" : "hover:bg-surface-3",
                    )}
                  >
                    <span className="truncate text-xs font-medium text-ink">{m.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-ink-3">local</span>
                    {active && <CheckIcon />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
      {popup === "effort" && (
        <div className="absolute bottom-full left-1/2 mb-2 max-h-72 w-full max-w-3xl -translate-x-1/2 overflow-y-auto rounded-md border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="px-2 py-1.5 text-[0.6875rem] font-semibold text-ink-3">推理力度 · 对本条消息生效</div>
          {([
            { value: "off" as const, label: "默认", hint: "不发送 reasoning_effort（最兼容）" },
            { value: "minimal" as const, label: "最小", hint: "minimal" },
            { value: "low" as const, label: "低", hint: "low" },
            { value: "medium" as const, label: "中", hint: "medium" },
            { value: "high" as const, label: "高", hint: "high" },
          ] as const).map((opt) => {
            // off 永远可用；有白名单时非白名单档位禁用（避免 relay 400）
            const unsupported = opt.value !== "off" && allowedEfforts !== undefined && !allowedEfforts.has(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                disabled={unsupported}
                title={unsupported ? "当前模型不支持此推理强度" : undefined}
                onClick={() => {
                  setEffort(opt.value);
                  setPopup(null);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
                  effort === opt.value ? "bg-selected" : "hover:bg-surface-3",
                  unsupported && "cursor-not-allowed opacity-40",
                )}
              >
                <span className="text-xs font-medium text-ink">{opt.label}</span>
                <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-ink-3">{unsupported ? "不支持" : opt.hint}</span>
                {effort === opt.value && <CheckIcon />}
              </button>
            );
          })}
        </div>
      )}
      {popup === "skill" && (
        <div className="absolute bottom-full left-1/2 mb-2 max-h-72 w-full max-w-3xl -translate-x-1/2 overflow-y-auto rounded-md border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="px-2 py-1.5 text-[0.6875rem] font-semibold text-ink-3">
            Skill · 注入本次 prompt（工作区与本机已关联技能）
          </div>
          {skills.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSkill(s);
                setPopup(null);
              }}
              className="block w-full rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface-3"
            >
              <span className="text-xs font-medium text-ink">{s.name}</span>
              <span className="ml-1.5 rounded-sm bg-surface-2 px-1 py-0.5 text-[0.5625rem] text-ink-3">
                {s.source === "workspace" ? "工作区" : s.source === "codex" ? "Codex" : "本机 Agent"}
              </span>
              {s.description && <span className="mt-0.5 block text-[0.6875rem] leading-4 text-ink-3">{s.description}</span>}
            </button>
          ))}
          {skills.length === 0 && (
            <div className="px-2 py-3 text-xs leading-5 text-ink-3">
              没有发现 Skill。可放在 .zmzai/skills/&lt;name&gt;/SKILL.md，或安装到 ~/.codex/skills、~/.agents/skills。
            </div>
          )}
        </div>
      )}

      {/* 对话编辑器：ChatGPT 式柔和承载面，控制项沉在底部，不抢正文注意力。 */}
      {/* 宽度与消息列共用同一个 --conversation-content-max，保证左右基线一致
          （规格 §5.2）。此前这里是固定 752px、消息列 800px，两条轴不重合，
          切到底部时正文与输入框会明显错位。 */}
      <div
        className={cn(
          "chat-composer mx-auto w-full max-w-[var(--conversation-content-max)] bg-surface transition-colors",
          dropping && "bg-surface-2",
        )}
        data-dropping={dropping || undefined}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* 拖放目标提示：只在拖动文件时出现，不占常态版式 */}
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl text-xs font-medium text-ink-2 ring-2 ring-inset ring-selected-strong">
            松开即可添加文件
          </div>
        )}
        {/* 待发附件：选择、粘贴、拖放三条路径产出的都是同一批卡片（规格 §7.4） */}
        <ComposerAttachmentList items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />
        {skill && (
          <div className="flex items-center gap-1 px-3 pt-2.5">
            <span className="inline-flex max-w-64 items-center gap-1 rounded-[3px] bg-accent/15 px-2 py-0.5 text-[0.6875rem] font-medium text-accent-strong">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M8 1.5l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 10.9l-3.7 2.1.8-4.2L2 5.9l4.2-.5L8 1.5z" strokeLinejoin="round" />
              </svg>
              <span className="truncate">{skill.name}</span>
            </span>
            <button
              type="button"
              onClick={() => setSkill(null)}
              title="移除 Skill"
              className="text-ink-3 transition-colors hover:text-ink"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        <Textarea
          ref={textareaRef}
          onPaste={onPaste}
          rows={2}
          className="max-h-44 min-h-[68px] w-full resize-none border-0 bg-transparent px-4 py-3.5 text-sm leading-6 text-ink shadow-none outline-none placeholder:text-ink-3 focus-visible:ring-0"
          value={text}
          onChange={(e) => onTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (slashQuery != null && slashItems.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashItems.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashItems[slashIndex]!.id); return; }
            }
            if (slashQuery != null && e.key === "Escape") { e.preventDefault(); setSlashQuery(null); return; }
            // @ 浮层打开时优先响应键盘导航
            if (atQuery != null && atItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAtIndex((i) => (i + 1) % atItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setAtIndex((i) => (i - 1 + atItems.length) % atItems.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickAt(atItems[atIndex]);
                return;
              }
            }
            if (atQuery != null && e.key === "Escape") {
              e.preventDefault();
              setAtQuery(null);
              return;
            }
            // Enter 发送（Shift+Enter 换行）；输入法组合中不触发；⌘/Ctrl+Enter 兼容
            if (e.key !== "Enter") return;
            if (e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            submit();
          }}
          aria-label="消息"
          placeholder="描述任务，或继续提问…"
        />
        {/* 附件被拒 / 发送被拦的提示（4s 自动消失，也可立刻关掉） */}
        {attachments.notice && (
          <div className="flex items-start gap-1 px-3.5 pb-1">
            <p role="status" className="min-w-0 flex-1 text-xs leading-5 text-warning">
              {attachments.notice}
            </p>
            <button
              type="button"
              onClick={attachments.dismissNotice}
              title="关闭提示"
              aria-label="关闭提示"
              className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-sm text-ink-3 transition-colors hover:text-ink"
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        {/* 文件选择（隐藏 input，回形针触发）。accept 由唯一格式表生成，与前端早期
            校验、服务端最终校验同源——不再手写一份扩展名列表（规格 §4 / §7.1）。 */}
        <input
          ref={fileRef}
          type="file"
          accept={acceptAttribute()}
          multiple
          className="hidden"
          onChange={(e) => {
            attachments.ingestFiles(e.target.files, "picker");
            e.target.value = "";
          }}
        />
        <div className="composer-controls flex min-h-10 flex-wrap items-center gap-0.5 px-2.5 pb-1.5">
          <button
            type="button"
            onClick={() => setPopup((p) => (p === "config" ? null : "config"))}
            title="模型、推理力度、Skill 与权限"
            aria-label="运行配置"
            className={cn(
              "run-config-trigger inline-flex min-h-8 max-w-[70%] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong",
              popup ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2" width="5" height="5" rx="1" />
              <rect x="9" y="9" width="5" height="5" rx="1" />
              <path d="M9 4.5h2.5a2 2 0 0 1 2 2V9M7 11.5H4.5a2 2 0 0 1-2-2V7" strokeLinecap="round" />
            </svg>
            <span className="truncate">运行配置</span>
            <span className="truncate font-mono text-ink-3">{modelLabel} · {effort === "off" ? "默认" : effort}{permissionMode ? ` · ${PERM_PILL[permissionMode].label}` : ""}</span>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* 回形针（规格 §7.1）：主按钮直接开本地文件选择器（省一次点击），
              相邻箭头展开两种入口——「引用项目文件」必须可被发现，藏在别处等于没有。 */}
          <div className="relative flex items-center">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="添加文件"
              aria-label="添加文件"
              className="wb-iconbtn text-ink-3"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M13.5 7.5l-5.8 5.8a3.1 3.1 0 0 1-4.4-4.4l6-6a2.1 2.1 0 0 1 3 3l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.3-5.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setAttachMenu((open) => !open)}
              title="更多添加方式"
              aria-label="更多添加方式"
              aria-haspopup="menu"
              aria-expanded={attachMenu}
              className={cn("wb-iconbtn -ml-0.5 w-4 text-ink-3", attachMenu && "bg-surface-2 text-ink")}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {attachMenu && (
              <div
                role="menu"
                aria-label="添加文件"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setAttachMenu(false);
                  }
                }}
                className="absolute bottom-full left-0 z-20 mb-1.5 w-44 rounded-md border border-line bg-surface p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenu(false);
                    fileRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink transition-colors hover:bg-surface-3"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                    <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
                    <path d="M1.5 7h13" />
                  </svg>
                  从电脑选择
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={openProjectPicker}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink transition-colors hover:bg-surface-3"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                    <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 2h5.5A1.5 1.5 0 0 1 14.5 6.5v5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7z" />
                  </svg>
                  引用项目文件
                </button>
              </div>
            )}
          </div>
          <span className="flex-1" />

          {/* 上下文用量 + 压缩 */}
          {usage && usage.steps > 0 && (
            <button
              type="button"
              onClick={() => void compact()}
              disabled={compacting}
              title={`上下文约 ${fmtTokens(usage.used)} / ${fmtTokens(usage.contextWindow)} tokens · 点击压缩会话`}
              className="group mr-1.5 inline-flex items-center gap-1.5"
            >
              <span className="h-1 w-14 overflow-hidden rounded-pill bg-surface-2">
                <span className={cn("block h-full rounded-pill transition-all", pctColor)} style={{ width: `${pct}%` }} />
              </span>
              <span className="font-mono text-[0.625rem] text-ink-3 group-hover:text-ink-2">{pct}%</span>
            </button>
          )}

          {/* 附件未就绪时把原因写在按钮旁边，而不是只塞进 tooltip（规格 §7.5） */}
          {!running && attachments.blockedReason && (
            <span className="mr-1.5 hidden text-[0.6875rem] text-ink-3 sm:inline">{attachments.blockedReason}</span>
          )}
          {running ? (
            <button
              type="button"
              onClick={onAbort}
              title="中止"
              aria-label="中止"
              className="chat-primary-action flex h-8 w-8 items-center justify-center rounded-md border border-danger/50 text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-danger" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              // 有失败附件时不允许发送（用户需重试或移除），上传中也不允许——
              // 否则会发出一个缺少附件的消息，而用户以为文件已经带上了。
              disabled={(!text.trim() && attachments.readyRefs.length === 0) || attachments.blockedReason !== null}
              title={attachments.blockedReason ?? "发送（⏎）"}
              aria-label="发送"
              className="chat-primary-action flex h-8 w-8 items-center justify-center rounded-md bg-ink text-bg transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong disabled:cursor-not-allowed disabled:opacity-25"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg className="shrink-0 text-accent-strong" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
