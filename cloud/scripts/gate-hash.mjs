#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// Gate password hash for the Worker secret GATE_PASSWORD_HASH (used by Set-Secrets.ps1).
// Format: pbkdf2-sha256$<iterations>$<salt>$<hash>, salt and hash in standard base64 with padding,
// PBKDF2-HMAC-SHA256 over the UTF-8 bytes of the password exactly as typed (no trimming, no Unicode
// normalisation), 100000 iterations (the Workers WebCrypto maximum), 16-byte random salt, 32-byte hash.
// The Worker checks it with crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt,
// iterations }, key, 256) and a constant-time compare.
//
// The password is read from stdin, never from the command line; one trailing newline is ignored.
//   node cloud/scripts/gate-hash.mjs                  < password   -> prints the hash string
//   node cloud/scripts/gate-hash.mjs --verify <hash>  < password   -> exit 0 if it matches, 1 if not
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ITERATIONS = 100_000;
export const SALT_BYTES = 16;
export const HASH_BYTES = 32;
export const PREFIX = 'pbkdf2-sha256';
const B64 = '[A-Za-z0-9+/]+={0,2}';
export const HASH_PATTERN = new RegExp(`^${PREFIX}\\$(\\d+)\\$(${B64})\\$(${B64})$`);

export function hashPassword(password, { salt = randomBytes(SALT_BYTES), iterations = ITERATIONS } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('empty password');
  const hash = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, HASH_BYTES, 'sha256');
  return `${PREFIX}$${iterations}$${Buffer.from(salt).toString('base64')}$${hash.toString('base64')}`;
}

/** { iterations, salt, hash } or null when the string is not in the format above. */
export function parseHash(stored) {
  const m = HASH_PATTERN.exec(String(stored ?? '').trim());
  if (!m) return null;
  const iterations = Number(m[1]);
  const salt = Buffer.from(m[2], 'base64');
  const hash = Buffer.from(m[3], 'base64');
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > ITERATIONS || salt.length < 8 || hash.length !== HASH_BYTES) return null;
  return { iterations, salt, hash };
}

export function verifyPassword(password, stored) {
  const p = parseHash(stored);
  if (!p) return false;
  const got = pbkdf2Sync(Buffer.from(String(password), 'utf8'), p.salt, p.iterations, p.hash.length, 'sha256');
  return timingSafeEqual(got, p.hash);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const password = await readStdin();
  if (args[0] === '--verify' && args.length === 2) {
    process.exitCode = verifyPassword(password, args[1]) ? 0 : 1;
  } else if (args.length === 0) {
    if (!password) { console.error('gate-hash: no password on stdin'); process.exit(2); }
    process.stdout.write(`${hashPassword(password)}\n`);
  } else {
    console.error('usage: node cloud/scripts/gate-hash.mjs [--verify <hash>]   (password on stdin)');
    process.exit(2);
  }
}
