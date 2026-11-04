/** Framework-consumer baseline. This does not certify Host/Chromium/native paths. */
import { createServer, createSqliteSessionStore, createMemoryEventLog, createFsWorkspaceFiles, createOpenAiModelProvider } from '@zmzai/agent-framework';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getSettings } from '../../lib/settings.js';

const settings = getSettings();
const key = process.env.OPENAI_API_KEY ?? settings.personalKey;
const cookie = process.env.LECTERN_EVAL_COOKIE;
const baseUrl = process.env.OPENAI_BASE_URL ?? settings.relayUrl;
const modelId = process.env.LECTERN_EVAL_MODEL;
const output = resolve(process.env.LECTERN_EVAL_OUTPUT ?? 'test-results/p0-evals/coding-baseline.json');
const samples = 3;
const fixtures = [
  { id: 'R02', files: { 'rate.mjs': 'export const rate = 0.2;\n', 'tax.mjs': 'import {rate} from "./rate.mjs"; export const tax = amount => amount + rate;\n' },
    prompt: '修复 tax.mjs 的 tax：税额应为金额乘税率。保留模块结构，只修改 tax.mjs。读取相关文件，修复后完成交付。',
    check: 'import {tax} from "./tax.mjs"; import assert from "node:assert/strict"; assert.equal(tax(100),20); assert.equal(tax(0),0); assert.equal(tax(50),10);' },
  { id: 'R03', files: { 'sum.mjs': 'export const sum = values => values.reduce((a,b)=>a+b,1);\n' },
    prompt: 'sum.mjs 求和函数失败：sum([1,2,3]) 应为 6，空数组应为 0。修复实现，只修改 sum.mjs，然后完成交付。',
    check: 'import {sum} from "./sum.mjs"; import assert from "node:assert/strict"; assert.equal(sum([1,2,3]),6); assert.equal(sum([]),0); assert.equal(sum([-1,1]),0);' },
  { id: 'R08', files: { 'slug.mjs': 'export const slug = text => text.trim().toLowerCase();\n' },
    prompt: '修复 src/slug.mjs 的 slug：去掉首尾空白、转小写、把连续空白替换为单个连字符。路径可能与实际项目不符，请自行查找恢复，只改实际 slug.mjs，然后完成交付。',
    check: 'import {slug} from "./slug.mjs"; import assert from "node:assert/strict"; assert.equal(slug(" Hello   World "),"hello-world"); assert.equal(slug("A\\tB"),"a-b");' },
];
type Result = { case_id: string; run_index: number; outcome: string; [key: string]: unknown };
const runs: Result[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
for (const fixture of fixtures) for (let index = 1; index <= samples; index++) {
  if ((!key && !cookie) || !baseUrl || !modelId) {
    runs.push({ case_id: fixture.id, run_index: index, outcome: 'not_run', failure_category: 'missing_config', missing: [!key && !cookie && 'credential', !baseUrl && 'endpoint', !modelId && 'model'].filter(Boolean), notes: 'No model calls made.' });
    continue;
  }
  const root = mkdtempSync(join(tmpdir(), 'lectern-coding-eval-'));
  const ws = join(root, 'workspace'); mkdirSync(ws);
  for (const [name, content] of Object.entries(fixture.files)) writeFileSync(join(ws, name), content);
  const store = createSqliteSessionStore({ dataDir: join(root, 'data') });
  const eventLog = createMemoryEventLog();
  // No shell, network tools, subagents or user workspace access in this layer.
  const fw = createServer({ store, eventLog, modelProvider: createOpenAiModelProvider({ baseUrl, apiKey: key, ...(cookie ? { headers: { cookie } } : {}), defaultModel: modelId, modelCaps: () => ({ maxTokens: 2048 }) }),
    workspaceFor: () => createFsWorkspaceFiles({ root: ws }),
    taskPolicy: { maxAttempts: 6, maxDurationMs: 120_000 },
    tools: (await import('@zmzai/agent-framework')).builtinTools.filter(t => ['read', 'list', 'glob', 'grep', 'edit', 'write', 'todo', 'task_deliver', 'task_block'].includes(t.id)),
  });
  const started = Date.now();
  const session = await fw.createSession({ userId: 'eval', workspaceId: 'fixture', model: { providerId: 'openai', modelId } });
  await store.updateSession(session.id, { permission: [{ permission: '*', pattern: '*', action: 'allow' }] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void fw.runner.abort(session.id); }, 130_000);
  try {
    await fw.runner.prompt(session.id, { text: fixture.prompt });
    let task = await store.task!.getActiveTask(session.id) ?? await store.task!.getLatestTask(session.id);
    while (!timedOut && (!task || ['queued', 'running', 'recovering', 'verifying'].includes(task.status))) {
      await new Promise(r => setTimeout(r, 100));
      task = await store.task!.getActiveTask(session.id) ?? await store.task!.getLatestTask(session.id);
    }
    await fw.runner.abort(session.id);
    let verification = false;
    try { execFileSync(process.execPath, ['--input-type=module', '-e', fixture.check], { cwd: ws, timeout: 5000, stdio: 'pipe' }); verification = true; } catch { /* report failed assertion without leaking outputs */ }
    const protectedFilesUnchanged = Object.entries(fixture.files).filter(([name]) => !fixture.check.includes(`./${name}`)).every(([name, content]) => readFileSync(join(ws, name), 'utf8') === content);
    const transcript = await store.getMessages(session.id);
    const tools = transcript.flatMap(m => m.parts).filter(p => p.type === 'tool');
    runs.push({ case_id: fixture.id, run_index: index, outcome: task?.status === 'delivered' && verification && protectedFilesUnchanged ? 'pass' : 'fail',
      failure_category: timedOut ? 'timeout' : task?.blocker?.kind === 'no_progress' && /502|503|上游/.test(task.blocker.message) ? 'upstream_unavailable' : !verification ? 'assertion' : task?.status !== 'delivered' ? 'not_delivered' : !protectedFilesUnchanged ? 'scope' : null,
      duration_ms: Date.now() - started, manual_interventions: 0, tokens_input: null, tokens_output: null, cost: null,
      fixture_hash: hash(JSON.stringify(fixture)), verification, protectedFilesUnchanged,
      task_status: task?.status ?? null,
      tool_counts: Object.fromEntries(['task_block', 'task_deliver'].map(id => [id, tools.filter(p => p.type === 'tool' && p.tool === id).length])), evidence: [] });
  } catch {
    runs.push({ case_id: fixture.id, run_index: index, outcome: 'fail', failure_category: 'runtime_error', duration_ms: Date.now() - started });
  } finally { clearTimeout(timer); await fw.runner.abort(session.id); rmSync(root, { recursive: true, force: true }); }
  console.log(`${fixture.id} ${index}/${samples}: ${runs.at(-1)!.outcome}`);
}
const report = { schema: 'lectern.evals.results/1', generated_at: new Date().toISOString(), suite: 'real-model',
  system_under_test: { name: 'framework-installed-consumer', kind: 'lectern-after', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), model: modelId ? { id: modelId, endpoint: baseUrl ? new URL(baseUrl).origin : null, params: { maxTokens: 2048, maxAttempts: 6 } } : null },
  environment: { machine: process.platform, samples, notes: 'Isolated coding baseline only. Does not certify Host, worktree merge, browser, memory or competitor. Usage unavailable remains null.' }, runs };
mkdirSync(resolve(output, '..'), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Result: ${runs.filter(r => r.outcome === 'pass').length}/${runs.length} passed; ${runs.filter(r => r.outcome === 'not_run').length} not run.`);
process.exitCode = runs.some(r => r.outcome !== 'pass') ? 1 : 0;
