import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditDatabase } from './task-contract-audit.mjs';

test('audit counts final parts once, distinguishes failed calls and never exports text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lectern-audit-'));
  const file = join(dir, 'zmzai.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE tasks(json TEXT); CREATE TABLE messages(id TEXT, session_id TEXT, created TEXT, message_seq INTEGER,json TEXT); CREATE TABLE parts(message_id TEXT,json TEXT);');
    db.prepare('INSERT INTO tasks VALUES (?)').run(JSON.stringify({ id: 't', sessionId: 's', rootUserMessageId: 'u', createdAt: '2026-01-01', status: 'delivered' }));
    for (const [id, role] of [['u', 'user'], ['a', 'assistant']]) db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(id, 's', '2026-01-01', 1, JSON.stringify({ role }));
    for (const part of [
      { type: 'text', text: '请提供 SECRET-CREDENTIAL' },
      { type: 'tool', tool: 'task_block', callId: 'b', state: { status: 'error' } },
      { type: 'tool', tool: 'task_deliver', callId: 'd', state: { status: 'completed' } },
    ]) db.prepare('INSERT INTO parts VALUES (?,?)').run('a', JSON.stringify(part));
    db.close();
    const report = auditDatabase(file);
    assert.equal(report.blockCalls, 1);
    assert.equal(report.blockErrors, 1);
    assert.equal(report.deliverCalls, 1);
    assert.equal(report.deliveredWithoutTool, 0);
    assert.equal(report.possibleMissingBlockMessages, 1);
    assert.ok(!JSON.stringify(report).includes('SECRET'));
    const reopened = new DatabaseSync(file, { readOnly: true });
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM parts').get().n, 3);
    reopened.close();
  } finally { if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
