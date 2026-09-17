# Lectern Conversation-First UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lectern a quiet, conversation-first workspace whose optional panels never squeeze or obscure the primary chat experience.

**Architecture:** Keep the existing single-page shell and component boundaries. Add a small task-scoped layout preference module, make the workbench tab observable by the page shell, render sidebar/workbench as mutually exclusive overlays below 1180px, and consolidate visual hierarchy through semantic CSS classes rather than duplicating Tailwind strings.

**Tech Stack:** Next.js 15, React 19, TypeScript 5.9, Tailwind CSS 4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-lectern-conversation-first-visual-design.md`

## Global Constraints

- New, idle, and running tasks default to a closed workbench.
- Artifact generation, review readiness, and delivery never open the workbench automatically.
- Workbench open state, width, and selected tab persist per task; explicit user choice wins over automatic recommendations.
- At 1180px and wider, the workbench may sit beside chat while preserving a 480px readable chat width.
- From 768px through 1179px, sidebar and workbench are mutually exclusive overlays; below 768px they are single-view surfaces.
- Terminal ownership remains in the bottom Debug Area; no PTY behavior changes.
- Structural regions use no radius; compact controls use 6px; rows/popovers use 8px; composer and user bubbles use 12px.
- Important supporting copy is at least 12px and primary actions have at least a 32px hit area.
- No page-level horizontal scrolling at supported widths.

---

### Task 1: Task-scoped workbench preferences and responsive shell

**Files:**
- Create: `lib/task-layout.ts`
- Create: `lib/task-layout.test.ts`
- Modify: `app/page.tsx`
- Modify: `components/WorkbenchPanel.tsx`
- Modify: `e2e/workbench-resize-ui.mjs`

**Interfaces:**
- Produces: `type WorkbenchTab = "review" | "files" | "preview"`.
- Produces: `readTaskWorkbenchLayout(taskId: string): TaskWorkbenchLayout` and `writeTaskWorkbenchLayout(taskId: string, layout: TaskWorkbenchLayout): void`.
- Produces: `WorkbenchPanel.initialTab?: WorkbenchTab` and `WorkbenchPanel.onTabChange?: (tab: WorkbenchTab) => void`.
- Consumes: existing `activeId`, `viewportWidth`, `sidebarOpen`, `workbenchOpen`, `workbenchWidth`, and `openFileReq` state in `app/page.tsx`.

- [ ] **Step 1: Add failing unit coverage for task isolation and invalid stored data**

```ts
it("keeps workbench layout isolated per task", () => {
  writeTaskWorkbenchLayout("a", { open: true, width: 520, tab: "preview" });
  writeTaskWorkbenchLayout("b", { open: false, width: 384, tab: "review" });
  expect(readTaskWorkbenchLayout("a")).toEqual({ open: true, width: 520, tab: "preview" });
  expect(readTaskWorkbenchLayout("b")).toEqual({ open: false, width: 384, tab: "review" });
});

it("falls back and clamps malformed preferences", () => {
  localStorage.setItem("lectern:task-layout:bad", JSON.stringify({ open: "yes", width: 9999, tab: "terminal" }));
  expect(readTaskWorkbenchLayout("bad")).toEqual({ open: false, width: 720, tab: "review" });
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `pnpm vitest run lib/task-layout.test.ts`

Expected: FAIL because `lib/task-layout.ts` does not exist.

- [ ] **Step 3: Implement the preference module**

```ts
export type WorkbenchTab = "review" | "files" | "preview";
export type TaskWorkbenchLayout = { open: boolean; width: number; tab: WorkbenchTab };

const fallback: TaskWorkbenchLayout = { open: false, width: 384, tab: "review" };
const keyOf = (taskId: string) => `lectern:task-layout:${taskId || "__draft__"}`;

export function readTaskWorkbenchLayout(taskId: string): TaskWorkbenchLayout {
  const raw = localStorage.getItem(keyOf(taskId));
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<TaskWorkbenchLayout>;
    return {
      open: typeof value.open === "boolean" ? value.open : false,
      width: Math.min(720, Math.max(320, Number.isFinite(value.width) ? value.width! : 384)),
      tab: value.tab === "files" || value.tab === "preview" ? value.tab : "review",
    };
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Wire the page shell and workbench tab persistence**

On task selection, save the outgoing task state and load the incoming state. Replace the global `lectern:workbench-open` and `lectern:workbench-width` writes with `writeTaskWorkbenchLayout(activeId ?? "__draft__", ...)`. Expose workbench tab changes from `WorkbenchPanel`; opening a file explicitly opens the panel and selects `files`, while the presence of an artifact only highlights the existing workbench action.

Render rules in `app/page.tsx`:

```tsx
const desktopPanels = viewportWidth >= 1180;
const compactPanels = viewportWidth < 1180;

{desktopPanels && sidebarOpen && <SessionList ... />}
{compactPanels && sidebarOpen && <div className="panel-overlay panel-overlay-left"><SessionList ... /></div>}
{desktopPanels && workbenchOpen && <DesktopWorkbench ... />}
{compactPanels && workbenchOpen && <div className="panel-overlay panel-overlay-right"><WorkbenchPanel ... /></div>}
```

Opening either compact overlay closes the other. Selecting a task closes the sidebar overlay. Desktop sidebar preference remains stored through `readPref("sidebar")` and is not overwritten by compact viewport transitions.

- [ ] **Step 5: Expand Playwright coverage**

Extend `e2e/workbench-resize-ui.mjs` to assert:

```js
assert.equal(await page.evaluate(() => localStorage.getItem("lectern:task-layout:resize") !== null), true);
await page.setViewportSize({ width: 960, height: 800 });
await page.getByRole("button", { name: "展开右侧工作区" }).click();
assert.equal(await page.locator(".panel-overlay-right").count(), 1);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
```

Add a second mocked task and verify its closed default does not inherit the first task’s open state.

- [ ] **Step 6: Run focused validation and commit**

Run: `pnpm vitest run lib/task-layout.test.ts && pnpm typecheck`

Expected: PASS.

Commit:

```bash
git add lib/task-layout.ts lib/task-layout.test.ts app/page.tsx components/WorkbenchPanel.tsx e2e/workbench-resize-ui.mjs
git commit -m "feat: make Lectern panels conversation-first"
```

### Task 2: One task context bar and explicit artifact entry

**Files:**
- Modify: `components/TaskContextStrip.tsx`
- Modify: `components/TaskBarActions.tsx`
- Modify: `app/page.tsx`
- Modify: `components/ChatView.tsx`

**Interfaces:**
- Consumes: `TaskPresentation`, task title, project name, model label, summary, and workbench callbacks.
- Produces: `TaskContextStrip.onOpenWorkbench?: (tab: WorkbenchTab) => void` and a visible project/model context line.
- Produces: `ChatView.onOpenArtifact?: () => void` for the completion area.

- [ ] **Step 1: Add semantic hooks to the existing UI test**

Add assertions that there is one persistent task status, project context is visible, and generated artifacts expose a named button without automatically opening the panel:

```js
assert.equal(await page.locator('[data-task-primary-status="true"]').count(), 1);
assert.equal(await page.getByRole("button", { name: /打开成果/ }).count(), 1);
assert.equal(await page.locator(".workbench-shell").count(), 0);
```

- [ ] **Step 2: Verify the assertions fail against the current markup**

Run the existing mocked Playwright server and `node e2e/workbench-resize-ui.mjs`.

Expected: FAIL on the new semantic hooks.

- [ ] **Step 3: Simplify `TaskContextStrip` hierarchy**

Render title as the first item; render project and model as a 12px secondary context line; expose a single status element with `data-task-primary-status="true"`. Use a regular 6px control for failure state rather than a 3px badge. Keep summary visible only while running.

- [ ] **Step 4: Add explicit workbench entry points**

In `app/page.tsx`, pass `onOpenWorkbench(tab)` to the task bar and `onOpenArtifact()` to chat. The handler sets the selected tab, opens workbench, and closes the sidebar overlay in compact mode. Render “打开成果” for `review_ready`/`delivered`, while other low-frequency controls remain in `TaskBarActions`.

- [ ] **Step 5: Remove the standalone search row**

Move ChatView’s search button into a compact action aligned with the read-context row or the task context action slot. Preserve its `aria-label="搜索当前会话"`, dialog behavior, focus restoration, and existing message-search tests.

- [ ] **Step 6: Validate and commit**

Run: `pnpm typecheck`

Expected: PASS.

Commit:

```bash
git add components/TaskContextStrip.tsx components/TaskBarActions.tsx components/ChatView.tsx app/page.tsx
git commit -m "refactor: clarify Lectern task hierarchy"
```

### Task 3: Calm chat stream, compact read context, and unified composer controls

**Files:**
- Modify: `components/ChatView.tsx`
- Modify: `components/Composer.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Preserves: all existing `ChatView` and `Composer` functional callbacks.
- Produces: `.chat-reading-column`, `.chat-read-context`, `.run-config-trigger`, and `.chat-primary-action` semantic classes.

- [ ] **Step 1: Add browser assertions for the reading axis and hit targets**

```js
const aligned = await page.evaluate(() => {
  const messages = document.querySelector(".messages")?.getBoundingClientRect();
  const composer = document.querySelector(".chat-composer")?.getBoundingClientRect();
  return messages && composer && Math.abs(messages.left - composer.left) < 2 && Math.abs(messages.right - composer.right) < 2;
});
assert.equal(aligned, true);
assert.ok((await page.getByRole("button", { name: /发送|中止/ }).boundingBox()).height >= 32);
```

- [ ] **Step 2: Align chat content and collapse read files**

Use one shared `max-width: 800px` reading column for messages, read summary, status whisper, and Composer. Keep the existing `<details>` closed by default and style the expanded paths as 8px rows with 12px labels instead of 10px chips.

- [ ] **Step 3: Consolidate Composer runtime configuration**

Replace the separate model, skill, effort, and permission pills with one `运行配置` trigger showing a short summary such as `模型名 · medium · 自动授权`. The popover reuses existing selectors and state; attachments remain a separate button. Keep the send/stop button as the only filled control, use a 32px square hit area, and remove the hover translate animation.

- [ ] **Step 4: Apply the approved visual tokens**

Update semantic CSS:

```css
.chat-user-bubble,
.chat-composer { border-radius: 12px; }
.wb-iconbtn,
.chat-primary-action { min-width: 32px; min-height: 32px; border-radius: 6px; }
.run-config-popover,
.task-row { border-radius: 8px; }
.chat-meta { font-size: 12px; line-height: 1.5; }
```

Replace undefined 3px/10px/16px radii in the touched components with the approved 6px/8px/12px values. Leave status dots and compact progress bars fully rounded.

- [ ] **Step 5: Validate and commit**

Run: `pnpm typecheck && pnpm test`

Expected: PASS.

Commit:

```bash
git add components/ChatView.tsx components/Composer.tsx app/globals.css
git commit -m "style: unify Lectern conversation surfaces"
```

### Task 4: Sidebar, workbench, and Debug Area visual alignment

**Files:**
- Modify: `components/SessionList.tsx`
- Modify: `components/WorkbenchPanel.tsx`
- Modify: `components/DebugArea.tsx`
- Modify: `components/TerminalPane.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Preserves: session operations, file/review/preview behavior, terminal tab/PTY behavior, and panel resize callbacks.
- Produces: consistent region dividers, 8px task rows, 6px compact controls, and 12px metadata across secondary panels.

- [ ] **Step 1: Simplify sidebar selection and operations**

Use one low-contrast selected background plus a 2px inset leading marker. Keep title, status, and time aligned; show state-relevant actions directly and keep other actions in the existing overflow menu. Replace critical 10–11px labels with 12px text.

- [ ] **Step 2: Normalize workbench controls**

Keep the underline tab model and structural square region. Update file tabs, preview/source toggles, empty-state actions, and path metadata to 6px/8px radii and 12px minimum type. Add `.workbench-shell` to the outer region for behavior and tests.

- [ ] **Step 3: Align Debug Area without changing terminal behavior**

Only update divider, tab, button, label, and focus styling. Preserve `TerminalPane` session management, backend selection, xterm setup, PTY requests, and the bottom-panel ownership boundary.

- [ ] **Step 4: Validate and commit**

Run: `pnpm typecheck && pnpm test`

Expected: PASS.

Commit:

```bash
git add components/SessionList.tsx components/WorkbenchPanel.tsx components/DebugArea.tsx components/TerminalPane.tsx app/globals.css
git commit -m "style: align Lectern secondary panels"
```

### Task 5: Responsive visual regression and release validation

**Files:**
- Create: `e2e/conversation-first-ui.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-09-17-lectern-conversation-first-visual-design.md`

**Interfaces:**
- Produces: `pnpm test:conversation-ui`.
- Consumes: the mocked API pattern used by `e2e/workbench-resize-ui.mjs` and `e2e/message-search-ui.mjs`.

- [ ] **Step 1: Build the visual acceptance script**

Use one mocked task with long messages, read paths, edited paths, a completion summary, and an artifact. Capture and assert 1600×900, 1440×900, 1180×900, 1179×900, 960×800, 768×900, 767×900, and 390×844. For every viewport assert no page-level horizontal overflow; at desktop assert a 480px minimum chat width; at compact sizes assert overlay exclusivity.

- [ ] **Step 2: Add the package script**

```json
"test:conversation-ui": "node e2e/conversation-first-ui.mjs"
```

- [ ] **Step 3: Run the complete validation set**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
LECTERN_TEST_URL=http://127.0.0.1:3105 node e2e/workbench-resize-ui.mjs
LECTERN_TEST_URL=http://127.0.0.1:3105 pnpm test:conversation-ui
```

Expected: every command passes, browser console errors are empty, and screenshots show no clipping or overlapping controls.

- [ ] **Step 4: Mark the design spec implemented and commit**

Change the spec status to `已实现`, record the validation commands, then commit:

```bash
git add e2e/conversation-first-ui.mjs package.json docs/superpowers/specs/2026-09-17-lectern-conversation-first-visual-design.md
git commit -m "test: verify conversation-first Lectern UI"
```
