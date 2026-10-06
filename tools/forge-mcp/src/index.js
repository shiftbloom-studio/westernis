#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Forge — MCP server for the Westernis wiki.
// Exposes lore-aware tools (search, read, create entities from the shared schemas,
// link suggestions, red-link backlog, lint, Cargo queries, uploads) to Claude Code.
// NOTE: stdout is the MCP transport — never console.log here; use console.error for diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WikiClient, loadProjectEnv, connectionFromEnv } from './wiki.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = loadProjectEnv();
const schemas = JSON.parse(fs.readFileSync(path.join(here, '..', 'schemas.json'), 'utf8'));
const ENTITY_KEYS = schemas.entities.map((e) => e.key);
const entityByKey = Object.fromEntries(schemas.entities.map((e) => [e.key, e]));
const entityByTemplate = Object.fromEntries(schemas.entities.map((e) => [e.template.toLowerCase(), e]));

const wiki = new WikiClient(connectionFromEnv());
const projectRoot = path.resolve(here, '..', '..', '..');
const uploadRoots = [projectRoot, ...(process.env.FORGE_UPLOAD_DIRS || '').split(path.delimiter).filter(Boolean)].map((p) => path.resolve(p));

const MAX_PAGE_CHARS = 60_000;
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });
const clip = (s, n = MAX_PAGE_CHARS) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);
const decodeEntities = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const conflictMessage = (e, title) => (e.code === 'editconflict' || e.code === 'articleexists' ? `${e.code}: "${title}" changed since you read it (or already exists). Re-read it with wiki_get_page and retry.` : e.message);

// ---------------------------------------------------------------- wikitext helpers
/** Span of the first {{Infobox …}} template, found by brace depth (nested templates are fine). */
function infoboxSpan(wikitext) {
  const start = wikitext.search(/\{\{\s*Infobox [a-z]+/i);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext.startsWith('{{', i)) { depth++; i++; continue; }
    if (wikitext.startsWith('}}', i)) { depth--; i++; if (depth === 0) return { start, end: i + 1 }; }
  }
  return null;
}

function parseInfobox(wikitext) {
  const span = infoboxSpan(wikitext);
  if (!span) return null;
  const inner = wikitext.slice(span.start + 2, span.end - 2);
  const nameMatch = inner.match(/^\s*(Infobox [a-z]+)\s*/i);
  if (!nameMatch) return null;
  const body = inner.slice(nameMatch[0].length);
  const fields = {};
  let depth = 0; let cur = ''; const parts = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue; }
    const ch = body[i];
    if (ch === '|' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const template = nameMatch[1].replace(/\s+/g, ' ');
  return { template, entity: entityByTemplate[template.toLowerCase()]?.key || null, fields };
}

/**
 * Every identifier a Cargo query on this entity's table can resolve (lower case: SQLite compares
 * identifiers case-insensitively): the declared fields, the __full columns of list fields, Cargo's
 * own columns, the helper-table columns HOLDS joins in, and SQLite's rowid aliases.
 */
const CARGO_BUILTIN_COLUMNS = ['_pagename', '_pagetitle', '_pagenamespace', '_pageid', '_id', '_value', '_rowid', '_position', 'rowid', 'oid', '_rowid_'];
const cargoColumnCache = new Map();
function cargoColumnNames(entity) {
  if (!cargoColumnCache.has(entity.key)) {
    const names = new Set(CARGO_BUILTIN_COLUMNS);
    for (const f of entity.fields) {
      names.add(f.name.toLowerCase());
      if (/^List of /i.test(f.type || '')) names.add(`${f.name.toLowerCase()}__full`);
    }
    cargoColumnCache.set(entity.key, names);
  }
  return cargoColumnCache.get(entity.key);
}

function stripInfobox(wikitext) {
  const span = infoboxSpan(wikitext);
  return span ? wikitext.slice(0, span.start) + wikitext.slice(span.end) : wikitext;
}

function sectionsOf(wikitext) {
  return [...wikitext.matchAll(/^(={2,4})\s*(.+?)\s*\1\s*$/gm)].map((m) => ({ level: m[1].length, title: m[2] }));
}

function buildEntityWikitext(entity, fields, body) {
  const known = new Map(entity.fields.map((f) => [f.name, f]));
  const unknown = Object.keys(fields).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`Unknown field(s) for ${entity.singular}: ${unknown.join(', ')}. Valid: ${[...known.keys()].join(', ')}`);
  for (const [k, v] of Object.entries(fields)) {
    const f = known.get(k); const s = String(v).trim();
    if (!s) continue;
    if ((f.type === 'Integer') && !/^-?\d+$/.test(s)) throw new Error(`Field "${k}" must be an integer (got "${s}")`);
    if (f.values && !f.values.includes(s)) throw new Error(`Field "${k}" must be one of: ${f.values.join(', ')} (got "${s}")`);
  }
  const lines = [`{{${entity.template}`];
  for (const f of entity.fields) {
    if (fields[f.name] !== undefined && String(fields[f.name]).trim() !== '') lines.push(`| ${f.name} = ${String(fields[f.name]).trim()}`);
  }
  lines.push('}}');
  const keys = entity.sectionKeys || entity.sections;
  const skeleton = entity.sections.map((s, i) => {
    switch (keys[i]) {
      case 'Gallery': return `== ${s} ==\n<gallery mode="packed-hover">\n</gallery>`;
      case 'Notes': return `== ${s} ==\n<references />`;
      case 'Appearances': return `== ${s} ==\n{{Appearances}}`;
      case 'Genealogy': return `== ${s} ==\n{{Family tree}}`;
      case 'Relationships': return `== ${s} ==\n{{Relationships}}`;
      case 'Timeline': return `== ${s} ==\n{{Timeline|era={{PAGENAME}}}}`;
      default: return `== ${s} ==\n`;
    }
  }).join('\n\n');
  const text = body && body.trim() ? body.trim() : skeleton;
  return `${lines.join('\n')}\n${text}\n`;
}

const STOPW = /^(The|A|An|In|On|Of|He|She|It|They|His|Her|Their|This|That|These|Those|When|Where|While|After|Before|But|And|Or|For|With|From|By|At|As|If|So|To|Then|There|Here|Yet|Now|Thus|Still|Der|Die|Das|Ein|Eine|Einer|Eines|Einem|Einen|Dem|Den|Des|Und|Oder|Aber|Als|Wie|Wenn|Doch|Im|Am|Vom|Zum|Zur|Bei|Mit|Nach|Von|Vor|Aus|Auf|Für|Über|Unter|Er|Sie|Es|Ihr|Sein|Seine|Ihre|Dieser|Diese|Dieses|Dort|Hier|Dann|Damals|Noch|Nun|So|Da|Denn|Nachdem|Bevor|Während|Doch|Jedoch|Später|Zuerst|Schließlich)$/;
function candidatePhrases(text) {
  // strip existing links/templates/tags so we only propose links for plain mentions
  const plain = text.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]+>/g, ' ');
  const word = "\\p{Lu}[\\p{L}\\p{N}'’-]*";
  // \b is ASCII-only in JS: use a lookbehind; connectors need a following space so "an" cannot eat "and".
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${word}(?:\\s+(?:(?:of|the|de|du|an|na|and|von|der|des|dem|den|die|im|am|zu|vom|zum|zur|und)(?=\\s)|${word}))*)`, 'gu');
  const set = new Set();
  for (const m of plain.matchAll(re)) {
    const phrase = m[1].replace(/\s+/g, ' ').trim();
    if (phrase.length < 3) continue;
    set.add(phrase);
    const words = phrase.split(' ');
    for (let n = Math.min(words.length - 1, 3); n >= 1; n--) set.add(words.slice(0, n).join(' '));
  }
  return [...set].filter((p) => !STOPW.test(p) && !/\s(of|the|de|du|an|na|and)$/i.test(p));
}

/** Link the first plain-prose mention of each title, leaving templates, links, headings, galleries, refs and tags alone. */
function linkFirstMentions(text, titles) {
  const masks = [];
  let masked = text;
  const protect = (re) => { masked = masked.replace(re, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; }); };
  // depth-aware {{ }} spans
  let out = ''; let i = 0;
  while (i < masked.length) {
    if (masked.startsWith('{{', i)) {
      let depth = 0; let j = i;
      for (; j < masked.length - 1; j++) {
        if (masked.startsWith('{{', j)) { depth++; j++; continue; }
        if (masked.startsWith('}}', j)) { depth--; j++; if (depth === 0) { j++; break; } }
      }
      masks.push(masked.slice(i, j)); out += `\u0000${masks.length - 1}\u0000`; i = j; continue;
    }
    out += masked[i]; i++;
  }
  masked = out;
  protect(/<!--[\s\S]*?-->/g);
  protect(/<(gallery|ref|nowiki|pre|syntaxhighlight|source|math)\b[^>]*>[\s\S]*?<\/\1>/gi);
  protect(/\[\[[^\]]*\]\]/g);
  protect(/^=+[^\n]*=+\s*$/gm);
  protect(/^\s*(File|Image|Datei|Bild):[^\n]*$/gmi);
  for (const title of [...titles].sort((a, b) => b.length - a.length)) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\[\\[${esc}(\\||\\]\\])`).test(text)) continue; // already linked somewhere
    const re = new RegExp(`(?<![\\p{L}\\p{N}'’\\[|])${esc}(?![\\p{L}\\p{N}\\]|])`, 'u');
    if (re.test(masked)) masked = masked.replace(re, `[[${title}]]`);
  }
  return masked.replace(/\u0000(\d+)\u0000/g, (_, n) => masks[Number(n)]);
}

// ---------------------------------------------------------------- server
const server = new McpServer({ name: 'westernis-forge', version: '1.1.0' });

server.registerTool('wiki_site_info', {
  title: 'Wiki overview',
  description: 'Site name, URL, statistics (pages, articles, files), the bot account status, entity types and installed extensions. Call once at the start of a session.',
  inputSchema: {},
}, async () => {
  try {
    let login;
    try { await wiki.ensureLogin(); login = { loggedIn: true, user: wiki.user }; } catch (e) { login = { loggedIn: false, error: e.message }; }
    const q = await wiki.siteInfo();
    return json({
      sitename: q.general.sitename, server: q.general.server, articlepath: q.general.articlepath, generator: q.general.generator,
      statistics: q.statistics, bot: login, envFile, api: wiki.api, gateToken: wiki.apiToken ? 'set' : 'not set',
      entityTypes: ENTITY_KEYS,
      extensions: q.extensions.map((e) => `${e.name} ${e.version || ''}`.trim()),
    });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_entity_schema', {
  title: 'Entity schema',
  description: 'Fields, article sections and conventions for an article type (character, location, faction, people, creature, artifact, event, era, language, power, chronicle). Without a type, lists all types. Use before creating or editing entity pages.',
  inputSchema: { type: z.enum(ENTITY_KEYS).optional().describe('Entity type key') },
}, async ({ type }) => {
  if (!type) return json(schemas.entities.map((e) => ({ key: e.key, singular: e.singular, template: e.template, category: e.category, namespace: e.namespace || 'Main', description: e.description })));
  return json(entityByKey[type]);
});

server.registerTool('wiki_search', {
  title: 'Search the wiki',
  description: 'Full-text search plus title-prefix matches. Returns titles with snippets.',
  inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
}, async ({ query, limit }) => {
  try {
    const [hits, prefix] = await Promise.all([wiki.search(query, { limit }), wiki.prefixSearch(query, 10)]);
    return json({ query, prefixMatches: prefix, results: hits });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_get_page', {
  title: 'Read a page',
  description: 'Wikitext and metadata (categories, templates, links, image, last edit) of one page. Follows redirects. Keep `lastmod` and pass it as baseTimestamp when saving, so edits made in the browser meanwhile are not overwritten.',
  inputSchema: { title: z.string().min(1) },
}, async ({ title }) => {
  try {
    const p = await wiki.getPage(title);
    if (!p.exists) return json({ title, exists: false, hint: 'Page does not exist. Create it with wiki_create_entity or wiki_save_page.' });
    const infobox = parseInfobox(p.wikitext);
    return json({ ...p, wikitext: clip(p.wikitext), infobox, sections: sectionsOf(p.wikitext) });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_get_pages', {
  title: 'Read several pages',
  description: 'Wikitext of up to 20 pages at once (each clipped to 15k chars). Good for gathering context.',
  inputSchema: { titles: z.array(z.string()).min(1).max(20) },
}, async ({ titles }) => {
  try {
    const pages = await Promise.all(titles.map((t) => wiki.getPage(t)));
    return json(pages.map((p) => (p.exists ? { title: p.title, lastmod: p.lastmod, description: p.description, categories: p.categories, infobox: parseInfobox(p.wikitext), wikitext: clip(p.wikitext, 15_000) } : { title: p.title, exists: false })));
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_lore_context', {
  title: 'Gather lore context',
  description: 'Everything the wiki already knows about a topic: the topic page itself (if any), pages linking to it, search hits with their infobox data, and Cargo rows mentioning it. Use BEFORE writing so new text stays consistent with existing lore.',
  inputSchema: { topic: z.string().min(1), limit: z.number().int().min(1).max(15).default(6) },
}, async ({ topic, limit }) => {
  try {
    const main = await wiki.getPage(topic);
    const hits = await wiki.search(topic, { limit });
    const titles = [...new Set([...(main.exists ? [main.title] : []), ...hits.map((h) => h.title)])].slice(0, limit + 1);
    const pages = await Promise.all(titles.map((t) => wiki.getPage(t)));
    const backlinks = main.exists ? await wiki.linksHere(main.title, 40) : [];
    const cargo = [];
    const cargoSkipped = [];
    for (const e of schemas.entities) {
      const refFields = e.fields.filter((f) => f.type === 'List of Page' || f.type === 'Page');
      if (!refFields.length) continue;
      const safe = topic.replace(/"/g, '');
      // On SQLite a double-quoted value that names a column is read as that column ("Realm" -> realm = realm),
      // which matches unrelated rows. Values stay double-quoted (the only quoting that survives HOLDS and
      // apostrophes), so a topic equal to a column name of this table is skipped instead.
      if (cargoColumnNames(e).has(safe.trim().toLowerCase())) {
        cargoSkipped.push({ table: e.table, reason: `"${safe}" is also a column name of ${e.table}` });
        continue;
      }
      const where = refFields.map((f) => (f.type === 'Page' ? `${f.name}="${safe}"` : `${f.name} HOLDS "${safe}"`)).join(' OR ');
      try {
        const rows = await wiki.cargoQuery({ tables: e.table, fields: '_pageName=page', where, limit: 30 });
        if (rows.length) cargo.push({ table: e.table, pages: rows.map((r) => r.page) });
      } catch { /* table may not exist yet */ }
    }
    return json({
      topic,
      topicPage: main.exists ? { title: main.title, lastmod: main.lastmod, description: main.description, infobox: parseInfobox(main.wikitext), sections: sectionsOf(main.wikitext), wikitext: clip(main.wikitext, 20_000) } : null,
      linkedFrom: backlinks,
      mentionedInCargo: cargo,
      ...(cargoSkipped.length ? { cargoSkipped } : {}),
      related: pages.filter((p) => p.exists && p.title !== main.title).map((p) => ({ title: p.title, description: p.description, infobox: parseInfobox(p.wikitext)?.fields, lead: clip(stripInfobox(p.wikitext).split('\n==')[0].trim(), 1500) })),
    });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_cargo_query', {
  title: 'Query structured data (Cargo)',
  description: 'SQL-like query over the entity tables (Characters, Locations, Factions, Peoples, Creatures, Artifacts, Events, Eras, Languages, Powers, Chronicles). Example: tables="Characters", fields="_pageName,race,realm", where="realm=\'Gondor\'". List fields use HOLDS: where="affiliation HOLDS \'Fellowship of the Ring\'". Rows come back keyed by field name (underscore fields such as _pageName are returned as pageName). '
    + 'SQL dialect: the cloud wiki stores Cargo data in SQLite, so write queries that work there: '
    + '(1) = and HOLDS compare case- and accent-sensitively (\'gondor\' does not match \'Gondor\'); LIKE ignores case for ASCII letters only. '
    + '(2) Quote values with single quotes; a double-quoted value that equals a column name is read as that column (realm="Realm" compares realm with itself). Use double quotes only for values containing an apostrophe. '
    + '(3) MySQL-only functions do not exist: no YEAR(), MONTH(), DATE_FORMAT(), IF(), NOW(), REGEXP; use CASE WHEN … END and the Integer year fields instead. LOG(x) is base 10. '
    + '(4) order_by sorts by byte order: uppercase before lowercase, umlauts and accented letters after z.',
  inputSchema: {
    tables: z.string(), fields: z.string().default('_pageName'), where: z.string().optional(), order_by: z.string().optional(),
    group_by: z.string().optional(), having: z.string().optional(), join_on: z.string().optional(), limit: z.number().int().min(1).max(500).default(50),
  },
}, async (args) => {
  try { return json(await wiki.cargoQuery(args)); } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_list_category', {
  title: 'List a category',
  description: 'Members of a category (pages, files, subcategories).',
  inputSchema: { category: z.string(), limit: z.number().int().min(1).max(500).default(100) },
}, async ({ category, limit }) => {
  try { return json(await wiki.categoryMembers(category, limit)); } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_links_here', {
  title: 'What links here',
  description: 'Pages that link to a title (also works for titles that do not exist yet — shows where a red link is wanted).',
  inputSchema: { title: z.string(), limit: z.number().int().min(1).max(200).default(50) },
}, async ({ title, limit }) => {
  try { return json(await wiki.linksHere(title, limit)); } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_wanted_pages', {
  title: 'Backlog of wanted pages',
  description: 'Red links (pages that are linked but do not exist), ranked by how often they are wanted. Also: deadend (pages with no links), lonely (orphans), uncategorized, short. This is the natural to-do list for extending the universe.',
  inputSchema: { kind: z.enum(['wanted', 'deadend', 'lonely', 'uncategorized', 'short']).default('wanted'), limit: z.number().int().min(1).max(200).default(40) },
}, async ({ kind, limit }) => {
  try {
    const map = { wanted: 'Wantedpages', deadend: 'Deadendpages', lonely: 'Lonelypages', uncategorized: 'Uncategorizedpages', short: 'Shortpages' };
    const rows = await wiki.queryPage(map[kind], limit * 2);
    const filtered = rows.filter((r) => (r.ns === undefined ? !/^(File|Datei|Template|Vorlage|Module|Modul|Category|Kategorie|MediaWiki|Form|Formular|Help|Hilfe|User|Benutzer|Special|Spezial):/.test(r.title) : [0, 3000].includes(r.ns))).slice(0, limit);
    return json({ kind, items: filtered.map((r) => ({ title: r.title, [kind === 'wanted' ? 'linkedFrom' : 'value']: r.value })) });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_recent_changes', {
  title: 'Recent changes',
  description: 'Latest edits and new pages.',
  inputSchema: { limit: z.number().int().min(1).max(100).default(30) },
}, async ({ limit }) => {
  try { return json(await wiki.recentChanges(limit)); } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_suggest_links', {
  title: 'Suggest links',
  description: 'Finds existing wiki pages mentioned in prose and returns the text with the first mention of each turned into a [[link]] (templates, existing links, headings, galleries and refs are left untouched). Pass the article body, not the infobox. Also lists mentioned names that have no page yet (candidate new articles). Give `title` to avoid linking the page to itself.',
  inputSchema: { text: z.string().min(1), title: z.string().optional(), autolink: z.boolean().default(true) },
}, async ({ text, title, autolink }) => {
  try {
    const phrases = candidatePhrases(text).slice(0, 400);
    const { exists, canonical } = await wiki.pagesExist(phrases);
    const found = [...new Set(phrases.filter((p) => exists.get(p)).map((p) => canonical.get(p) || p))].filter((t) => !title || t.toLowerCase() !== title.toLowerCase());
    const STOP = /\b(of|the|and|an|a|in|on|to|for|with|from|by|at|as|or)$/i;
    const missing = phrases.filter((p) => exists.get(p) === false && p.split(' ').length >= 2 && !STOP.test(p)
      && !found.some((t) => t.startsWith(p + ' ') || t === p) && !/\b[a-z]{1,2}$/.test(p)).slice(0, 40);
    return json({ linkable: found, notYetPages: missing, text: autolink ? linkFirstMentions(text, found) : undefined });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_preview', {
  title: 'Preview wikitext',
  description: 'Renders wikitext without saving: returns red links, categories, templates used, parser warnings and a plain-text rendering.',
  inputSchema: { text: z.string(), title: z.string().default('Preview') },
}, async ({ text, title }) => {
  try {
    const p = await wiki.parse(text, title);
    const html = p.text || '';
    return json({
      redLinks: (p.links || []).filter((l) => !l.exists).map((l) => l.title),
      links: (p.links || []).filter((l) => l.exists).map((l) => l.title),
      categories: (p.categories || []).map((c) => c.category),
      templates: (p.templates || []).map((t) => t.title),
      warnings: p.warnings || [],
      sections: (p.sections || []).map((s) => `${'#'.repeat(Number(s.toclevel) || 1)} ${s.line}`),
      textPreview: clip(html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 6000),
    });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_save_page', {
  title: 'Save a page',
  description: 'Create or edit a page with raw wikitext. mode: create (fail if exists), overwrite, update (fail if missing), append, prepend. Pass baseTimestamp (the lastmod from wiki_get_page) so a page edited in the browser meanwhile is merged or reported instead of clobbered. Always write a meaningful summary.',
  inputSchema: {
    title: z.string().min(1), text: z.string(), summary: z.string().min(3),
    mode: z.enum(['create', 'overwrite', 'update', 'append', 'prepend']).default('update'), minor: z.boolean().default(false),
    baseTimestamp: z.string().optional().describe('lastmod value returned by wiki_get_page'),
  },
}, async ({ title, text, summary, mode, minor, baseTimestamp }) => {
  try {
    let r;
    try { r = await wiki.edit({ title, text, summary, mode, minor, baseTimestamp }); }
    catch (e) { if (e.code === 'missingtitle' && mode === 'update') return fail(`"${title}" does not exist; use mode "create".`); throw e; }
    const preview = await wiki.parsePage(title);
    return json({ result: r.result, title: r.title, newrevid: r.newrevid, nochange: r.nochange || false, url: wiki.pageUrl(r.title), redLinks: (preview.links || []).filter((l) => !l.exists).map((l) => l.title) });
  } catch (e) { return fail(conflictMessage(e, title)); }
});

server.registerTool('wiki_edit_section', {
  title: 'Replace or add a section',
  description: 'Replaces the body of the section with the given heading (any level) while keeping its subsections, or appends a new section if the heading does not exist. `text` is the section body without the heading line.',
  inputSchema: { title: z.string(), heading: z.string(), text: z.string(), summary: z.string().min(3), level: z.number().int().min(2).max(4).default(2) },
}, async ({ title, heading, text, summary, level }) => {
  try {
    const page = await wiki.getPage(title);
    if (!page.exists) return fail(`"${title}" does not exist.`);
    const parsed = await wiki.parsePage(title);
    const wanted = heading.trim().toLowerCase();
    const sec = (parsed.sections || []).find((s) => decodeEntities(s.line.replace(/<[^>]+>/g, '')).trim().toLowerCase() === wanted);
    let r; let preserved = [];
    if (sec) {
      const cur = await wiki.getSection(title, sec.index);
      const lvl = Number(sec.level);
      const sub = cur.match(new RegExp(`^(={${lvl + 1},6})\\s*.+?\\s*\\1\\s*$`, 'm'));
      const tail = sub ? cur.slice(sub.index) : '';
      preserved = (parsed.sections || []).filter((s) => s.number.startsWith(sec.number + '.')).map((s) => decodeEntities(s.line.replace(/<[^>]+>/g, '')));
      const eq = '='.repeat(lvl);
      const headingText = decodeEntities(sec.line.replace(/<[^>]+>/g, ''));
      r = await wiki.edit({ title, text: `${eq} ${headingText} ${eq}\n${text.trim()}\n${tail ? '\n' + tail : ''}`, summary, mode: 'update', section: sec.index, baseTimestamp: page.lastmod });
    } else {
      const eq = '='.repeat(level);
      r = await wiki.edit({ title, text: `\n${eq} ${heading} ${eq}\n${text.trim()}\n`, summary, mode: 'append', baseTimestamp: page.lastmod });
    }
    return json({ result: r.result, replaced: Boolean(sec), preservedSubsections: preserved, url: wiki.pageUrl(title) });
  } catch (e) { return fail(conflictMessage(e, title)); }
});

server.registerTool('wiki_create_entity', {
  title: 'Create an entity article',
  description: 'Creates (or overwrites) a structured article: the right Infobox template filled from `fields` (validated against wiki_entity_schema) followed by `body` wikitext or the standard section skeleton. Chronicles go to the Chronicle: namespace automatically. New pages default to canon=Draft.',
  inputSchema: {
    type: z.enum(ENTITY_KEYS), title: z.string().min(1),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe('Infobox field values, e.g. {"race":"Men","realm":"Gondor","parentage":"Arathorn II, Gilraen","birth_year":2931}'),
    body: z.string().optional().describe('Article body (lead paragraph + sections). If omitted, the section skeleton is used.'),
    summary: z.string().default('Created via Forge'), mode: z.enum(['create', 'overwrite']).default('create'),
  },
}, async ({ type, title, fields, body, summary, mode }) => {
  try {
    const entity = entityByKey[type];
    const merged = { canon: 'Draft', ...fields };
    const text = buildEntityWikitext(entity, merged, body);
    const fullTitle = entity.namespace && !new RegExp(`^(${entity.namespace}|Chronik):`, 'i').test(title) ? `${entity.namespace}:${title}` : title;
    const r = await wiki.edit({ title: fullTitle, text, summary, mode });
    const preview = await wiki.parsePage(fullTitle);
    return json({ result: r.result, title: fullTitle, url: wiki.pageUrl(fullTitle), wikitext: text, redLinks: (preview.links || []).filter((l) => !l.exists).map((l) => l.title) });
  } catch (e) { return fail(conflictMessage(e, title)); }
});

server.registerTool('wiki_lint_article', {
  title: 'Lint an article',
  description: 'Checks an article against the Westernis conventions: infobox present and of a known type, canon + short description set, section order, red links, categories, missing image. Returns findings and concrete fixes.',
  inputSchema: { title: z.string() },
}, async ({ title }) => {
  try {
    const p = await wiki.getPage(title);
    if (!p.exists) return json({ title, exists: false });
    const findings = [];
    const ib = parseInfobox(p.wikitext);
    let entity = null;
    if (!ib) findings.push({ level: 'error', msg: 'No {{Infobox …}} template found. Every entity article starts with one (wiki_entity_schema).' });
    else {
      entity = ib.entity ? entityByKey[ib.entity] : null;
      if (!entity) findings.push({ level: 'error', msg: `Unknown infobox "${ib.template}".` });
      else {
        if (!ib.fields.canon) findings.push({ level: 'warn', msg: 'canon field missing (Tolkien | Westernis | Draft).' });
        if (!ib.fields.short) findings.push({ level: 'warn', msg: 'short field missing (one-line description shown under the title and in search).' });
        if (!ib.fields.image) findings.push({ level: 'info', msg: 'No image set.' });
        const known = new Set(entity.fields.map((f) => f.name));
        for (const k of Object.keys(ib.fields)) if (!known.has(k)) findings.push({ level: 'warn', msg: `Field "${k}" is not part of ${entity.template}; it is ignored.` });
        const present = sectionsOf(p.wikitext).map((s) => s.title);
        const missing = entity.sections.filter((s, i) => !present.includes(s) && !present.includes((entity.sectionKeys || [])[i]));
        if (missing.length) findings.push({ level: 'info', msg: `Sections not present: ${missing.join(', ')}` });
      }
    }
    const body = stripInfobox(p.wikitext);
    const lead = body.split('\n==')[0];
    if ((lead.match(/'''/g) || []).length < 2) findings.push({ level: 'info', msg: 'Lead paragraph does not bold the subject.' });
    if (/<!--/.test(body)) findings.push({ level: 'info', msg: 'Skeleton comments are still present — unfinished sections.' });
    const parsed = await wiki.parsePage(p.title);
    const red = (parsed.links || []).filter((l) => !l.exists).map((l) => l.title);
    if (red.length) findings.push({ level: 'info', msg: `Red links: ${red.join(', ')}` });
    if (!p.categories.length) findings.push({ level: 'warn', msg: 'No categories.' });
    return json({ title: p.title, type: entity?.key || null, lastmod: p.lastmod, findings, categories: p.categories, redLinks: red });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_upload_file', {
  title: 'Upload a file',
  description: 'Uploads a local image/PDF/audio file from the project folder (or FORGE_UPLOAD_DIRS) to the wiki as File:<filename>.',
  inputSchema: { path: z.string(), filename: z.string().optional(), description: z.string().default(''), summary: z.string().default('Uploaded via Forge') },
}, async ({ path: filePath, filename, description, summary }) => {
  try {
    const abs = path.resolve(filePath);
    const inside = uploadRoots.some((r) => { const rel = path.relative(r, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
    if (!inside) return fail(`Refusing to upload from outside allowed folders: ${uploadRoots.join(', ')}`);
    if (!fs.existsSync(abs)) return fail(`File not found: ${abs}`);
    const r = await wiki.upload({ filePath: abs, filename: filename || path.basename(abs), text: description, comment: summary });
    return json({ result: r.result, filename: r.filename, url: r.imageinfo?.descriptionurl, warnings: r.warnings });
  } catch (e) { return fail(e.message); }
});

server.registerTool('wiki_purge', {
  title: 'Purge page cache',
  description: 'Re-render pages (after template or data changes) and refresh their links.',
  inputSchema: { titles: z.array(z.string()).min(1).max(50) },
}, async ({ titles }) => {
  try { return json(await wiki.purge(titles)); } catch (e) { return fail(e.message); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
