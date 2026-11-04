import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read snapshots, not event deltas: a tool part may have hundreds of updates.
// No prompts, filenames, credentials, ids or model output leave this process.
export function auditDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!['messages', 'parts', 'tasks'].every(t => tables.has(t))) return { status: 'unsupported_schema' };
    const tasks = db.prepare('SELECT json FROM tasks').all().map(r => JSON.parse(r.json));
    const messages = db.prepare('SELECT id, session_id, created, json FROM messages ORDER BY created, message_seq').all();
    const parts = db.prepare('SELECT message_id, json FROM parts').all();
    const byMessage = new Map();
    for (const row of parts) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push(JSON.parse(row.json));
      byMessage.set(row.message_id, list);
    }
    const summary = { status: 'ok', tasks: tasks.length, assistantMessages: 0, blockCalls: 0, deliverCalls: 0,
      blockErrors: 0, deliverErrors: 0, deliveredTasks: 0, noProgressTasks: 0,
      deliveredWithoutTool: 0, possibleMissingBlockMessages: 0, unattributedMessages: 0 };
    const calls = new Set();
    for (const task of tasks) {
      const start = messages.find(m => m.id === task.rootUserMessageId);
      const taskMessages = messages.filter(m => m.session_id === task.sessionId && m.created >= (start?.created ?? task.createdAt)
        && !tasks.some(other => other.id !== task.id && other.sessionId === task.sessionId && other.createdAt > task.createdAt && other.createdAt <= m.created));
      let delivered = false;
      for (const message of taskMessages) {
        const info = JSON.parse(message.json);
        if (info.role !== 'assistant') continue;
        summary.assistantMessages++;
        const content = byMessage.get(message.id) ?? [];
        let blocked = false;
        for (const part of content) {
          if (part.type !== 'tool' || !['task_block', 'task_deliver'].includes(part.tool)) continue;
          const key = `${message.id}:${part.callId ?? part.id}`;
          if (calls.has(key)) continue;
          calls.add(key);
          const prefix = part.tool === 'task_block' ? 'block' : 'deliver';
          summary[`${prefix}Calls`]++;
          if (part.state?.status === 'error') summary[`${prefix}Errors`]++;
          if (part.state?.status === 'completed') {
            if (prefix === 'block') blocked = true;
            else delivered = true;
          }
        }
        // Candidate counts only. This heuristic must never drive runtime state.
        const text = content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
        if (!blocked && /(?:请提供|需要你提供|需要您提供|请先登录|需要重新登录|缺少凭据|please provide|please log in)/i.test(text)) summary.possibleMissingBlockMessages++;
      }
      if (task.status === 'delivered') {
        summary.deliveredTasks++;
        if (!delivered) summary.deliveredWithoutTool++;
      }
      if (task.blocker?.kind === 'no_progress') summary.noProgressTasks++;
    }
    const assignedSessions = new Set(tasks.map(t => t.sessionId));
    summary.unattributedMessages = messages.filter(m => !assignedSessions.has(m.session_id)).length;
    return summary;
  } finally { db.close(); }
}

export function auditDirectory(directory) {
  const root = resolve(directory);
  const databases = [];
  if (existsSync(join(root, 'zmzai.db'))) databases.push(join(root, 'zmzai.db'));
  const projects = join(root, 'projects');
  if (existsSync(projects)) for (const entry of readdirSync(projects, { withFileTypes: true })) {
    const file = join(projects, entry.name, 'zmzai.db');
    if (entry.isDirectory() && existsSync(file)) databases.push(file);
  }
  return { schema: 'lectern.task-contract-audit/1', generatedAt: new Date().toISOString(),
    notes: ['Snapshot counts, not tool success rates.', 'Missing-block candidates require human review; no text is exported.', 'Task attribution uses root message and task creation boundaries.'],
    databases: databases.map(file => auditDatabase(file)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) { console.error('Usage: node scripts/task-contract-audit.mjs <LECTERN_DATA_DIR>'); process.exitCode = 2; }
  else { try { console.log(JSON.stringify(auditDirectory(directory), null, 2)); }
    catch { console.error('Audit failed: database could not be read. No private data exported.'); process.exitCode = 1; } }
}
