# 文件附件、粘贴与引用 · 验收报告

**规格：** `docs/superpowers/specs/2026-09-17-lectern-file-attachments-and-references-spec.md`
**分支：** `feat/file-attachments`（基于 `feat/conversation-first-ui`）
**日期：** 2026-09-17
**结论：** 通过 —— 第 18 节 14 条全部满足。其中第 13 条（跨平台入口）三侧链路均已实测：
Web/Chromium、macOS 系统剪贴板、Windows 系统剪贴板各有一份「真实 Electron + 真实系统剪贴板」
的用例（`e2e/clipboard-native-ui.mjs`；CI run 35320438902 三个 job 全绿，2026-09-18）；写入侧
用的是与原生入口同等格式的系统剪贴板内容，而非直接驱动文件管理器，限定见 §3.1。第 19 节
12 条禁止项逐条核查未违反。

本报告是交付物 §20.6 的后半部分；前半部分（支持格式与限制说明）在 `docs/attachments.md`。

---

## 1. 变更说明

四个阶段（规格 §16）的落地情况与关键设计取舍。

### 1.1 统一附件输入（阶段 A / B）

历史实现里 `Composer.tsx` 有两套并行逻辑：`pickImages` 管图片、`pickAttachments` 管文本，
于是选择、粘贴、拖放三条路径各自演化出不同规则（粘贴只认 `image/*`，PDF 与 Word 直接被丢；
拖放同时调两个函数导致同一文件被处理两次）。现在三条路径都只调 `ingestFiles`：

- `lib/attachments/limits.ts` 是格式与上限的**唯一来源**。`<input accept>`、前端早期提示、
  服务端最终校验和错误文案全部从 `ATTACHMENT_FORMATS` 推导。
- `lib/attachments/classify.ts` 是纯函数（无 node / DOM API），前端与路由共用同一套判定——
  服务端不采信客户端结论，但两边用同一份规则表，避免「前端放行、后端拒绝」的错位。
- 扩展名只用于早期提示；MIME 由服务端内容嗅探决定（`lib/attachments/sniff.ts`）。
  客户端声明一律不采信（§19）。
- 消息链路改传 attachment descriptor。落库的 file part 只有描述符：

  ```ts
  { type: "file", filename, mime, attachmentId, size, kind, status }   // 无 url
  ```

  旧契约（v1，data URL）保留原样落库，升级后老消息仍可打开。

### 1.2 存储与内容寻址

- 原始文件进 Lectern 管理的 blob store，**不进项目 git 工作区**；按 SHA-256 内容寻址去重。
- 数据库只存 id、文件名、MIME、大小、摘要、状态与存储引用。
- 解析结果旁挂 `extracted/<sha256 前两位>/<sha256>.json`，与 blob 同生命周期回收。
- 未绑定消息的草稿附件 24 小时 TTL；绑定后跟随会话保留策略。
- 用户主动移除未发送的附件会立即删除服务端文件，不等 TTL。

### 1.3 文档提取与定位

四个适配器（`lib/attachments/extract/`）各自按「用户在那个软件里真正看得见的位置」切节：

| 格式 | locator | 关键取舍 |
|---|---|---|
| PDF | 页码 | 有真实页码，每页一节 |
| XLSX | 工作表名 + 非空单元格**包围盒** | 不是整行整列，也不是 `A1:ZZ900` |
| PPTX | 幻灯片序号（**放映顺序**） | 取自 `presentation.xml` 的 `sldIdLst`；拿不到时标非精确 + 警告，不假装知道 |
| DOCX | 标题层级 + 行号区间 | **刻意没有页码**——分页是 Word 渲染期概念，文件里不存在 |
| 文本 / CSV | 真实行号 | CSV 用真引号规则切分 |

DOCX 那条是整个附件功能里最容易做错的地方：按字号行数倒推一个「第 4 页」在实现上很容易，
但它换个字体就变了，用户翻过去看不到同一段话——那比不给定位更坏。

压缩炸弹防护**只在中央目录上判定**（零解压）：条目数、单条解压体积、总量、压缩比四项任一
超限即拒。通过后才按名单解压需要的条目；交给 mammoth / exceljs 之前必须先过闸门，因为它们
内部的解压不经过我们。OOXML 里的图片、字体、嵌入对象从不进内存。

### 1.4 模型读取与工具

- framework 新增 `read_attachment` 与 `search_attachments`（此前 `createAttachmentTools`
  返回空数组，即两个工具都不存在）。
- `provider.extract` **从解析缓存读，不现场解析**：一次 PDF 解析要几秒到几十秒，卡住的工具
  调用会让模型以为工具坏了。
- 大文档只把清单注入上下文，正文按需取回；每次取回都带 locator。
- 归属校验在 provider 与工具两层都做：一个项目的附件库存的是该项目**所有会话**的附件，
  而 runner 是「一个项目一个实例、轮流服务多个会话」，只按 id 取就等于让 A 会话的消息读到
  B 会话的文件。

### 1.5 安全边界

- 公式只取缓存结果，绝不重算；超链接只取显示文本、不取 URL。
- 宏与外部引用只做只读计数提示，不执行。
- XML 只做标签级扫描：不解析 DTD、不展开自定义实体、不解析外部引用。
- 解析失败分三类（`password_protected` / `no_extractable_text` / `corrupted`），**一律不自动
  重试**——解析是纯函数，重试不改变结果，只会让用户多看到一个停在「解析中」的卡片。
- OLE2 容器的两种含义分开：声明 `docx/xlsx/pptx` 但内容是 OLE2 时，靠流名
  `EncryptedPackage` / `EncryptionInfo` 区分「加密」与「旧版二进制」；真正的 `.xls` 放行。

### 1.6 本轮修掉的三个缺陷

**(a) 带附件的消息重发被判成 409（真 bug，测试挖出来的）**
幂等指纹只读输入里的 `attachmentIds`，而 workflow 里存的是 runner 的输入、字段名叫
`attachmentRefs`。于是重发时读出来的附件串永远是空数组，一比对就不相等 → 用户双击发送或
网络超时重试，得到的是「requestId 已用于不同的消息内容」，而那条消息第一次就发出去了。
修法是把指纹里那一项归一成「一串 id」；换了附件仍然 409（这条必须保留）。

**(b) `read_attachment` 把「还没解析完」说成「不存在」**
framework 侧根本区分不了不存在 / 不属于本会话 / 解析中 / 是图片，原文案却断言了其中一种。
后果是模型在文件即将可读时放弃它，转而让用户重新上传。改成逐一列出可能原因。

**(c) rewind 只挡 `missing`、不挡 `notReady`**
`resolveAttachmentRefs` 只把就绪的放进 `refs`，所以未就绪的那些会被**静默丢掉**——用户看到
的是一条少了一个文件的重发消息，且没有任何提示。已补上 409，与 prompt 路由一致。

---

## 2. 与既有能力的兼容（§18.12）

- 旧 data URL file part 原样保留：rewind 会把它重新送进新一轮（有用例钉住），
  消息卡片对 data URL 只给下载、不假装能拿到摘要。
- 消息卡片三级降级：①元数据还在读 → 先用 part 上的名字与大小画；②读不到或 blob 已清理 →
  显示「不可用」并撤掉链接；③旧契约 → 只给下载。三种都不让整条消息渲染失败。
- 图片路径无回归：图片仍是视觉模型输入，卡片仍显示缩略图（E2E 有断言）。

---

## 3. 已知偏差与限制

### 3.1 跨平台：Web、macOS、Windows 三侧的剪贴板链路均已实测（§18.13 满足）

规格要求「macOS、Windows 和 Web 的规定入口完成验证」。落点是 `e2e/clipboard-native-ui.mjs`
（已接入 `.github/workflows/ui-e2e.yml`，两个桌面平台各一个 job）：

- **Web / Chromium：完整验证**（36 项 E2E 断言）。Electron 的渲染进程就是 Chromium，所以
  这一侧覆盖的是与桌面版**同一份**实现。
- **macOS 系统剪贴板 → 渲染进程 → 附件卡片：已实测。** 真实 Electron 渲染进程 + **真实系统
  剪贴板**：把文件写进系统剪贴板后按 ⌘V，`clipboardData.items` 给出 `kind: "file"`、
  `type: "image/png"`，`clipboardData.files` 给出名称与字节数都正确的 `File`；附件卡片随即
  出现、上传发出、文件名正确，且文件名**没有**被误当成说明文字留在输入框里（即 `isJustFilename`
  那条分支）。
  另有一道独立确认：**换一个进程**（`osascript -e 'clipboard info'`）读系统粘贴板，看到的是
  `«class furl», 96` —— 即 Electron 写入的 `text/uri-list` 在 macOS 上落成了**文件 URL
  flavor**，正是 Finder 复制文件所落的那一族。这一步同时排除了两种假通过：写进去的确实是
  系统级数据（而不只是 Electron 内部的概念），且它没有随写入进程退出而失效。
- **Windows 系统剪贴板 → 渲染进程 → 附件卡片：已实测**（2026-09-18 首个绿，CI run
  35320438902 的 `clipboard-native-windows` job）。Electron 44 的 clipboard 已重构成 W3C 风格
  （只剩 `clear/has/read/readText/write/writeText`），**没有写 `CF_HDROP` 的口子**，所以
  Windows 侧由 PowerShell `Set-Clipboard -Path` 写入——与资源管理器 Ctrl+C 同格式；写完先由
  **另一个进程**用 `GetFileDropList()` 回读确认格式与存续性（`writer: "powershell:CF_HDROP"`），
  再按 Ctrl+V，卡片出现、上传发出、文件名正确，且文件名没有被误当成说明文字。两条独立确认
  分别落在 report.json 的「系统剪贴板写入 CF_HDROP」与「另一个进程回读 FileDropList 得到该文件」
  上。视口 1440×900（桌面档），验收对象是项目自带的 Electron 44.0.0 / Chromium 152。

**两个平台共同的限定（重要，别在 release notes 里越过它）：** 写入侧用的是「与原生入口**同等
格式**」的系统剪贴板内容，而**不是真的去点了 Finder 的复制菜单或资源管理器的 Ctrl+C**。已确认
的是格式落在同一族 flavor 上——macOS 侧独立进程看到 `«class furl»`，Windows 侧独立进程用
`GetFileDropList()` 读到了那个文件。不直接驱动文件管理器是有原因的：macOS 上 Apple events
授权被拦（`tell application "Finder"` 会挂住），CI runner 上则没有可交互的桌面会话。这一跳没有
被观测，因此对外应写「三个平台的规定入口均已实测」，不要写「Finder 复制 / 资源管理器复制已实测」。

第 2 条之所以值得单独立一个脚本：浏览器 E2E 里的「粘贴」是页面内合成的 `ClipboardEvent`，
它天然跳过了「系统剪贴板 → File」这前半段。代码侧对 Explorer 一侧也仍有准备——`onPaste`
同时读 `clipboardData.items` 与 `clipboardData.files`，并对「有文件条目却一个都读不出」
给了明确提示而不是静默忽略。

### 3.2 有意不做的事

- `.xls`（BIFF8）只保存不提取，明确告知用户另存为 `.xlsx`。它与 `.xlsx` 是两种格式，
  需要另一套解析器。
- 扫描件不做 OCR。规格 §6 写的是「允许 OCR 降级」，我们选择**明确提示改走图片输入**，
  而不是给一份猜出来的文字——猜错的正文比没有正文更糟。
- 不自动解压 ZIP / RAR / 7z（压缩包本身不在支持格式里）。

### 3.3 覆盖面上的两个缺口

- `MessageAttachmentCard`（消息里的附件卡）**没有组件级测试**。它的三条降级路径靠代码审查
  与 framework 侧的 part 契约测试保障，没有 DOM 级断言。
  **这不是「顺手补一个测试」能解决的**：本仓 `pnpm test` 的 39 个文件全在 Node 环境下跑纯逻辑
  （`lib/**/*.test.ts`），既没有 jsdom 也没有 @testing-library，加组件测试等于先引入一套前端
  测试基础设施并改 vitest 配置——那是独立决策，不该夹在功能收尾里做。
  这也正是渲染层的验收一直压在 E2E 上的原因，以及「E2E 必须进 CI」比往常更重要的原因。
- 真实 Windows 原生构建下的安装包冒烟里没有附件用例。CI 的 `desktop-release-check.yml`
  跑的是通用冒烟；把附件 E2E 接进那条链路是后续工作（渲染层与原生剪贴板用例已进
  `ui-e2e.yml`，见 §3.1）。

### 3.4 与本次改动无关的既有问题

`zmzai-framework` 的 `tsc --noEmit` 在 5 处**既有测试文件**报错（`truncate-from.test.ts`、
`workflow.test.ts`、`builtins.test.ts`），与附件无关，本次未动。生产代码类型干净。

---

## 4. 验证记录

```
# lectern（本 worktree）
npx tsc --noEmit                     → 干净
npx vitest run                       → 38 files / 383 tests passed
pnpm build                           → 成功（各路由正常产出）
node e2e/attachments-ui.mjs          → 36 项断言全部通过

# framework
npx vitest run                       → 37 files / 379 tests passed
npx tsc --noEmit                     → 仅 3.4 所述既有测试文件报错
```

附件相关的测试分布（15 个文件，是本节结论的主要证据来源）：

| 关注点 | 文件 | 用例 |
|---|---|---|
| 分类与前置校验（纯函数，前后端共用） | `lib/attachments/classify.test.ts` | 21 |
| 内容嗅探（含 OLE2 两种含义） | `lib/attachments/sniff.test.ts` | 9 |
| 附件库（内容寻址、TTL、引用回收） | `lib/attachments/store.test.ts` | 15 |
| 上传 API（multipart、无 base64 回显） | `lib/attachments/upload-route.test.ts` | 20 |
| prompt 路由（归属、幂等、绑定） | `lib/attachments/prompt-route.test.ts` | 10 |
| rewind 路由（复用 id、重绑、兼容旧契约） | `lib/attachments/rewind-route.test.ts` | 5 |
| ZIP 中央目录与闸门 | `lib/attachments/extract/zip.test.ts` | 10 |
| 收口（分节、去重、截断、空文档） | `lib/attachments/extract/finalize.test.ts` | 10 |
| 文本 / CSV | `lib/attachments/extract/text.test.ts` | 12 |
| PDF（真实 PDF + 逐页容错） | `lib/attachments/extract/pdf.test.ts` | 8 |
| DOCX（真实 OOXML 包） | `lib/attachments/extract/docx.test.ts` | 10 |
| XLSX | `lib/attachments/extract/xlsx.test.ts` | 12 |
| PPTX（放映顺序、备注页配对） | `lib/attachments/extract/pptx.test.ts` | 15 |
| 解析队列与状态收敛 | `lib/attachments/extract-queue.test.ts` | 12 |
| 上传 → 解析 → 按定位读取（端到端） | `lib/attachments/extract-pipeline.test.ts` | 9 |
| 前端入口与卡片状态机（E2E） | `e2e/attachments-ui.mjs` | 36 项断言 |

**fixture 用真文件，不用 stub。** 四个适配器的价值全在「真能读出这份文件」上，用自定义中间
结构去测等于把适配器自己当成正确性来源。所以构造真 ZIP、真 OOXML 包、真 PDF，让
pdfjs / mammoth / exceljs 去读。PDF 样本用 Type0 + Identity-H + ToUnicode CMap 而不是
Helvetica 单字节字体——单字节字体的字符码只有 0–255，写中文会变成错位字节（第一版就踩了，
跑出来是「‹‹ ‚ Ø¡ »• ‹ 700 ‚」）。

---

## 5. 第 18 节逐条验收

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | 点击、粘贴、拖放三种方式加所有规定格式，三入口行为一致 | ✅ | E2E：三条入口产出的卡片指纹逐字段相等；`ingestFiles` 是唯一入口 |
| 2 | 回形针明确表达「添加文件」，并能发现「引用项目文件」 | ✅ | E2E：`title="添加文件"`；下拉菜单并列「从电脑选择」与「引用项目文件」 |
| 3 | PDF、DOCX、XLSX、PPTX、文本/代码、图片都能形成 ready 附件 | ✅ | 四个适配器的真实文件测试 + `extract-pipeline` 端到端 + E2E 卡片状态 |
| 4 | 只有附件没有文本的消息可以发送并正确生成会话标题 | ✅ | E2E：只有附件时发送按钮可用、`text` 为空；`prompt-route`：标题种子取文件名 |
| 5 | 新消息不在 prompt JSON、事件或数据库 part 中保存完整 base64 | ✅ | E2E：载荷无 base64、无本地路径；`pi-bridge.test`：v2 part 无 `url` 字段；`upload-route.test`：响应体不含原文 |
| 6 | 消息刷新、应用重启、排队和 rewind 后附件仍可访问 | ✅ | `rewind-route.test`：复用 id、重绑到新消息、旧契约可重发；`store.test`：引用计数与清理；part 只存 id（刷新后按 id 取） |
| 7 | Agent 能按页、slide、sheet/range 或行号读取长文档并保留 locator | ✅ | `extract-pipeline`：按页码取回同一页、正文不含其他页、行号即真实行号；四个适配器的 locator 测试 |
| 8 | 超限、格式不支持、上传失败、解析失败都显示具体原因，不静默丢文件 | ✅ | E2E：超限点名「2.0MB」、不支持点名 `.exe` 与文件名、失败给重试入口；`extract-queue.test`：三类失败各自的文案 |
| 9 | 发送失败时文字、附件和引用完整保留，重试不重复上传 | ✅ | E2E：失败后文字与卡片都在、重试后上传计数不变 |
| 10 | 本地绝对路径不进入消息、日志或模型上下文 | ✅ | E2E：载荷不含 `/Users/` 与盘符路径；`classify.test`：`sanitizeFilename` 同时切断 `/` 与 `\`；framework：描述符校验拒绝含路径分隔符的文件名 |
| 11 | 工作区引用限制在当前 session workspace 内，不与本地附件混淆 | ✅ | `classify.test`：`validateReferencePath` 拒绝绝对路径与 `..`；读取侧由 `resolveWithinWorkspace(_, workspaceRootForSession(id))` 兜底；两种卡片图标与标签不同 |
| 12 | 旧附件消息兼容，现有图片发送能力无回归 | ✅ | `pi-bridge.test`：v1 data URL 原样落库；`rewind-route.test`：旧契约可重发；E2E：图片缩略图与对象 URL |
| 13 | macOS、Windows 和 Web 的规定入口完成验证 | ✅ 满足 | 三侧链路均已实测（`e2e/clipboard-native-ui.mjs`，CI run 35320438902 三 job 全绿）：Web/Chromium 36 项；macOS 真实 Electron + 真实系统剪贴板 + ⌘V，独立进程确认 `furl` flavor；Windows 真实 Electron + 真实系统剪贴板 + Ctrl+V，PowerShell 写 `CF_HDROP`、独立进程 `GetFileDropList()` 回读。限定：写入侧为同格式内容而非直接驱动文件管理器，见 §3.1 |
| 14 | 类型检查、单元测试、生产构建和附件 E2E 全部通过 | ✅ | §4 的验证记录 |

---

## 6. 第 19 节禁止项核查

| 禁止项 | 结论 | 说明 |
|---|---|---|
| 只改 `<input accept>` 或回形针 tooltip | 未违反 | 上传协议、存储、解析、工具与消息链路全部重做 |
| 继续把 PDF/Office/大文本转 base64 塞进 prompt JSON | 未违反 | prompt 只提交 id；`pi-bridge.test` 断言 part 无 `url`/`data` |
| 只在前端读文件名而不让 Agent 获得正文 | 未违反 | 四个适配器 + `read_attachment` / `search_attachments` 已注册并接通 |
| 把整个大型文档无界注入上下文 | 未违反 | 大文档只进清单；`INLINE_TEXT_LIMIT` 256KB；正文按 locator 取回并受字符上限约束 |
| 让选择、粘贴、拖放维护三套规则 | 未违反 | 三者都走 `ingestFiles`；E2E 用卡片指纹钉住一致性 |
| 发送失败后清空附件 | 未违反 | `submit` 只在 API 接受后 `clear()`；E2E 断言失败后草稿完整 |
| 把外部本地附件复制进项目 git 工作区 | 未违反 | 附件进独立的 blob store；`.gitignore` 与工作区无关 |
| 信任客户端 MIME、大小、文件名或 id 所有权 | 未违反 | 服务端内容嗅探为准；大小与文件名复核；id 经 `getScoped` 按会话校验（prompt / rewind 两条路径都有用例） |
| 执行文档中的宏、脚本、HTML 或嵌入命令 | 未违反 | 公式只取缓存、超链接只取文本、宏只计数；XML 不做 DTD 与实体展开 |
| 把文档正文当作高优先级指令 | 未违反 | 正文包在 `user_attachment` 边界里并显式声明不得当作 system/developer 指令（有用例） |
| 泄露用户本地绝对路径 | 未违反 | 只存 basename；`sanitizeFilename` 切断两种分隔符；E2E 断言载荷无绝对路径 |
| 直接修改 `node_modules` 中的 framework | 未违反 | framework 源码改动 → 测试 → 重新打包 vendor tarball（`vendor/zmzai-agent-framework-0.6.0.tgz`）→ 更新 lockfile |

---

## 7. 第 20 节交付物

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| 1 | 统一附件输入、上传、状态卡、消息展示和错误恢复 | `components/Composer.tsx`、`components/AttachmentCards.tsx`、`lib/attachments/queue.ts` | ✅ |
| 2 | Framework 的附件 descriptor、读取/搜索工具和历史兼容 | `zmzai-framework/src/core/runtime/attachments.ts`、`src/core/tools/attachments.ts`、`src/core/runtime/pi-bridge.ts` | ✅ |
| 3 | PDF、Office、文本和图片 extraction adapters | `lib/attachments/extract/` | ✅ |
| 4 | AttachmentStore、数据库迁移、清理策略和安全限制 | `lib/attachments/store.ts`、`limits.ts`、`sniff.ts`、`extract/zip.ts` | ✅ |
| 5 | 单元、API、framework 和跨平台 E2E 测试 | 见 §4 表 | ✅ 跨平台 E2E 三侧齐备（Web/Chromium + macOS 剪贴板 + Windows 剪贴板），并全部接进 CI |
| 6 | 支持格式/限制说明及逐条验收报告 | `docs/attachments.md` + 本文 | ✅ |

---

## 8. 后续工作

1. ~~等 Windows 剪贴板 job 跑绿~~ —— 已完成（2026-09-18，CI run 35320438902 三个 job 全绿）。
   仍然空着的一跳是「真去点 Finder 的复制菜单 / 资源管理器的 Ctrl+C」，需要一个能驱动文件
   管理器的桌面会话才能补，见 §3.1 末段。另需注意 `clipboard-native-windows` 虽跑在真实的
   Windows 上（真实系统剪贴板 + 真实 Electron + `pnpm build` 产物），但它验的是**源码构建后的
   运行**，不是**打包安装后的产物**——后者的冒烟仍只在 `desktop-release-check.yml` 里。
2. **`MessageAttachmentCard` 的组件级测试**（§3.3），把三条降级路径变成断言。
3. ~~framework 发布到 npm，vendor tarball 与已发布版本对齐~~ —— 已完成：
   `@zmzai/agent-framework@0.8.0` 已发布，vendor tarball 与 registry 逐文件哈希一致。
4. ~~把附件 E2E 接进 CI，让它在 Windows 原生构建上也跑一次~~ —— 已完成：渲染层与原生剪贴板
   用例进 `.github/workflows/ui-e2e.yml`（`browser` / `clipboard-native` /
   `clipboard-native-windows` 三个 job）。
