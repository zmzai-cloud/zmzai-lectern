import { NextResponse, type NextRequest } from "next/server";

import { createMemoryClient, type MemoryBankRow } from "@/lib/memory/client";
import { deterministicBankId, getMemoryBinding, rebindMemory, setMemoryEnabled, setMemorySyncPolicy } from "@/lib/memory/binding";
import { getActiveProject, listProjects } from "@/lib/projects";
import { withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function resolveProject(projectId: string | null) {
  if (projectId) {
    const found = listProjects().find((p) => p.id === projectId);
    if (!found) throw Object.assign(new Error("项目不存在"), { status: 404 });
    return found;
  }
  return getActiveProject();
}

export type BankSource = "lectern" | "agent" | "other";

function bankSource(bankId: string): BankSource {
  if (bankId.startsWith("lec_")) return "lectern";
  if (bankId.startsWith("ws_")) return "agent";
  return "other";
}

/**
 * GET /api/memory/binding?projectId= — 当前绑定 + 有权 bank 列表（带来源标记）。
 * bank 列表来自 memory.zmzai.cloud（PAT）；不可达时 binding 仍返回（banks 空 + degraded）。
 */
export const GET = withWorkflowErrors(async (request: NextRequest): Promise<Response> => {
    const project = resolveProject(request.nextUrl.searchParams.get("projectId"));
    const binding = getMemoryBinding(project.id);
    const client = createMemoryClient();
    const result = await client.listBanks();
    const banks: Array<MemoryBankRow & { source: BankSource }> = result.ok
      ? result.data.banks.map((b) => ({ ...b, source: bankSource(b.bankId) }))
      : [];
    return NextResponse.json({
      projectId: project.id,
      projectName: project.name,
      autoBankId: deterministicBankId(project.id),
      binding,
      banks,
      ...(result.ok ? {} : { banksError: result.kind }),
    });
  });

/**
 * POST /api/memory/binding
 * - {action:"rebind", bankId, bankName} → 换绑指定 bank（旧 outbox 标 orphaned）
 * - {action:"rebind-auto"} → 恢复自动绑定（确定性 lec_ bank，服务端幂等建库后绑）
 * - {syncPolicy:"off"|"manual"|"auto"} / {enabled:boolean} → 策略与开关
 */
export const POST = withWorkflowErrors(async (request: NextRequest): Promise<Response> => {
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: string;
      action?: string;
      bankId?: string;
      bankName?: string;
      syncPolicy?: string;
      enabled?: boolean;
    };
    const project = resolveProject(body.projectId ?? null);

    if (body.action === "rebind") {
      const bankId = (body.bankId ?? "").trim();
      const bankName = (body.bankName ?? "").trim() || bankId;
      if (!bankId) return NextResponse.json({ error: "VALIDATION", message: "bankId 必填" }, { status: 400 });
      const binding = rebindMemory(project.id, { bankId, bankName, source: "manual" });
      return NextResponse.json({ ok: true, binding });
    }

    if (body.action === "rebind-auto") {
      const client = createMemoryClient();
      const bankId = deterministicBankId(project.id);
      const created = await client.createBank(bankId, project.name);
      if (!created.ok) {
        return NextResponse.json({ error: "BANK_CREATE_FAILED", message: `自动建库失败（${created.kind}）` }, { status: 502 });
      }
      const binding = rebindMemory(project.id, { bankId, bankName: project.name, source: "auto" });
      return NextResponse.json({ ok: true, binding });
    }

    if (body.syncPolicy === "off" || body.syncPolicy === "manual" || body.syncPolicy === "auto") {
      setMemorySyncPolicy(project.id, body.syncPolicy);
      return NextResponse.json({ ok: true, binding: getMemoryBinding(project.id) });
    }
    if (typeof body.enabled === "boolean") {
      setMemoryEnabled(project.id, body.enabled);
      return NextResponse.json({ ok: true, binding: getMemoryBinding(project.id) });
    }
    return NextResponse.json({ error: "VALIDATION", message: "需要 action/syncPolicy/enabled 之一" }, { status: 400 });
  });
