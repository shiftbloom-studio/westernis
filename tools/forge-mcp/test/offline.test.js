// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Offline test of the Forge MCP server: starts it over stdio like Claude Code does and checks the
// tool list and the entity schemas. Needs no running wiki, no .env, and writes nothing.
//   cd tools/forge-mcp && npm test   (= node --test "test/*.test.js": every offline test)
// Always pass the files explicitly: a bare `node --test` would also pick up src/test-tools.js,
// the live test that writes to your wiki.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const schemas = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'schemas.json'), 'utf8'));
const parse = (result) => {
  assert.ok(!result.isError, `tool returned an error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
};

test('the MCP server lists its tools and serves the entity schemas without a wiki', async () => {
  // Port 9 (discard) is never contacted: listing tools and reading schemas stay local.
  const env = { WIKI_API: 'http://127.0.0.1:9/api.php' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pkgRoot, 'src', 'index.js')],
    env,
  });
  const client = new Client({ name: 'forge-offline-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.length >= 19, `expected at least 19 tools, got ${names.length}: ${names.join(', ')}`);
    for (const name of ['wiki_site_info', 'wiki_entity_schema', 'wiki_lore_context', 'wiki_create_entity', 'wiki_save_page']) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }

    const list = parse(await client.callTool({ name: 'wiki_entity_schema', arguments: {} }));
    assert.deepEqual(list.map((e) => e.key).sort(), schemas.entities.map((e) => e.key).sort());

    for (const entity of schemas.entities) {
      const one = parse(await client.callTool({ name: 'wiki_entity_schema', arguments: { type: entity.key } }));
      assert.equal(one.key, entity.key);
      assert.equal(one.template, entity.template);
      assert.ok(Array.isArray(one.fields) && one.fields.length > 0, `${entity.key} has no fields`);
    }
  } finally {
    await client.close();
  }
});
