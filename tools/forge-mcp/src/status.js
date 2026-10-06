#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// Read-only health check through the Forge client: node tools/forge-mcp/src/status.js
// Prints the target, whether the gate token is set (never the token), the answer time (a cold start of the
// cloud container shows up here), site statistics and whether the bot login works. Writes nothing.
// On the Cloudflare deployment this request wakes the container (it then sleeps again after 20 minutes).
// Exit codes: 0 ok, 1 the wiki or the login failed.
import { WikiClient, loadProjectEnv, connectionFromEnv } from './wiki.js';

loadProjectEnv();
const wiki = new WikiClient(connectionFromEnv());
console.log(`target:     ${wiki.origin}   (gate token ${wiki.apiToken ? 'set' : 'not set'})`);
const t0 = Date.now();
try {
  const q = await wiki.siteInfo();
  const s = q.statistics;
  console.log(`answer:     ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`wiki:       ${q.general.sitename}, ${q.general.generator}, ${q.general.dbtype ?? '?'}`);
  console.log(`statistics: ${s.pages} pages, ${s.articles} articles, ${s.edits} edits, ${s.images} files, ${s.users} users, ${s.jobs} queued jobs`);
  try {
    await wiki.login();
    console.log(`bot login:  ok (${wiki.user})`);
  } catch (e) {
    console.log(`bot login:  FAILED: ${e.message}`);
    process.exitCode = 1;
  }
} catch (e) {
  console.log(`answer:     FAILED after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${e.message}`);
  process.exitCode = 1;
}
