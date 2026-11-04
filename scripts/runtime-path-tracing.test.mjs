import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

test('runtime workspace path avoids NFT scanning arbitrary dependency directories', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lectern-nft-'));
  const original = fs.readdir;
  let count = 0;
  fs.readdir = function (...args) { count++; return original.apply(this, args); };
  try {
    const { nodeFileTrace } = createRequire(import.meta.url)('next/dist/compiled/@vercel/nft');
    const entry = join(root, 'entry.cjs');
    fs.writeFileSync(entry, 'const path=require("node:path");exports.f=(root,id)=>path.resolve(root,".lectern-worktrees",id);');
    await nodeFileTrace([entry], { base: root, processCwd: root });
    assert.ok(count > 0, 'control must demonstrate broad runtime-path tracing');
    buildSync({ stdin: { contents: 'import { runtimeWorkspacePath } from "./lib/runtime-workspace-path.ts"; export const f=(root,id)=>runtimeWorkspacePath(root,".lectern-worktrees",id);', resolveDir: process.cwd() }, outfile: entry, platform: 'node', format: 'cjs', bundle: true });
    const mod = createRequire(import.meta.url)(entry);
    assert.equal(mod.f(root, 'session'), join(root, '.lectern-worktrees', 'session'));
    count = 0;
    await nodeFileTrace([entry], { base: root, processCwd: root });
    assert.equal(count, 0, 'runtime project paths are not build assets');
  } finally { fs.readdir = original; fs.rmSync(root, { recursive: true, force: true }); }
});
