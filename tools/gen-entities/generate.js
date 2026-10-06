#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Generates infobox templates, Page Forms forms, categories, article skeletons, the create page,
// the value-label Lua table and the MCP schema file from tools/gen-entities/entities.js.
// Reader-facing text is German and comes from tools/gen-entities/de.js; identifiers stay English.
//   node tools/gen-entities/generate.js
'use strict';
const fs = require('fs');
const path = require('path');
const entities = require('./entities.js');
const de = require('./de.js');

const root = path.resolve(__dirname, '..', '..');
const pagesDir = path.join(root, 'content', 'pages');
const out = (ns, title, body, ext = 'wiki') => {
  const dir = path.join(pagesDir, ns);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, title.replace(/\//g, '__').replace(/ /g, '_') + '.' + ext);
  fs.writeFileSync(file, body.replace(/\r\n/g, '\n'), 'utf8');
  return path.relative(root, file);
};

const cargoType = (t) => (t === 'List of Page' ? 'List (,) of Page' : t === 'List of String' ? 'List (,) of String' : t);
const isList = (f) => f.type.startsWith('List');
const isPage = (f) => f.type === 'Page';
const plural = (e) => e.category;

// ---------------------------------------------------------------------------
// German display layer — fail loudly on anything untranslated
// ---------------------------------------------------------------------------
const need = (v, what) => { if (v === undefined) throw new Error(`missing German text for ${what}`); return v; };
const D = (e) => need(de.entities[e.key], `entity ${e.key}`);
const T = (f, e) => de.overrides[`${e.key}.${f.name}`] ?? need(de.labels[f.label], `label "${f.label}" (${e.key}.${f.name})`);
const H = (h) => need(de.headers[h], `header "${h}"`);
const S = (s) => need(de.sections[s], `section "${s}"`);
const V = (v) => need(de.values[v], `value "${v}"`);

// Auto-categorisation rules: field -> category pattern (%s = value, %P = German plural of a dropdown value)
const CATEGORY_RULES = {
  character: [['race', '%s'], ['realm', 'Gestalten aus %s'], ['house', 'Angehörige von %s']],
  location: [['type', '%P'], ['realm', 'Orte in %s'], ['parent', 'Orte in %s']],
  faction: [['type', '%P'], ['realm', 'Bünde in %s']],
  people: [['parent', '%s']],
  creature: [['type', '%P']],
  artifact: [['type', '%P']],
  event: [['type', '%P'], ['era', 'Begebenheiten im Zeitalter %s']],
  era: [],
  language: [['family', 'Sprachfamilie %s']],
  power: [['pantheon', '%s']],
  chronicle: [['status', '%P'], ['era', 'Chroniken im Zeitalter %s']],
};
const STATUS_PLURALS = { idea: 'Chroniken (Einfall)', draft: 'Chroniken (Entwurf)', revised: 'Chroniken (überarbeitet)', final: 'Chroniken (vollendet)' };
const pluralOf = (e, v) => (e.key === 'chronicle' ? STATUS_PLURALS[v] : de.plurals[v]);

function fieldsOf(e) {
  const head = HEAD(e);
  const groups = e.groups.flatMap((g) => g.fields);
  return [...head, ...groups, ...e.extra, ...TAIL];
}

// Fields shared by every entity type (name/image/caption/other names first; description/canon/accent last).
const HEAD = (e) => [
  { name: e.key === 'chronicle' ? 'title' : 'name', type: 'String', label: e.key === 'chronicle' ? 'Title' : 'Name', desc: 'Display name (defaults to the page name)', widget: 'text', placeholder: 'Anzeigename (sonst der Seitenname)' },
  ...(e.key === 'chronicle' ? [] : [{ name: 'script', type: 'String', label: 'Tengwar', desc: 'Name in Tengwar or another script (rendered with the Tengwar font)', placeholder: 'Tengwar-Text (in Tengwar-Schrift dargestellt)', widget: 'text', format: 'tengwar' }]),
  { name: 'image', type: 'File', label: 'Image', desc: 'Main image (file name without the File: prefix)', widget: 'image' },
  { name: 'caption', type: 'String', label: 'Caption', desc: 'Image caption', widget: 'text', placeholder: 'Bildunterschrift' },
  ...(e.key === 'chronicle' ? [] : [{ name: 'othernames', type: 'List of String', label: 'Other names', desc: 'Comma-separated alternative names', widget: 'tokens' }]),
];
const TAIL = [
  { name: 'short', type: 'String', label: 'Short description', desc: 'One line shown under the title and in search results', widget: 'text', meta: true, placeholder: 'Eine Zeile unter dem Titel und in Suchergebnissen' },
  { name: 'canon', type: 'String', label: 'Canon', desc: 'Tolkien = canonical legendarium · Westernis = your own canon · Draft = unreviewed or AI-generated', widget: 'radio', values: ['Tolkien', 'Westernis', 'Draft'], default: 'Westernis', meta: true },
  { name: 'accent', type: 'String', label: 'Accent colour', desc: 'Optional hex colour that overrides the type accent (e.g. #7a1f2b)', placeholder: '#7a1f2b (optionale Hex-Farbe)', widget: 'text', meta: true },
];

// ---------------------------------------------------------------------------
// Template:Infobox <type>  (public template: Cargo + categories + TemplateData, delegates rendering to /core)
// ---------------------------------------------------------------------------
function infoboxTemplate(e) {
  const fields = fieldsOf(e);
  const nameField = fields[0].name;
  const cargoFields = fields.filter((f) => !f.meta || f.name === 'canon').map((f) => `|${f.name}=${cargoType(f.type)}`).join('');
  const storeFields = fields.filter((f) => !f.meta || f.name === 'canon').map((f) =>
    f.name === nameField ? `|${f.name}={{{${f.name}|{{PAGENAME}}}}}`
      : f.name === 'canon' ? `|canon={{{canon|Westernis}}}`
      : `|${f.name}={{{${f.name}|}}}`).join('');

  // Display values handed to the /core template (meta fields canon/accent are passed explicitly below)
  const coreArgs = [];
  for (const f of fields.filter((x) => !x.meta)) {
    if (f.date) {
      coreArgs.push(`|${f.name}={{#invoke:Westernis|date|{{{${f.name}|}}}|{{{${f.date[0]}|}}}|{{{${f.date[1]}|}}}}}`);
    } else if (isList(f) && f.type === 'List of Page') {
      coreArgs.push(`|${f.name}={{#invoke:Westernis|list|{{{${f.name}|}}}}}`);
    } else if (isPage(f)) {
      coreArgs.push(`|${f.name}={{#if:{{{${f.name}|}}}|[[{{{${f.name}}}}]]}}`);
    } else if (f.name === 'image') {
      coreArgs.push(`|image={{{image|}}}`);
    } else if (f.values) {
      coreArgs.push(`|${f.name}={{#invoke:Westernis|label|{{{${f.name}|}}}}}`);   // stored English, shown German
    } else {
      coreArgs.push(`|${f.name}={{{${f.name}|}}}`);
    }
  }
  if (e.key === 'event') {
    coreArgs.push(`|years={{#invoke:Westernis|years|{{{year_start|}}}|{{{year_end|}}}|{{{era|}}}}}`);
  }
  if (e.key === 'era') {
    coreArgs.push(`|span={{#if:{{{year_start|}}}|{{{year_start}}}{{#if:{{{year_end|}}}|&#8239;–&#8239;{{{year_end}}}}}}}`);
  }
  if (e.key === 'chronicle') {
    coreArgs.push(`|years={{#invoke:Westernis|years|{{{year_start|}}}|{{{year_end|}}}|{{{era|}}}}}`);
  }

  const cats = [`[[Category:${plural(e)}]]`];
  for (const [field, pattern] of CATEGORY_RULES[e.key] || []) {
    if (pattern === '%P') {
      const f = fields.find((x) => x.name === field);
      const cases = f.values.filter((v) => pluralOf(e, v)).map((v) => `|${v}=[[Category:${pluralOf(e, v)}]]`).join('');
      cats.push(`{{#switch:{{{${field}|}}}${cases}|#default=}}`);
    } else {
      cats.push(`{{#if:{{{${field}|}}}|[[Category:${pattern.replace('%s', `{{{${field}}}}`)}]]}}`);
    }
  }
  cats.push(`{{#switch:{{{canon|Westernis}}}|Tolkien=[[Category:Tolkien canon]]|Draft=[[Category:Draft articles]]|#default=[[Category:Westernis canon]]}}`);
  cats.push(`{{#if:{{{image|}}}||[[Category:Articles without an image]]}}`);

  const templateData = {
    description: { en: e.description, de: D(e).description },
    format: '{{_\n| ___ = _\n}}',
    params: Object.fromEntries(fields.map((f) => [f.name, {
      label: { en: f.label, de: T(f, e) },
      description: f.desc,
      type: f.widget === 'image' ? 'wiki-file-name' : isPage(f) ? 'wiki-page-name' : f.type === 'Integer' || f.type === 'Float' ? 'number' : f.type === 'Text' ? 'content' : 'string',
      ...(f.values ? { suggestedvalues: f.values } : {}),
      ...(f.default ? { default: f.default } : {}),
      suggested: !f.hidden && !f.meta,
    }])),
    paramOrder: fields.map((f) => f.name),
  };

  return `<noinclude>
{{#cargo_declare:_table=${e.table}${cargoFields}}}
'''${e.template}''' — ${D(e).description}

Neue Seiten entstehen mit [[Form:${e.form}]] (oder über [[Westernis:Create]]). Die Felder landen in der Cargo-Tabelle [[Special:CargoTables/${e.table}|${e.table}]]. Die Darstellung steckt in [[Template:${e.template}/core]], das Aussehen in [[MediaWiki:Common.css]] (<code>.pi-theme-${e.key}</code>).

<templatedata>
${JSON.stringify(templateData, null, 1)}
</templatedata>
[[Category:Infobox templates]]
</noinclude><includeonly>{{#cargo_store:_table=${e.table}${storeFields}}}<!--
-->{{#if:{{{short|}}}|{{SHORTDESC:{{{short}}}}}}}<!--${e.namespace ? `\n-->{{DISPLAYTITLE:{{{${fields[0].name}|{{PAGENAME}}}}}}}<!--` : ''}
-->{{${e.template}/core
${coreArgs.join('\n')}
|canon={{{canon|Westernis}}}
|accent={{{accent|}}}
|pagename={{PAGENAME}}
}}<!--
-->${cats.join('')}</includeonly>
`;
}

// ---------------------------------------------------------------------------
// Template:Infobox <type>/core  (PortableInfobox markup only)
// ---------------------------------------------------------------------------
function coreTemplate(e) {
  const fields = fieldsOf(e);
  const nameField = fields[0].name;
  const visible = (fs) => fs.filter((f) => !f.hidden && !f.meta && !['image', 'caption', 'script', nameField, 'othernames'].includes(f.name));
  const rows = (fs, header) => {
    const list = visible(fs);
    return list.map((f) => {
      // a lone row that merely repeats its group header loses the label and spans the plate
      const label = list.length === 1 && header && T(f, e).replace(/\u00AD/g, '') === header ? '' : `<label>${T(f, e)}</label>`;
      if (f.format === 'tengwar') return `    <data source="${f.name}">${label}<format><span class="wst-tengwar">{{{${f.name}}}}</span></format></data>`;
      if (f.type === 'Text') return `    <data source="${f.name}">${label}<format><div class="wst-pi-long">{{{${f.name}}}}</div></format></data>`;
      return `    <data source="${f.name}">${label}</data>`;
    }).join('\n');
  };

  const groups = e.groups.map((g) => `  <group${g.collapse ? ` collapse="${g.collapse}"` : ''}>
    <header>${H(g.header)}</header>
${rows(g.fields, H(g.header))}
  </group>`).join('\n');

  const extraRows = rows(e.extra, H('Notes'));
  const special = e.key === 'event' ? `    <data source="years"><label>${de.labels.Years}</label></data>\n`
    : e.key === 'era' ? `    <data source="span"><label>${de.labels.Years}</label></data>\n`
    : e.key === 'chronicle' ? `    <data source="years"><label>${de.labels['Set in']}</label></data>\n` : '';

  return `<noinclude>
Darstellungsvorlage für [[Template:${e.template}]]. Nicht direkt verwenden.
[[Category:Infobox templates]]
</noinclude><includeonly><infobox theme="${e.key}" accent-color-source="accent">
  <title source="${nameField}"><default>{{{pagename}}}</default></title>
  <data source="script"><format><div class="wst-tengwar wst-tengwar-title">{{{script}}}</div></format></data>
  <image source="image"><caption source="caption"/></image>
  <data source="othernames"><label>${de.labels['Other names']}</label></data>
${special}${groups}
${extraRows ? `  <group>\n    <header>${H('Notes')}</header>\n${extraRows}\n  </group>\n` : ''}  <navigation><span class="wst-pi-nav">{{#invoke:Westernis|canon|{{{canon|}}}}} <span class="wst-pi-type">${D(e).singular}</span> <span class="wst-pi-edit">[[Special:FormEdit/${e.form}/{{FULLPAGENAME}}|${de.ui.edit}]]</span></span></navigation>
</infobox></includeonly>
`;
}

// ---------------------------------------------------------------------------
// Form:<Type>
// ---------------------------------------------------------------------------
function formInput(f) {
  const from = f.from ? `|values from category=${f.from}` : '';
  const ph = (f.placeholder || '').replace(/\|/g, '/').slice(0, 80);
  switch (f.widget) {
    case 'textarea': return `{{{field|${f.name}|input type=textarea|rows=3|autogrow}}}`;
    case 'tokens': return `{{{field|${f.name}|input type=tokens${from}|delimiter=,|placeholder=${de.ui.commaSeparated}}}}`;
    case 'combobox': return `{{{field|${f.name}|input type=combobox${from}}}}`;
    case 'dropdown': return `{{{field|${f.name}|input type=dropdown|values=${f.values.join(',')}|mapping template=Wst label}}}`;
    case 'radio': return `{{{field|${f.name}|input type=radiobutton|values=${f.values.join(',')}|mapping template=Wst label|default=${f.default || ''}}}}`;
    case 'image': return `{{{field|${f.name}|input type=text|uploadable|placeholder=${de.ui.exampleImage}}}}`;
    default: return `{{{field|${f.name}|input type=text${ph ? `|placeholder=${ph}` : ''}}}}`;
  }
}

function formPage(e) {
  const fields = fieldsOf(e);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  const rendered = new Set();
  const row = (f) => {
    if (rendered.has(f.name)) return '';
    rendered.add(f.name);
    if (f.date) {
      const [y, era] = f.date.map((n) => byName[n]);
      rendered.add(y.name); rendered.add(era.name);
      return `! ${T(f, e)}:\n| ${formInput(f)} <span class="wst-form-inline">${de.ui.year} {{{field|${y.name}|input type=text|size=6}}} ${de.ui.era} {{{field|${era.name}|input type=combobox|values from category=Eras}}}</span>\n|-\n`;
    }
    return `! ${T(f, e)}:\n| ${formInput(f)}\n|-\n`;
  };
  const section = (title, fs) => {
    const body = fs.map(row).filter(Boolean).join('');
    return body ? `{| class="formtable wst-formtable"\n|+ ${title}\n|-\n${body}|}\n` : '';
  };
  const parts = [section(H('Identity'), HEAD(e))];
  for (const g of e.groups) parts.push(section(H(g.header), g.fields));
  if (e.extra.length) parts.push(section(H('Details'), e.extra));
  parts.push(section(H('Article metadata'), TAIL));

  const nsOpt = e.namespace ? `|namespace=${e.namespace}` : '';
  const d = D(e);
  return `<noinclude>
${de.ui.formIntro(d)}

{{#forminput:form=${e.form}|autocomplete on category=${e.category}${nsOpt}|placeholder=${d.placeholder}|button text=${de.ui.createEdit}|no autofocus}}

[[Category:Forms]]
</noinclude><includeonly>
<div class="wst-form wst-form-${e.key}">
{{{info|page name=<${e.template}[${fields[0].name}]>|create title=${d.create}|edit title=${d.edit}}}}
{{{for template|${e.template}|label=${d.singular}}}}
${parts.join('')}{{{end template}}}

<div class="wst-form-text">'''${de.ui.articleText}''' <small>${de.ui.articleTextHint}</small></div>
{{{standard input|free text|rows=28|editor=wikieditor|preload=Template:Skeleton/${e.singular}}}}

{{{standard input|summary}}}

{{{standard input|minor edit}}} {{{standard input|watch}}}

{{{standard input|save}}} {{{standard input|preview}}} {{{standard input|changes}}} {{{standard input|cancel}}}
</div>
</includeonly>
`;
}

// ---------------------------------------------------------------------------
// Template:Skeleton/<Type>  (preloaded article body; headings German, special blocks keyed by the English name)
// ---------------------------------------------------------------------------
function skeleton(e) {
  const sections = e.sections.map((s) => {
    const t = S(s);
    switch (s) {
      case 'Gallery': return `== ${t} ==\n<gallery mode="packed-hover">\n</gallery>`;
      case 'Notes': return `== ${t} ==\n<references />`;
      case 'Appearances': return `== ${t} ==\n{{Appearances}}`;
      case 'Genealogy': return `== ${t} ==\n{{Family tree}}`;
      case 'Relationships': return `== ${t} ==\n{{Relationships}}`;
      case 'Timeline': return `== ${t} ==\n{{Timeline|era={{PAGENAME}}}}`;
      case 'Text': return `== ${t} ==\n${de.ui.textComment}`;
      default: return `== ${t} ==\n${de.ui.sectionComment(t)}`;
    }
  }).join('\n\n');
  return `<noinclude>
${de.ui.skeletonIntro(D(e), e.form)}
[[Category:Skeleton templates]]
</noinclude>${need(de.leadHints[e.key], `lead hint ${e.key}`)}

${sections}
`;
}

// ---------------------------------------------------------------------------
// Category:<Plural>  (root category: German display title, banner with create box)
// ---------------------------------------------------------------------------
function categoryPage(e) {
  const d = D(e);
  return `{{#default_form:${e.form}}}{{DISPLAYTITLE:${d.plural}}}
{{Category header|type=${e.key}|title=${d.plural}|singular=${d.singular}|placeholder=${d.newItem}|form=${e.form}|table=${e.table}${e.namespace ? `|namespace=${e.namespace}` : ''}|description=${d.description}}}
[[Category:Westernis|${d.plural}]]
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const written = [];
const schemas = [];
const subcats = new Map();
for (const e of entities) {
  written.push(out('Template', e.template, infoboxTemplate(e)));
  written.push(out('Template', `${e.template}/core`, coreTemplate(e)));
  written.push(out('Form', e.form, formPage(e)));
  written.push(out('Template', `Skeleton/${e.singular}`, skeleton(e)));
  written.push(out('Category', e.category, categoryPage(e)));
  for (const [field, pattern] of CATEGORY_RULES[e.key] || []) {
    if (pattern !== '%P') continue;
    const f = fieldsOf(e).find((x) => x.name === field);
    for (const v of f.values) if (pluralOf(e, v)) subcats.set(pluralOf(e, v), { e, v });
  }
  schemas.push({
    key: e.key, singular: e.singular, plural: e.category, template: e.template, form: e.form, table: e.table,
    category: e.category, namespace: e.namespace || '', accent: e.accent, icon: e.icon, description: e.description,
    labelDe: { singular: D(e).singular, plural: D(e).plural, description: D(e).description },
    fields: fieldsOf(e).map((f) => ({
      name: f.name, type: f.type, label: f.label, labelDe: T(f, e), description: f.desc,
      ...(f.values ? { values: f.values, valueLabelsDe: Object.fromEntries(f.values.map((v) => [v, V(v)])) } : {}),
      ...(f.from ? { linksTo: f.from } : {}), ...(f.date ? { dateParts: f.date } : {}),
    })),
    // German headings as they appear in articles; sectionKeys keeps the English key of each
    sections: e.sections.map(S), sectionKeys: e.sections, leadHint: de.leadHints[e.key],
  });
}
// the type-driven sub-categories (Reiche, Schlachten, Vögel …) get real pages, so no red category links
for (const [name, { e, v }] of subcats) {
  written.push(out('Category', name, `{{DISPLAYTITLE:${name}}}{{Category header|type=${e.key}|kicker=${D(e).plural}|title=${name}|description=Alle Einträge der Art „${V(v)}“.|form=${e.form}|table=${e.table}${e.namespace ? `|namespace=${e.namespace}` : ''}|placeholder=${D(e).newItem}}}\n[[Category:${e.category}|${name}]]\n`));
}
const schemaFile = path.join(root, 'tools', 'forge-mcp', 'schemas.json');
fs.mkdirSync(path.dirname(schemaFile), { recursive: true });
fs.writeFileSync(schemaFile, JSON.stringify({ generatedFrom: 'tools/gen-entities/entities.js', language: 'de', entities: schemas }, null, 2) + '\n');
written.push(path.relative(root, schemaFile));

// Module:Westernis/labels — stored value -> German display label (used by {{#invoke:Westernis|label|…}})
const labelLua = `-- Generated by tools/gen-entities/generate.js from de.js — do not edit by hand.
return {
${Object.entries(de.values).map(([k, v]) => `\t[ ${JSON.stringify(k)} ] = ${JSON.stringify(v)},`).join('\n')}
}
`;
written.push(out('Module', 'Westernis/labels', labelLua, 'lua'));

// Westernis:Create — one card per type, each with its own form input
const createPage = `{{SHORTDESC:Einen neuen Eintrag mit einem Formular beginnen}}{{DISPLAYTITLE:Einen Eintrag beginnen}}__NOTOC__ __NOEDITSECTION__
<div class="wst-create">
${entities.map((e) => `<div class="wst-create-card wst-accent-${e.key}"><div class="wst-create-head"><span class="wst-seal"><span class="wst-icon wst-icon-${e.key}"></span></span><span class="wst-create-title">${D(e).singular}</span></div><div class="wst-create-desc">${D(e).description}</div>
{{#forminput:form=${e.form}|autocomplete on category=${e.category}${e.namespace ? `|namespace=${e.namespace}` : ''}|placeholder=${D(e).placeholder}|button text=${de.ui.create}|no autofocus}}</div>`).join('\n')}
</div>

== Ohne Formular ==
Gib einen Titel ins Suchfeld ein, öffne den roten Link und beginne mit <code>{{tl|Infobox character}}</code> (oder einer anderen Infobox). Jede Vorlage führt ihre Parameter in der Dokumentation auf.
`;
written.push(out('Project', 'Create', createPage));

console.log(written.map((w) => '  ' + w).join('\n'));
console.log(`\n${entities.length} entity types -> ${written.length} files`);
