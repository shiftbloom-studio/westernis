// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Tests of gate-hash.mjs, including a cross-check with WebCrypto, which is what the Worker uses.
//   node --test cloud/scripts/gate-hash.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, parseHash, ITERATIONS } from './gate-hash.mjs';

const cli = fileURLToPath(new URL('./gate-hash.mjs', import.meta.url));
const SALT = Buffer.from([...Array(16).keys()]);           // 00 01 02 ... 0f
// Fixed vector: password "correct horse battery" with the salt above (also given to the Worker's tests).
const VECTOR = 'pbkdf2-sha256$100000$AAECAwQFBgcICQoLDA0ODw==$yNEi7NuUd81IprF1DFmFwLiwUVjQQNIFF8zbSYZd5DY=';

test('format, fixed vector and verification', () => {
  const h = hashPassword('correct horse battery', { salt: SALT });
  assert.equal(h, VECTOR);
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('correct horse batterY', h), false);
  assert.equal(verifyPassword('correct horse battery ', h), false, 'no trimming');
  const p = parseHash(h);
  assert.equal(p.iterations, ITERATIONS);
  assert.equal(p.salt.length, 16);
  assert.equal(p.hash.length, 32);
  assert.equal(parseHash('pbkdf2-sha256$100001$AAECAwQFBgcICQoLDA0ODw==$yNEi7NuUd81IprF1DFmFwLiwUVjQQNIFF8zbSYZd5DY='), null, 'above the Workers limit');
  assert.equal(parseHash('sha256$1$a$b'), null);
  const random = parseHash(hashPassword('x'.repeat(12)));
  assert.equal(random.salt.length, 16);
});

test('WebCrypto (as in the Worker) derives the same hash', async () => {
  const p = parseHash(VECTOR);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct horse battery'), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: p.salt, iterations: p.iterations }, key, 256);
  assert.deepEqual(Buffer.from(bits), p.hash);
  // Non-ASCII passwords: both sides hash the UTF-8 bytes
  const h = hashPassword('Mellon-Grüße-ᚠ', { salt: SALT });
  const k2 = await crypto.subtle.importKey('raw', new TextEncoder().encode('Mellon-Grüße-ᚠ'), 'PBKDF2', false, ['deriveBits']);
  const b2 = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITERATIONS }, k2, 256);
  assert.deepEqual(Buffer.from(b2), parseHash(h).hash);
});

test('command line: password from stdin, one trailing newline ignored', () => {
  const out = execFileSync(process.execPath, [cli], { input: 'a sufficiently long one\r\n' }).toString().trim();
  assert.ok(verifyPassword('a sufficiently long one', out));
  execFileSync(process.execPath, [cli, '--verify', out], { input: 'a sufficiently long one' });
  assert.throws(() => execFileSync(process.execPath, [cli, '--verify', out], { input: 'wrong password!', stdio: 'pipe' }));
});
