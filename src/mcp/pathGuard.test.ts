import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInRoot, PathOutsideRootError } from './pathGuard.ts';

test('mcp path guard: stays inside MCP_ROOT, blocks traversal and symlink escape', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svl-mcp-pg-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'link'));
  try {
    assert.equal(await resolveInRoot(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
    assert.equal(await resolveInRoot(root, ''), root);
    assert.equal(await resolveInRoot(root, path.join(root, 'a')), path.join(root, 'a'));
    assert.equal(await resolveInRoot(root, 'new/deep/file.txt'), path.join(root, 'new', 'deep', 'file.txt'));
    await assert.rejects(resolveInRoot(root, '../outside/x'), PathOutsideRootError);
    await assert.rejects(resolveInRoot(root, '/etc/passwd'), PathOutsideRootError);
    await assert.rejects(resolveInRoot(root, 'link/x.txt'), PathOutsideRootError);
    await assert.rejects(resolveInRoot(root, 'a/\0'), PathOutsideRootError);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
