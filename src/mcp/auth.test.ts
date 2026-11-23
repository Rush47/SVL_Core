import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureToken, extractToken, tokenMatches, MIN_TOKEN_LENGTH } from './auth.ts';

test('mcp auth: token generated once, saved 0600, reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-mcp-auth-'));
  try {
    const file = path.join(dir, 'sub', 'token.secret');
    const a = ensureToken('', file);
    assert.equal(a.source, 'generated');
    assert.ok(a.token.length >= MIN_TOKEN_LENGTH);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const b = ensureToken('', file);
    assert.equal(b.source, 'file');
    assert.equal(b.token, a.token);
    const env = 'x'.repeat(40);
    assert.deepEqual(ensureToken(env, file), { token: env, source: 'env' });
    assert.throws(() => ensureToken('short', file), /co najmniej/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp auth: constant-time compare and header extraction', () => {
  const t = 'a'.repeat(43);
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(` ${t} `, t), true);
  assert.equal(tokenMatches('a'.repeat(42), t), false);
  assert.equal(tokenMatches('', t), false);
  assert.equal(tokenMatches(undefined, t), false);
  assert.equal(tokenMatches('short', 'short'), false, 'expected token too short is never accepted');
  assert.equal(extractToken({ authorization: `Bearer ${t}` }), t);
  assert.equal(extractToken({ authorization: `bearer ${t}` }), t);
  assert.equal(extractToken({ 'x-mcp-token': t }), t);
  assert.equal(extractToken({}), '');
});
