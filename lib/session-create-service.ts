import { createHash, randomUUID } from 'node:crypto';
import { resolveModel, sessionCookieName } from './relay.js';
import { runtimeFor } from './runtime.js';
import { withWorkflowErrors, WorkflowError } from './workflow-error.js';
import { getActiveProject, registeredProjects } from './projects.js';
import { worktreeForSession } from './worktree.js';
import { createWorkspace } from './workspace-service.js';
import { dataDir } from './runtime-constants.js';

async function handlePOST(request: Request) {
  // Capture at request entry, including across asynchronous body parsing.
  const pinnedProjectId = new URL(request.url).searchParams.get('projectId');
  const project = pinnedProjectId ? registeredProjects().find(p => p.id === pinnedProjectId) : getActiveProject();
  if (!project) throw new WorkflowError('NOT_FOUND', '项目不存在', 404);
  const body = (await request.json().catch(() => null)) as
    { agent?: string; model?: { providerId: string; modelId: string }; isolate?: boolean; requestId?: string } | null;
  if (body?.requestId !== undefined && (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId))) {
    throw new WorkflowError("INVALID_INPUT","非法 requestId",422);
  }
  const requestId = body?.requestId ?? randomUUID();
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
  const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;

  // Capture the project before awaiting model resolution or session persistence.
  const runtime = runtimeFor(project.path);
  const sessionId = `ses_${createHash("sha256").update(`${project.id}:${requestId}`).digest("hex").slice(0,24)}`;
  const existing = await runtime.store.getSession(sessionId);
  const model = body?.model ?? existing?.model ?? (await resolveModel(body?.agent, cookieHeader));
  const effectiveModel = model ?? { providerId: "openai", modelId: process.env.OPENAI_MODEL ?? "deepseek-chat" };
  const creationPayloadHash = createHash("sha256").update(JSON.stringify({ agent: body?.agent ?? "default",model: effectiveModel,isolate: !!body?.isolate })).digest("hex");
  if (existing && existing.creationPayloadHash !== creationPayloadHash) {
    throw new WorkflowError("CONFLICT","requestId 已用于不同的会话参数",409);
  }
  const created = existing ?? await runtime.createSession({
    id: sessionId,
    userId: "local",
    workspaceId: "local",
    agent: body?.agent,
    // 兜底默认值与主链路一致（relay.ts resolveAgents 的 fallback），避免
    // 未设 OPENAI_MODEL 时会话模型落成 gpt-4o 而与 relay 实际模型对不上。
    model: effectiveModel,
    creationRequestId: requestId,
    creationPayloadHash,
  });
  const session = await runtime.store.getSession(sessionId) ?? created;

  // 会话级 worktree 隔离（W1：WorkspaceService 创建序列接管——先登记再 Git、
  // 核对读一致才 ready、失败保持 failed 不自动落回主工作区，spec §10.2）。
  const recorded = worktreeForSession(session.id);
  let isolation: { enabled: boolean; reason?: string; path?: string; branch?: string } = recorded
    ? { enabled: true,path: recorded.path,branch: recorded.branch }
    : { enabled: false };
  if (body?.isolate && !recorded) {
    const result = await createWorkspace({
      dataDir, projectId: project.id, projectPath: project.path, sessionId: session.id,
    });
    if (result.ok) {
      isolation = { enabled: true, path: result.record.path, branch: result.record.branch };
    } else {
      isolation = { enabled: false, reason: result.reason };
    }
  }
  return Response.json({ ...session, isolation, projectId: project.id, projectName: project.name });
}

export const handleSessionCreate = withWorkflowErrors(handlePOST);
