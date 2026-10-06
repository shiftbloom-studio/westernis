---
name: lore-sweep
description: Grow and audit the Westernis wiki in batches — groom the red-link backlog, write sets of related stub or full articles, cross-check dates, names and relationships across pages, using the westernis-forge MCP tools.
---

# Lore sweep

Use this for "fill in the gaps", "what should we write next", "check consistency", or
"flesh out the Second Age" style requests.

## 1. Survey
- `wiki_site_info` for size; `wiki_wanted_pages` (kind=wanted) for the red-link backlog,
  plus kind=lonely and kind=deadend for orphans; `wiki_recent_changes` for what the user
  touched last.
- Group wanted titles by theme (same era, realm, family, war). Prefer titles wanted by many
  pages and titles that unlock structure (eras, realms, peoples) before leaves.

## 2. Propose, then act
- Present a short plan: 5–15 titles, type for each, one line on what the page will say and
  which existing pages it must agree with. If the user already asked for a batch, proceed.
- For every page follow the `wiki-article` procedure (context → schema → draft → links →
  preview → save as `canon=Draft`), including its language rules (German prose and German
  section titles; English field names and stored values). Keep new pages consistent with each other: shared dates,
  spellings, parentage, allegiances.
- Fill both directions of a relationship: a child page lists its parents, the parent page's
  `children` field lists the child; a battle lists its war in `part_of`, the war lists the
  battle under its timeline.

## 3. Audit
- `wiki_lint_article` on every page touched; fix missing `short`, `canon`, unknown fields.
- Cross-check with `wiki_cargo_query`: e.g. characters whose `birth_era` is not an Era page,
  locations whose `realm` is not a Location, events without an era. Report mismatches and fix
  the obvious ones.
- Never silently change `canon=Tolkien` pages; propose changes instead.

## 4. Report
List created/updated pages with URLs, remaining red links, and open questions for the author
(contradictions found, facts you had to invent).
