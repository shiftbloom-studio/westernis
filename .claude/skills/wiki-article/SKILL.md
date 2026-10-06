---
name: wiki-article
description: Create or extend one Westernis wiki article (character, location, faction, people, creature, artifact, event, era, language, power, chronicle) consistently with existing lore, using the westernis-forge MCP tools.
---

# Write or extend a Westernis article

You are the loremaster's scribe. The wiki is the source of truth; invention is welcome only
where the wiki is silent, and it must be marked as such.

## Procedure
1. **Understand the request**: which page, which entity type (`wiki_entity_schema` lists them),
   create vs. extend, and whether the subject is Tolkien canon, Westernis canon or a draft.
2. **Gather context** with `wiki_lore_context` for the subject and for every major name in the
   request (parents, realm, era, faction). Read the related pages' infobox fields and leads.
   Note dates, names, spellings and relationships already recorded — reuse them verbatim.
3. **Check the schema**: `wiki_entity_schema` for the field names, allowed values, date
   fields (`birth` + `birth_year` + `birth_era`) and the section order.
4. **Draft** the article:
   - Infobox fields from the schema only; comma-separated lists for list fields; plain titles
     (no `[[ ]]`) in Page fields; years as numbers plus an era page name.
   - Lead: 1–3 paragraphs, subject in `'''bold'''`, in-universe past tense.
   - Sections in the schema order; skip empty ones; keep `{{Family tree}}`, `{{Relationships}}`,
     `{{Appearances}}` where the skeleton has them.
   - `short` = one line for the tagline; `canon` = `Draft` unless the user said otherwise.
5. **Link**: run `wiki_suggest_links` on the body; accept links to existing pages; keep a few
   deliberate red links for things that deserve their own page; never link common words.
6. **Preview** with `wiki_preview` (or save then `wiki_lint_article`); fix warnings and
   unknown fields.
7. **Save** with `wiki_create_entity` (new) or `wiki_edit_section` / `wiki_save_page`
   (extend). Summary says what changed and why.
8. **Report**: the page URL, what you added, which facts came from existing pages, which are
   new inventions (flag them), and red links worth writing next.

## Language
- The wiki defaults to **German**. Write new prose in German (established German Tolkien terms:
  Mittelerde, Elben, Zwerge, Bruchtal, Nebelgebirge, Drittes Zeitalter …) unless the user asks
  otherwise or you are extending an existing English page.
- Section headings: use the German titles from `wiki_entity_schema` (`sections`, e.g. Geschichte,
  Stammbaum, Anmerkungen); `sectionKeys` gives the English key of each.
- Infobox field **names** and stored dropdown **values** stay English (`type = Battle`,
  `canon = Draft`); the templates show them in German. Page fields hold page titles as they exist.

## Style
- Follow `Westernis:Manual of Style`: sentence-case headings, plural peoples, italics for
  foreign words, numerals for disambiguation (Arathorn II), no leading "the" in titles.
- Dates: give `*_year` and `*_era`; the templates render "D.Z. 2931" (the era page’s own prefix).
- Quotes with `{{Quote|text|speaker|work}}`; hidden twists with `{{Secret|title=|text=}}`;
  an illuminated initial with `{{Drop cap|T}}` in chronicles.
- Do not paste long passages from published books; summarise in your own words.
