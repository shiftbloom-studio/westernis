// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// German display layer for the entity generator. Identifiers (template, form, table, field,
// category and stored dropdown values) stay English in entities.js; everything a reader sees
// is taken from here. generate.js fails loudly when a label has no translation.
'use strict';

const entities = {
  character: { singular: 'Gestalt', plural: 'Gestalten', placeholder: 'Name der Gestalt', create: 'Eine Gestalt anlegen', edit: 'Gestalt bearbeiten', newItem: 'Neue Gestalt …',
    description: 'Eine Person aus Westernis oder Mittelerde: Könige, Wanderer, Gelehrte, Widersacher.' },
  location: { singular: 'Ort', plural: 'Orte', placeholder: 'Name des Ortes', create: 'Einen Ort anlegen', edit: 'Ort bearbeiten', newItem: 'Neuer Ort …',
    description: 'Ein Ort: Reich, Landstrich, Siedlung, Festung, Wahrzeichen, Fluss, Wald, Meer.' },
  faction: { singular: 'Bund', plural: 'Bünde', placeholder: 'Name des Bundes', create: 'Einen Bund anlegen', edit: 'Bund bearbeiten', newItem: 'Neuer Bund …',
    description: 'Ein Haus, Orden, Königreich, eine Gilde, Gemeinschaft oder ein anderer Bund.' },
  people: { singular: 'Volk', plural: 'Völker', placeholder: 'Name des Volkes', create: 'Ein Volk anlegen', edit: 'Volk bearbeiten', newItem: 'Neues Volk …',
    description: 'Ein Volk: Elben, Menschen, Zwerge, Hobbits und die Sippen in ihnen.' },
  creature: { singular: 'Geschöpf', plural: 'Geschöpfe', placeholder: 'Name des Geschöpfs', create: 'Ein Geschöpf anlegen', edit: 'Geschöpf bearbeiten', newItem: 'Neues Geschöpf …',
    description: 'Tiere, Ungeheuer und andere Geschöpfe: Drachen, Adler, Warge, Geister.' },
  artifact: { singular: 'Artefakt', plural: 'Artefakte', placeholder: 'Name des Artefakts', create: 'Ein Artefakt anlegen', edit: 'Artefakt bearbeiten', newItem: 'Neues Artefakt …',
    description: 'Waffen, Ringe, Reliquien, Juwelen, Gefäße, Schriften und andere Dinge von Rang.' },
  event: { singular: 'Begebenheit', plural: 'Begebenheiten', placeholder: 'Name der Begebenheit', create: 'Eine Begebenheit anlegen', edit: 'Begebenheit bearbeiten', newItem: 'Neue Begebenheit …',
    description: 'Schlachten, Ratsversammlungen, Gründungen, Eide, Fahrten, Unheil und Feste.' },
  era: { singular: 'Zeitalter', plural: 'Zeitalter', placeholder: 'Name des Zeitalters', create: 'Ein Zeitalter anlegen', edit: 'Zeitalter bearbeiten', newItem: 'Neues Zeitalter …',
    description: 'Ein Zeitalter der Welt, das den Jahren ihren Rahmen gibt (mit Kürzel wie D.Z.).' },
  language: { singular: 'Sprache', plural: 'Sprachen', placeholder: 'Name der Sprache', create: 'Eine Sprache anlegen', edit: 'Sprache bearbeiten', newItem: 'Neue Sprache …',
    description: 'Eine Sprache oder Schrift der Welt.' },
  power: { singular: 'Macht', plural: 'Mächte', placeholder: 'Name der Macht', create: 'Eine Macht anlegen', edit: 'Macht bearbeiten', newItem: 'Neue Macht …',
    description: 'Valar, Maiar, Götter, Geister und andere Mächte der Welt.' },
  chronicle: { singular: 'Chronik', plural: 'Chroniken', placeholder: 'Titel der Chronik', create: 'Eine Chronik beginnen', edit: 'Chronik bearbeiten', newItem: 'Neue Chronik …',
    description: 'Eigene Geschichten und Erzählungen aus Westernis (im Namensraum Chronicle).' },
};

// field labels (English label -> German), entity-specific overrides win
const labels = {
  'Name': 'Name', 'Title': 'Titel', 'Tengwar': 'Tengwar', 'Image': 'Bild', 'Caption': 'Bildunterschrift', 'Other names': 'Weitere Namen',
  'Short description': 'Kurzbeschreibung', 'Canon': 'Kanon', 'Accent colour': 'Akzentfarbe',
  'Titles': 'Titel', 'Race': 'Volk', 'Culture': 'Kultur', 'Gender': 'Geschlecht', 'House': 'Haus', 'Affiliation': 'Bündnisse',
  'Position': 'Stellung', 'Realm': 'Reich', 'Location': 'Aufenthalt', 'Birth': 'Geburt', 'Birth year': 'Geburtsjahr', 'Birth era': 'Zeitalter der Geburt',
  'Birthplace': 'Geburtsort', 'Death': 'Tod', 'Death year': 'Todesjahr', 'Death era': 'Zeitalter des Todes', 'Place of death': 'Sterbeort',
  'Age': 'Alter', 'Rule': 'Herrschaft', 'Parentage': 'Eltern', 'Siblings': 'Geschwister', 'Spouse': 'Gemahl(in)', 'Children': 'Kinder',
  'Height': 'Größe', 'Hair': 'Haar', 'Eyes': 'Augen', 'Clothing': 'Gewandung', 'Weapons': 'Waffen', 'Steed': 'Ross', 'Languages': 'Sprachen',
  'Notable for': 'Bedeutung',
  'Type': 'Art', 'Part of': 'Teil von', 'Regions': 'Landstriche', 'Settlements': 'Siedlungen', 'Capital': 'Hauptstadt', 'Population': 'Bevölkerung',
  'Inhabitants': 'Bewohner', 'Ruler': 'Herrscher', 'Factions': 'Bünde', 'Founded': 'Gegründet', 'Founded year': 'Gründungsjahr', 'Founded era': 'Zeitalter der Gründung',
  'Destroyed': 'Zerstört', 'Destroyed year': 'Jahr der Zerstörung', 'Destroyed era': 'Zeitalter der Zerstörung', 'Events': 'Begebenheiten',
  'Map': 'Karte', 'Map X': 'Karte X', 'Map Y': 'Karte Y', 'Description': 'Beschreibung',
  'Founder': 'Gründer', 'Leader': 'Anführer', 'Seat': 'Sitz', 'Disbanded': 'Aufgelöst', 'Notable members': 'Namhafte Mitglieder', 'Peoples': 'Völker',
  'Allies': 'Verbündete', 'Rivals': 'Widersacher', 'Heirlooms': 'Erbstücke', 'Language': 'Sprache', 'Colours': 'Farben', 'Motto': 'Wahlspruch',
  'Preceded by': 'Vorgänger', 'Followed by': 'Nachfolger', 'Purpose': 'Zweck',
  'Origin': 'Ursprung', 'Homelands': 'Heimatlande', 'Subgroups': 'Stämme', 'Lifespan': 'Lebensspanne', 'Enemies': 'Feinde', 'Skin': 'Haut', 'Distinctions': 'Eigenheiten',
  'Habitat': 'Lebensraum', 'Alignment': 'Gesinnung', 'Size': 'Größe', 'First appeared': 'Erstmals bezeugt', 'Notable individuals': 'Namhafte Vertreter', 'Abilities': 'Fähigkeiten',
  'Appearance': 'Aussehen', 'Powers': 'Kräfte', 'Creator': 'Schöpfer', 'Created': 'Geschaffen', 'Created year': 'Jahr der Erschaffung', 'Created era': 'Zeitalter der Erschaffung',
  'Made in': 'Geschaffen in', 'Owners': 'Träger', 'Destroyed by': 'Zerstört von', 'Destroyed at': 'Zerstört in',
  'Date': 'Datum', 'Year': 'Jahr', 'End year': 'Endjahr', 'Era': 'Zeitalter', 'Participants': 'Beteiligte', 'Result': 'Ausgang',
  'Side 1': 'Erste Partei', 'Side 2': 'Zweite Partei', 'Commanders 1': 'Heerführer (erste)', 'Commanders 2': 'Heerführer (zweite)',
  'Forces 1': 'Streitmacht (erste)', 'Forces 2': 'Streitmacht (zweite)', 'Casualties 1': 'Verluste (erste)', 'Casualties 2': 'Verluste (zweite)',
  'Sequence': 'Reihenfolge', 'First year': 'Erstes Jahr', 'Last year': 'Letztes Jahr', 'Prefix': 'Kürzel', 'Defining events': 'Prägende Begebenheiten',
  'Family': 'Sprachstamm', 'Derived from': 'Abgeleitet von', 'Writing system': 'Schrift', 'Spoken by': 'Gesprochen von', 'Eras': 'Zeitalter',
  'Sample': 'Probe', 'Sample (script)': 'Probe (Schrift)', 'Meaning': 'Bedeutung',
  'Order': 'Stand', 'Domains': 'Walten', 'Rank': 'Rang', 'Allegiance': 'Treue', 'Dwelling': 'Wohnstatt', 'Symbols': 'Sinnbilder', 'Followers': 'Gefolge', 'Kin': 'Sippe',
  'Status': 'Stand', 'From year': 'Von Jahr', 'To year': 'Bis Jahr', 'Word count': 'Wortzahl', 'Point of view': 'Erzählblick', 'Characters': 'Gestalten',
  'Locations': 'Schauplätze', 'Summary': 'Abriss',
  'Years': 'Jahre', 'Set in': 'Zeit der Handlung',
};
const overrides = {
  'artifact.location': 'Verbleib',
  'event.location': 'Schauplatz',
  'creature.origin': 'Ursprung',
  'faction.race': 'Völker',
  'faction.type': 'Art',
  'language.region': 'Verbreitung',
  'power.titles': 'Titel',
};

// infobox group headers and form captions
const headers = {
  'Biographical information': 'Lebensdaten', 'Family': 'Sippe', 'Physical description': 'Erscheinung', 'Geography': 'Landeskunde',
  'People': 'Bewohner', 'History': 'Geschichte', 'Organisation': 'Aufbau', 'Members & allies': 'Mitglieder & Verbündete', 'Heraldry': 'Wappenkunde',
  'Origins': 'Ursprung', 'Relations': 'Beziehungen', 'Appearance': 'Erscheinung', 'Nature': 'Wesen', 'Notable individuals': 'Namhafte Vertreter',
  'Description': 'Beschreibung', 'Making': 'Entstehung', 'Event': 'Begebenheit', 'Participants': 'Beteiligte', 'Belligerents': 'Kriegsparteien',
  'Span': 'Zeitspanne', 'Defining events': 'Prägende Begebenheiten', 'Classification': 'Einordnung', 'Sample': 'Sprachprobe',
  'Divinity': 'Wesen und Rang', 'Chronicle': 'Chronik', 'Cast & setting': 'Gestalten & Schauplätze',
  // generator-made groups
  'Notes': 'Überblick', 'Identity': 'Name & Bild', 'Details': 'Einzelheiten', 'Article metadata': 'Angaben zum Eintrag',
};

// stored dropdown values -> display (the wiki keeps the English value)
const values = {
  Realm: 'Reich', Region: 'Landstrich', Settlement: 'Siedlung', Fortress: 'Festung', Landmark: 'Wahrzeichen', Mountain: 'Berg', River: 'Fluss',
  Forest: 'Wald', Sea: 'Meer', Island: 'Insel', Other: 'Sonstiges',
  House: 'Haus', Order: 'Orden', Kingdom: 'Königreich', Guild: 'Gilde', Fellowship: 'Gemeinschaft', Host: 'Heerschar', Council: 'Rat',
  Beast: 'Tier', Dragon: 'Drache', Spirit: 'Geist', Undead: 'Untoter', Construct: 'Gebilde', Bird: 'Vogel', Plant: 'Pflanze',
  Weapon: 'Waffe', Ring: 'Ring', Jewel: 'Juwel', Relic: 'Reliquie', Vessel: 'Gefäß', Text: 'Schrift', Armour: 'Rüstung', Instrument: 'Instrument',
  Battle: 'Schlacht', War: 'Krieg', Siege: 'Belagerung', Founding: 'Gründung', Oath: 'Eid', Journey: 'Fahrt', Disaster: 'Unheil', Festival: 'Fest',
  Birth: 'Geburt', Death: 'Tod',
  idea: 'Einfall', draft: 'Entwurf', revised: 'überarbeitet', final: 'vollendet',
  Tolkien: 'Tolkien', Westernis: 'Westernis', Draft: 'Entwurf',
};
// plural category names for the type-driven auto categories (Category:<plural>)
const plurals = {
  Realm: 'Reiche', Region: 'Landstriche', Settlement: 'Siedlungen', Fortress: 'Festungen', Landmark: 'Wahrzeichen', Mountain: 'Berge', River: 'Flüsse',
  Forest: 'Wälder', Sea: 'Meere', Island: 'Inseln',
  House: 'Häuser', Order: 'Orden', Kingdom: 'Königreiche', Guild: 'Gilden', Fellowship: 'Gemeinschaften', Host: 'Heerscharen', Council: 'Räte',
  Beast: 'Tiere', Dragon: 'Drachen', Spirit: 'Geister', Undead: 'Untote', Construct: 'Gebilde', Bird: 'Vögel', Plant: 'Pflanzen',
  Weapon: 'Waffen', Ring: 'Ringe', Jewel: 'Juwelen', Relic: 'Reliquien', Vessel: 'Gefäße', Text: 'Schriften', Armour: 'Rüstungen', Instrument: 'Instrumente',
  Battle: 'Schlachten', War: 'Kriege', Siege: 'Belagerungen', Founding: 'Gründungen', Oath: 'Eide', Journey: 'Fahrten', Disaster: 'Unglücke', Festival: 'Feste',
  Birth: 'Geburten', Death: 'Tode',
};

// article skeleton sections (English key -> German heading)
const sections = {
  'History': 'Geschichte', 'Legacy': 'Vermächtnis', 'Etymology': 'Namenskunde', 'Other names': 'Weitere Namen', 'Genealogy': 'Stammbaum',
  'Relationships': 'Beziehungen', 'Appearances': 'Auftritte in den Chroniken', 'Gallery': 'Bildnisse', 'See also': 'Siehe auch', 'Notes': 'Anmerkungen',
  'Geography': 'Landeskunde', 'Inhabitants': 'Bewohner', 'Organisation': 'Aufbau', 'Members': 'Mitglieder', 'Heraldry': 'Wappenkunde',
  'Culture': 'Kultur', 'Society': 'Gesellschaft', 'Language': 'Sprache', 'Appearance': 'Erscheinung', 'Description': 'Beschreibung',
  'Notable individuals': 'Namhafte Vertreter', 'Powers': 'Kräfte', 'Background': 'Vorgeschichte', 'Course of events': 'Verlauf',
  'Aftermath': 'Nachwirkungen', 'Participants': 'Beteiligte', 'Overview': 'Überblick', 'Timeline': 'Zeittafel', 'Peoples and realms': 'Völker und Reiche',
  'Phonology and grammar': 'Lautlehre und Grammatik', 'Vocabulary': 'Wortschatz', 'Writing': 'Schrift', 'Samples': 'Sprachproben',
  'Powers and domains': 'Mächte und Walten', 'Worship and followers': 'Verehrung und Gefolgschaft', 'Synopsis': 'Abriss', 'Text': 'Die Chronik',
};

// lead hints for the skeletons
const leadHints = {
  character: "'''{{PAGENAME}}''' war … <!-- Einleitung in 1–3 Absätzen: wer, wann, warum von Bedeutung -->",
  location: "'''{{PAGENAME}}''' war ein … <!-- Einleitung: was für ein Ort, wo, warum von Bedeutung -->",
  faction: "'''{{PAGENAME}}''' war ein … <!-- Einleitung -->",
  people: "Die '''{{PAGENAME}}''' waren … <!-- Einleitung -->",
  creature: "'''{{PAGENAME}}''' waren … <!-- Einleitung -->",
  artifact: "'''{{PAGENAME}}''' war … <!-- Einleitung -->",
  event: "Die '''{{PAGENAME}}''' war … <!-- Einleitung -->",
  era: "Das '''{{PAGENAME}}''' war … <!-- Einleitung -->",
  language: "'''{{PAGENAME}}''' war die Sprache der … <!-- Einleitung -->",
  power: "'''{{PAGENAME}}''' war … <!-- Einleitung -->",
  chronicle: '<!-- Ein kurzer Abriss, danach die Geschichte selbst unter == Die Chronik == -->',
};

const ui = {
  year: 'Jahr', era: 'Zeitalter', edit: 'bearbeiten', create: 'Anlegen', createEdit: 'Anlegen / bearbeiten',
  articleText: 'Text des Eintrags', articleTextHint: '(das Gerüst ist für neue Seiten vorbefüllt; ersetze die Kommentare)',
  commaSeparated: 'durch Kommata getrennt', exampleImage: 'Beispiel.jpg',
  sectionComment: (s) => `<!-- ${s}: aus Sicht der Welt und im Präteritum schreiben. Personen, Orte und Dinge bei der ersten Erwähnung verlinken. -->`,
  textComment: '<!-- Die Chronik selbst. Für eine illuminierte Initiale {{Drop cap|Anfangsbuchstabe}} verwenden. -->',
  formIntro: (d) => `Dies ist das Formular „${d.singular}“. Gib unten einen Seitennamen ein, um einen neuen Eintrag anzulegen, oder öffne einen bestehenden, um ihn mit diesem Formular zu bearbeiten.`,
  skeletonIntro: (d, form) => `Gerüst für neue Einträge der Art „${d.singular}“, vorgeladen von [[Form:${form}]]. Frei bearbeitbar; die Reihenfolge der Abschnitte bitte im ganzen Wiki gleich halten.`,
};

module.exports = { entities, labels, overrides, headers, values, plurals, sections, leadHints, ui };
