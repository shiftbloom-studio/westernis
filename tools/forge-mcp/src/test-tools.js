// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Drives the Forge MCP server over stdio like Claude Code would, and calls each tool once.
// node src/test-tools.js  (npm run test:live) - needs a running wiki and WRITES to it (Notes:Forge test/*)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'index.js')], env: process.env });
const client = new Client({ name: 'forge-test', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  const summary = typeof parsed === 'string' ? parsed.slice(0, 160) : JSON.stringify(parsed).slice(0, 220);
  console.log(`\n== ${name} ${r.isError ? '[ERROR]' : ''}\n   ${summary}`);
  return parsed;
}

await call('wiki_site_info', {});
await call('wiki_entity_schema', {});
const schema = await call('wiki_entity_schema', { type: 'character' });
console.log('   character fields:', schema.fields.length, 'sections:', schema.sections.join('/'));
await call('wiki_search', { query: 'Gondor', limit: 3 });
const page = await call('wiki_get_page', { title: 'Aragorn II' });
console.log('   infobox race:', page.infobox?.fields?.race, '| sections:', page.sections?.length);
const ctx = await call('wiki_lore_context', { topic: 'Gondor', limit: 4 });
console.log('   linkedFrom:', ctx.linkedFrom?.length, '| cargo tables:', ctx.mentionedInCargo?.map((c) => c.table).join(','), '| related:', ctx.related?.map((r) => r.title).join(', '));
await call('wiki_cargo_query', { tables: 'Characters', fields: '_pageName,race,realm', where: "realm='Gondor'", limit: 5 });
await call('wiki_list_category', { category: 'Characters', limit: 10 });
await call('wiki_links_here', { title: 'Sauron', limit: 10 });
await call('wiki_wanted_pages', { kind: 'wanted', limit: 8 });
await call('wiki_recent_changes', { limit: 3 });
const links = await call('wiki_suggest_links', { text: 'Halbarad rode from Rivendell to Minas Tirith with the Rangers of the North, bearing a banner for Aragorn II and news of Sauron.' });
console.log('   linkable:', links.linkable?.join(', '), '\n   text:', links.text);
await call('wiki_preview', { text: "'''Halbarad''' was a [[Dúnedain|Dúnadan]] of the North and kinsman of [[Aragorn II]]. He fell at the [[Battle of the Pelennor Fields]].", title: 'Halbarad' });
const T = 'Notes:Forge test/Halbarad';   // sandbox page in the Notes namespace, never a real article
const created = await call('wiki_create_entity', {
  type: 'character', title: T,
  fields: { race: 'Men', culture: 'Dúnedain', affiliation: 'Rangers of the North', position: 'Ranger of the North', death: '15 March', death_year: 3019, death_era: 'Third Age', deathplace: 'Minas Tirith', short: 'Ranger of the North, kinsman of Aragorn', canon: 'Draft' },
  body: "'''Halbarad''' was a Ranger of the North and a kinsman of [[Aragorn II]]. He led the Grey Company south and bore the standard of the heir of Isildur, and he fell on the fields of the Pelennor.\n\n== History ==\nHalbarad brought thirty Rangers to Rohan in answer to a summons he had not received, and rode the Paths of the Dead beside Aragorn.\n\n=== The Grey Company ===\nThirty Rangers and the sons of Elrond.\n\n== Relationships ==\n{{Relationships}}\n\n== Appearances ==\n{{Appearances}}\n",
  summary: 'Forge test: create Halbarad', mode: 'overwrite',
});
console.log('   url:', created.url, '| red links:', created.redLinks);
await call('wiki_lint_article', { title: T });
await call('wiki_edit_section', { title: T, heading: 'History', text: 'Rewritten history body — the subsection below must survive.', summary: 'Forge test: replace section keeping children' });
const after = await call('wiki_get_page', { title: T });
console.log('   sections after edit:', after.sections?.map((s) => s.title).join(' / '));
await call('wiki_edit_section', { title: T, heading: 'Legacy', text: 'His banner, worked by Arwen, flew over the Pelennor.', summary: 'Forge test: add section' });
await call('wiki_save_page', { title: 'Notes:Forge test/log', text: 'Forge tool test ran.', summary: 'Forge test', mode: 'overwrite' });
await call('wiki_save_page', { title: 'Notes:Forge test/log', text: 'stale write', summary: 'Forge test: conflict', mode: 'update', baseTimestamp: '2020-01-01T00:00:00Z' });
await call('wiki_purge', { titles: [T, 'Aragorn II'] });
await client.close();
console.log('\nALL TOOLS EXERCISED');
