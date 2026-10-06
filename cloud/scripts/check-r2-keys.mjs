// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// Checks the two bucket-scoped R2 keys from .env.cloud without printing them: each key must be able
// to list its own bucket (HTTP 200) and must NOT be able to list the other bucket (HTTP 403).
// Usage (from the repo root): node cloud/scripts/check-r2-keys.mjs   (called by Set-R2Keys.ps1)
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env.cloud', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const account = env.CF_ACCOUNT_ID;
const jurisdiction = env.R2_JURISDICTION ? `.${env.R2_JURISDICTION}` : '';
const host = `${account}${jurisdiction}.r2.cloudflarestorage.com`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

async function listBucket(bucket, keyId, secret) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = now.slice(0, 8);
  const query = 'list-type=2&max-keys=1';
  const payload = sha256('');
  const canonical = ['GET', `/${bucket}`, query, `host:${host}`, `x-amz-content-sha256:${payload}`, `x-amz-date:${now}`, '',
    'host;x-amz-content-sha256;x-amz-date', payload].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  let k = hmac(`AWS4${secret}`, date);
  for (const part of ['auto', 's3', 'aws4_request']) k = hmac(k, part);
  const signature = createHmac('sha256', k).update(toSign).digest('hex');
  const res = await fetch(`https://${host}/${bucket}?${query}`, {
    headers: {
      'x-amz-date': now,
      'x-amz-content-sha256': payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  });
  await res.arrayBuffer();
  return res.status;
}

const pairs = [
  { name: 'DB', bucket: env.R2_DB_BUCKET, other: env.R2_MEDIA_BUCKET, id: env.R2_DB_ACCESS_KEY_ID, secret: env.R2_DB_SECRET_ACCESS_KEY },
  { name: 'MEDIA', bucket: env.R2_MEDIA_BUCKET, other: env.R2_DB_BUCKET, id: env.R2_MEDIA_ACCESS_KEY_ID, secret: env.R2_MEDIA_SECRET_ACCESS_KEY },
];
let ok = true;
for (const p of pairs) {
  if (!account || !p.bucket || !p.id || !p.secret) { console.log(`${p.name}: missing values in .env.cloud`); ok = false; continue; }
  const own = await listBucket(p.bucket, p.id, p.secret);
  const other = await listBucket(p.other, p.id, p.secret);
  const good = own === 200 && other === 403;
  ok &&= good;
  console.log(`${p.name} key: own bucket ${p.bucket} -> ${own === 200 ? 'OK' : `HTTP ${own}`}, ` +
    `other bucket ${p.other} -> ${other === 403 ? 'blocked (good)' : `HTTP ${other} (should be 403: limit the token to one bucket)`}`);
}
console.log(ok ? 'All R2 keys work and are limited to their bucket.' : 'Some R2 keys need attention (see above).');
process.exit(ok ? 0 : 1);
