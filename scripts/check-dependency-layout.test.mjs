import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDependencyLayout } from './check-dependency-layout.mjs';

test('rejects a node_modules self-link before build tracing can recurse', () => {
  const root = mkdtempSync(join(tmpdir(), 'lectern-dependencies-'));
  const modules = join(root, 'node_modules'); mkdirSync(modules);
  try {
    symlinkSync(modules, join(modules, 'node_modules'), 'junction');
    assert.throws(() => checkDependencyLayout(root), /recursive.*node_modules/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('accepts a linked workspace dependency directory and normal package links', () => {
  const root = mkdtempSync(join(tmpdir(), 'lectern-dependencies-'));
  const modules = join(root, 'shared'); mkdirSync(modules);
  const workspace = join(root, 'checkout'); mkdirSync(workspace);
  mkdirSync(join(modules, 'package'));
  try {
    symlinkSync(modules, join(workspace, 'node_modules'), 'junction');
    symlinkSync(join(modules, 'package'), join(modules, 'alias'), 'junction');
    assert.doesNotThrow(() => checkDependencyLayout(workspace));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
