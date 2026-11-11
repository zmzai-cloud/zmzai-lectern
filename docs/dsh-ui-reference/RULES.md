# DSH 会话流可移植规则集（从 deepseek-harness 源码提炼，2026-11-11）

来源：packages/client/ui-chat（conversation-nodes README、chat-nodes.ts、
ChatGroupSeat、ReasoningRow）+ ui-tool（ToolRow、GenericToolCard、ToolCallTree）。
原件镜像在本目录。MIT/Apache 许可证待发版前核对（dsh 仓库 LICENSE）。

## 数据模型（chat-nodes.ts）
一次会话 = Turn 序列；每 Turn 含：blocks(assistant 内容块)、tool 节点、
turn-tail。渲染单元是 Node，Node 声明自己在 group-tree 的位置：
exchange > input > turn > process。位置决定分组，不按类型。

## 分组规则（conversation-nodes README #process-grouping）
- 一个组 = 同一 Turn 内**相邻**的过程内容（reasoning/tool/上下文注入）。
- **Assistant 回复（非空 text/图片）终结前一个组**，回复本身是独立 response 节点
  ——这就是"过程与答案分离"的关键：模型中途碎碎念不会切碎组，因为碎碎念
  之后没有新工具时不构成边界（见下）；真正有 reply 时才分段。
- 换工具类型不分组；step 序号变化不分组；steering/新输入分组。
- 组的 closed = 内容段结束（有 reply 或 Turn 边界），不是 UI 折叠态。

## 组标题（活动摘要）
- 关闭态标题 = 分类计数排名前三的中文名连接（"已读文件、已运行命令等"），
  不显示数字。
- 运行态标题 = 当前运行中工具的分类名（"正在读取 src/app.ts"），
  150ms 最小停留防闪烁（useStableLiveProcessTitle）。
- 分类表（按工具名精确匹配）：read/grep glob search/bash commands/
  edit write/web_search/web_fetch/subagent_*/todo_write plan/其他 tools。

## 行组件（ToolRow/ReasoningRow）
- ToolRow 折叠态：[16px 图标] gap6 [标题13/24] gap8 [2px 点] gap8 [摘要截断]，
  摘要比正文小一档（secondary tier）；点行展开输入/输出。
- ReasoningRow 独立于工具行：思考行单独折叠，首行预览（去掉 ** 标记），
  流式时 TextShimmer。
- 图标 hover 换 chevron；展开态图标位变上箭头。

## 布局（ChatGroupSeat.module.css）
- 组内行距 4px；组体上限 min(400px, 50vh) + 24px 上下渐隐 mask，
  超高内部滚动（overscroll 穿透到外层）。
- 展开态标题下 8px；回复与过程之间 12px。
- 组头行高与过程行同高（24px + 字号 delta）。

## 整 Turn 折叠（whole-Turn folding）
完成后的 Turn 整体折叠（过程全藏，回复保留），Turn 控制行显示
"Completed in 2m13s"。运行中 Turn 不折叠。中断/失败 Turn 保持展开。
