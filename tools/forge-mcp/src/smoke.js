// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Quick end-to-end check of the wiki client: node src/smoke.js
// Needs a running wiki and WRITES to it (page Notes:Forge smoke test).
import { WikiClient, loadProjectEnv, connectionFromEnv } from './wiki.js';

const envFile = loadProjectEnv();
const wiki = new WikiClient(connectionFromEnv());
console.log('env file:', envFile, '| api:', wiki.api, '| user:', wiki.user);
const info = await wiki.siteInfo();
console.log('site:', info.general.sitename, info.general.generator, '| pages:', info.statistics.pages, 'articles:', info.statistics.articles);
console.log('login:', JSON.stringify(await wiki.login()));
const who = await wiki.get({ action: 'query', meta: 'userinfo', uiprop: 'rights|groups' });
console.log('user:', who.query.userinfo.name, 'groups:', who.query.userinfo.groups?.join(','));
const r = await wiki.edit({ title: 'Notes:Forge smoke test', text: `Forge MCP smoke test at ${new Date().toISOString()}.`, summary: 'Forge smoke test', mode: 'overwrite' });
console.log('edit:', r.result, 'rev', r.newrevid);
const p = await wiki.getPage('Notes:Forge smoke test');
console.log('read back:', p.exists, p.wikitext.slice(0, 60));
console.log('search:', (await wiki.search('Gondor', { limit: 3 })).map((s) => s.title));
try { console.log('cargo:', (await wiki.cargoQuery({ tables: 'Characters', fields: '_pageName,realm', limit: 5 })).length, 'rows'); } catch (e) { console.log('cargo:', e.message); }
console.log('wanted:', (await wiki.queryPage('Wantedpages', 5)).map((w) => w.title));
