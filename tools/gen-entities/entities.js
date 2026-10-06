// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Single source of truth for the Westernis entity types.
// `node tools/gen-entities/generate.js` turns this into:
//   content/pages/Template/Infobox_<type>.wiki   (PortableInfobox + Cargo store + TemplateData)
//   content/pages/Form/<Type>.wiki                (Page Forms form with autocomplete)
//   content/pages/Category/<Plural>.wiki          (root category with default form)
//   content/pages/Template/Skeleton__<Type>.wiki  (article skeleton preloaded into the form)
//   tools/forge-mcp/schemas.json                  (schema the Forge MCP server exposes to Claude)
//
// Field types are Cargo types. `list` fields are "List (,) of <type>" and are
// rendered as links by Module:Westernis. `widget` picks the Page Forms input.
// The fields every type shares (name, image, caption, other names / short, canon, accent)
// are added by generate.js (HEAD / TAIL) so they stay identical across types.

const E = (name, type, label, desc, extra = {}) => ({ name, type, label, desc, ...extra });
const page = (name, label, desc, from, extra = {}) => E(name, 'Page', label, desc, { widget: 'combobox', from, ...extra });
const pages = (name, label, desc, from, extra = {}) => E(name, 'List of Page', label, desc, { widget: 'tokens', from, ...extra });
const text = (name, label, desc, extra = {}) => E(name, 'Text', label, desc, { widget: 'textarea', ...extra });
const str = (name, label, desc, extra = {}) => E(name, 'String', label, desc, { widget: 'text', ...extra });
const int = (name, label, desc, extra = {}) => E(name, 'Integer', label, desc, { widget: 'text', ...extra });

module.exports = [
  {
    key: 'character', template: 'Infobox character', table: 'Characters', form: 'Character',
    category: 'Characters', singular: 'Character', icon: 'crown', accent: '#b23a48',
    description: 'A person of Westernis or Middle-earth: kings, wanderers, loremasters, villains.',
    groups: [
      { header: 'Biographical information', fields: [
        pages('titles', 'Titles', 'Titles and epithets', null, { widget: 'tokens', type: 'List of String' }),
        page('race', 'Race', 'People or race (e.g. Men, Elves, Dwarves)', 'Peoples'),
        page('culture', 'Culture', 'Culture or folk within the race (e.g. Dúnedain, Noldor)', 'Peoples'),
        str('gender', 'Gender', 'Gender'),
        page('house', 'House', 'Noble house or family', 'Factions'),
        pages('affiliation', 'Affiliation', 'Factions, orders, fellowships', 'Factions'),
        str('position', 'Position', 'Office or role (e.g. King of Gondor)'),
        page('realm', 'Realm', 'Realm most associated with', 'Locations'),
        page('location', 'Location', 'Current or last known location', 'Locations'),
        str('birth', 'Birth', 'Day/month or free text (e.g. 1 March)', { date: ['birth_year', 'birth_era'] }),
        int('birth_year', 'Birth year', 'Year number within the era', { hidden: true }),
        page('birth_era', 'Birth era', 'Era/Age of birth', 'Eras', { hidden: true }),
        page('birthplace', 'Birthplace', 'Place of birth', 'Locations'),
        str('death', 'Death', 'Day/month or free text', { date: ['death_year', 'death_era'] }),
        int('death_year', 'Death year', 'Year number within the era', { hidden: true }),
        page('death_era', 'Death era', 'Era/Age of death', 'Eras', { hidden: true }),
        page('deathplace', 'Place of death', 'Place of death', 'Locations'),
        str('age', 'Age', 'Age at death or current age'),
        str('rule', 'Rule', 'Reign or period of office'),
      ]},
      { header: 'Family', fields: [
        pages('parentage', 'Parentage', 'Parents', 'Characters'),
        pages('siblings', 'Siblings', 'Siblings', 'Characters'),
        pages('spouse', 'Spouse', 'Spouse(s)', 'Characters'),
        pages('children', 'Children', 'Children', 'Characters'),
      ]},
      { header: 'Physical description', collapse: 'closed', fields: [
        str('height', 'Height', 'Height'),
        str('hair', 'Hair', 'Hair colour'),
        str('eyes', 'Eyes', 'Eye colour'),
        str('clothing', 'Clothing', 'Typical garb'),
        pages('weapons', 'Weapons', 'Weapons and artifacts carried', 'Artifacts'),
        page('steed', 'Steed', 'Mount', 'Creatures'),
        pages('language', 'Languages', 'Languages spoken', 'Languages'),
      ]},
    ],
    extra: [ text('notablefor', 'Notable for', 'One or two sentences on why this character matters') ],
    sections: ['History', 'Legacy', 'Etymology', 'Other names', 'Genealogy', 'Relationships', 'Appearances', 'Gallery', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' was ... <!-- 1–3 paragraph lead: who, when, why they matter -->",
  },
  {
    key: 'location', template: 'Infobox location', table: 'Locations', form: 'Location',
    category: 'Locations', singular: 'Location', icon: 'tower', accent: '#2f6b4f',
    description: 'A place: realm, region, settlement, fortress, landmark, river, forest, sea.',
    groups: [
      { header: 'Geography', fields: [
        str('type', 'Type', 'Realm, Region, Settlement, Fortress, Landmark, Mountain, River, Forest, Sea, Island', { widget: 'dropdown', values: ['Realm', 'Region', 'Settlement', 'Fortress', 'Landmark', 'Mountain', 'River', 'Forest', 'Sea', 'Island', 'Other'] }),
        page('parent', 'Part of', 'Parent region or realm', 'Locations'),
        page('realm', 'Realm', 'Realm the place belongs to', 'Locations'),
        pages('regions', 'Regions', 'Sub-regions', 'Locations'),
        pages('settlements', 'Settlements', 'Notable settlements', 'Locations'),
        page('capital', 'Capital', 'Capital (for realms)', 'Locations'),
        str('population', 'Population', 'Population or inhabitants count'),
      ]},
      { header: 'People', fields: [
        pages('inhabitants', 'Inhabitants', 'Peoples living here', 'Peoples'),
        pages('language', 'Languages', 'Languages spoken', 'Languages'),
        page('ruler', 'Ruler', 'Ruler or steward', 'Characters'),
        pages('factions', 'Factions', 'Houses, orders and kingdoms based here', 'Factions'),
      ]},
      { header: 'History', fields: [
        str('founded', 'Founded', 'Founding date text', { date: ['founded_year', 'founded_era'] }),
        int('founded_year', 'Founded year', 'Year within the era', { hidden: true }),
        page('founded_era', 'Founded era', 'Era of founding', 'Eras', { hidden: true }),
        str('destroyed', 'Destroyed', 'Date of destruction or abandonment', { date: ['destroyed_year', 'destroyed_era'] }),
        int('destroyed_year', 'Destroyed year', 'Year within the era', { hidden: true }),
        page('destroyed_era', 'Destroyed era', 'Era of destruction', 'Eras', { hidden: true }),
        pages('events', 'Events', 'Notable events here', 'Events'),
      ]},
    ],
    extra: [
      E('map', 'Page', 'Map', 'Reference only: the map page this place appears on (markers themselves are edited on Map:Westernis)', { widget: 'text', hidden: true, placeholder: 'Map:Westernis (reference only)' }),
      E('map_x', 'Float', 'Map X', 'Reference X coordinate (0–100) for the marker on Map:Westernis', { widget: 'text', hidden: true, placeholder: '0–100, reference only' }),
      E('map_y', 'Float', 'Map Y', 'Reference Y coordinate (0–100) for the marker on Map:Westernis', { widget: 'text', hidden: true, placeholder: '0–100, reference only' }),
      text('description', 'Description', 'One or two sentences describing the place'),
    ],
    sections: ['Geography', 'History', 'Inhabitants', 'Etymology', 'Other names', 'Gallery', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' was a ... <!-- lead: what kind of place, where, why it matters -->",
  },
  {
    key: 'faction', template: 'Infobox faction', table: 'Factions', form: 'Faction',
    category: 'Factions', singular: 'Faction', icon: 'banner', accent: '#2c4f8a',
    description: 'A house, order, kingdom, guild, fellowship or other organisation.',
    groups: [
      { header: 'Organisation', fields: [
        str('type', 'Type', 'House, Order, Kingdom, Guild, Fellowship, Host, Council', { widget: 'dropdown', values: ['House', 'Order', 'Kingdom', 'Guild', 'Fellowship', 'Host', 'Council', 'Other'] }),
        page('founder', 'Founder', 'Founder', 'Characters'),
        str('founded', 'Founded', 'Founding date', { date: ['founded_year', 'founded_era'] }),
        int('founded_year', 'Founded year', 'Year within the era', { hidden: true }),
        page('founded_era', 'Founded era', 'Era of founding', 'Eras', { hidden: true }),
        page('leader', 'Leader', 'Current or last leader', 'Characters'),
        page('seat', 'Seat', 'Seat, capital or headquarters', 'Locations'),
        page('realm', 'Realm', 'Realm', 'Locations'),
        str('disbanded', 'Disbanded', 'End of the organisation'),
      ]},
      { header: 'Members & allies', fields: [
        pages('members', 'Notable members', 'Notable members', 'Characters'),
        pages('race', 'Peoples', 'Peoples that make up the faction', 'Peoples'),
        pages('affiliation', 'Allies', 'Allied factions', 'Factions'),
        pages('rivalry', 'Rivals', 'Enemies and rivals', 'Factions'),
        pages('heirlooms', 'Heirlooms', 'Artifacts held by the faction', 'Artifacts'),
        page('language', 'Language', 'Language', 'Languages'),
      ]},
      { header: 'Heraldry', collapse: 'closed', fields: [
        str('colours', 'Colours', 'Heraldic colours'),
        str('motto', 'Motto', 'Motto or words'),
        page('preceded_by', 'Preceded by', 'Predecessor organisation', 'Factions'),
        page('followed_by', 'Followed by', 'Successor organisation', 'Factions'),
      ]},
    ],
    extra: [ text('purpose', 'Purpose', 'What the faction is for') ],
    sections: ['History', 'Organisation', 'Members', 'Heraldry', 'Etymology', 'Gallery', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' was a ... <!-- lead -->",
  },
  {
    key: 'people', template: 'Infobox people', table: 'Peoples', form: 'People',
    category: 'Peoples', singular: 'People', icon: 'tree', accent: '#6a4c93',
    description: 'A race or people: Elves, Men, Dwarves, Hobbits, and the cultures within them.',
    groups: [
      { header: 'Origins', fields: [
        text('origin', 'Origin', 'How the people came to be', { widget: 'textarea' }),
        pages('homeland', 'Homelands', 'Homelands', 'Locations'),
        page('parent', 'Part of', 'Parent race (for cultures/folk)', 'Peoples'),
        pages('subgroups', 'Subgroups', 'Folk, houses or kindreds', 'Peoples'),
        pages('language', 'Languages', 'Languages', 'Languages'),
        str('lifespan', 'Lifespan', 'Typical lifespan'),
      ]},
      { header: 'Relations', fields: [
        pages('affiliation', 'Allies', 'Allied peoples and factions', 'Factions'),
        pages('rivalry', 'Enemies', 'Enemies', 'Factions'),
        pages('notable_members', 'Notable members', 'Notable individuals', 'Characters'),
      ]},
      { header: 'Appearance', collapse: 'closed', fields: [
        str('height', 'Height', 'Typical height'),
        str('hair', 'Hair', 'Hair'),
        str('skin', 'Skin', 'Skin'),
        str('eyes', 'Eyes', 'Eyes'),
        str('clothing', 'Clothing', 'Typical garb'),
        pages('weapons', 'Weapons', 'Typical arms', 'Artifacts'),
      ]},
    ],
    extra: [ text('distinctions', 'Distinctions', 'What sets this people apart') ],
    sections: ['History', 'Culture', 'Society', 'Language', 'Appearance', 'Etymology', 'Gallery', 'See also', 'Notes'],
    leadHint: "The '''{{PAGENAME}}''' were ... <!-- lead -->",
  },
  {
    key: 'creature', template: 'Infobox creature', table: 'Creatures', form: 'Creature',
    category: 'Creatures', singular: 'Creature', icon: 'dragon', accent: '#8a5a2c',
    description: 'Beasts, monsters and other creatures: dragons, eagles, wargs, spirits.',
    groups: [
      { header: 'Nature', fields: [
        str('type', 'Type', 'Beast, Dragon, Spirit, Undead, Construct, Bird, Plant', { widget: 'dropdown', values: ['Beast', 'Dragon', 'Spirit', 'Undead', 'Construct', 'Bird', 'Plant', 'Other'] }),
        page('origin', 'Origin', 'Creator or origin', 'Characters'),
        pages('habitat', 'Habitat', 'Where it is found', 'Locations'),
        str('alignment', 'Alignment', 'Free, Servant of the Shadow, Wild'),
        str('size', 'Size', 'Size'),
        page('first_era', 'First appeared', 'Era first recorded', 'Eras'),
      ]},
      { header: 'Notable individuals', fields: [
        pages('notable_individuals', 'Notable individuals', 'Named creatures of this kind', 'Characters'),
      ]},
    ],
    extra: [ text('abilities', 'Abilities', 'Powers and traits') ],
    sections: ['Description', 'History', 'Notable individuals', 'Etymology', 'Gallery', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' were ... <!-- lead -->",
  },
  {
    key: 'artifact', template: 'Infobox artifact', table: 'Artifacts', form: 'Artifact',
    category: 'Artifacts', singular: 'Artifact', icon: 'ring', accent: '#b8862b',
    description: 'Weapons, rings, relics, jewels, vessels, texts and other objects of note.',
    groups: [
      { header: 'Description', fields: [
        str('type', 'Type', 'Weapon, Ring, Jewel, Relic, Vessel, Text, Armour, Instrument', { widget: 'dropdown', values: ['Weapon', 'Ring', 'Jewel', 'Relic', 'Vessel', 'Text', 'Armour', 'Instrument', 'Other'] }),
        text('appearance', 'Appearance', 'What it looks like'),
        text('powers', 'Powers', 'Powers and properties'),
      ]},
      { header: 'Making', fields: [
        page('creator', 'Creator', 'Maker', 'Characters'),
        str('created', 'Created', 'Date of making', { date: ['created_year', 'created_era'] }),
        int('created_year', 'Created year', 'Year within the era', { hidden: true }),
        page('created_era', 'Created era', 'Era of making', 'Eras', { hidden: true }),
        page('created_location', 'Made in', 'Place of making', 'Locations'),
      ]},
      { header: 'History', fields: [
        pages('owner', 'Owners', 'Owners in order', 'Characters'),
        page('location', 'Location', 'Current or last location', 'Locations'),
        page('destroyer', 'Destroyed by', 'Who destroyed it', 'Characters'),
        str('destroyed', 'Destroyed', 'When it was destroyed or lost'),
        page('destroyed_location', 'Destroyed at', 'Where it was destroyed', 'Locations'),
      ]},
    ],
    extra: [ text('notablefor', 'Notable for', 'Why it matters') ],
    sections: ['Description', 'History', 'Powers', 'Etymology', 'Other names', 'Gallery', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' was ... <!-- lead -->",
  },
  {
    key: 'event', template: 'Infobox event', table: 'Events', form: 'Event',
    category: 'Events', singular: 'Event', icon: 'sword', accent: '#9c3b1c',
    description: 'Battles, councils, founding, oaths, journeys, disasters and festivals.',
    groups: [
      { header: 'Event', fields: [
        str('type', 'Type', 'Battle, War, Siege, Council, Founding, Oath, Journey, Disaster, Festival, Birth, Death', { widget: 'dropdown', values: ['Battle', 'War', 'Siege', 'Council', 'Founding', 'Oath', 'Journey', 'Disaster', 'Festival', 'Birth', 'Death', 'Other'] }),
        str('date', 'Date', 'Date text (e.g. 15 March)', { date: ['year_start', 'era'] }),
        int('year_start', 'Year', 'Start year within the era', { hidden: true }),
        int('year_end', 'End year', 'End year (for wars/periods)', { hidden: true }),
        page('era', 'Era', 'Era/Age', 'Eras', { hidden: true }),
        pages('location', 'Location', 'Where it happened', 'Locations'),
        page('part_of', 'Part of', 'Larger conflict or event', 'Events'),
        page('preceded_by', 'Preceded by', 'Previous event', 'Events'),
        page('followed_by', 'Followed by', 'Next event', 'Events'),
      ]},
      { header: 'Participants', fields: [
        pages('participants', 'Participants', 'Characters involved', 'Characters'),
        pages('factions', 'Factions', 'Factions involved', 'Factions'),
        text('result', 'Result', 'Outcome'),
      ]},
      { header: 'Belligerents', collapse: 'closed', fields: [
        pages('side1', 'Side 1', 'First side', 'Factions'),
        pages('side2', 'Side 2', 'Second side', 'Factions'),
        pages('commanders1', 'Commanders 1', 'Commanders of side 1', 'Characters'),
        pages('commanders2', 'Commanders 2', 'Commanders of side 2', 'Characters'),
        str('forces1', 'Forces 1', 'Strength of side 1'),
        str('forces2', 'Forces 2', 'Strength of side 2'),
        str('casualties1', 'Casualties 1', 'Losses of side 1'),
        str('casualties2', 'Casualties 2', 'Losses of side 2'),
      ]},
    ],
    extra: [ text('description', 'Description', 'One or two sentences') ],
    sections: ['Background', 'Course of events', 'Aftermath', 'Participants', 'Etymology', 'Gallery', 'See also', 'Notes'],
    leadHint: "The '''{{PAGENAME}}''' was ... <!-- lead -->",
  },
  {
    key: 'era', template: 'Infobox era', table: 'Eras', form: 'Era',
    category: 'Eras', singular: 'Era', icon: 'hourglass', accent: '#8c6a2b',
    description: 'An age or era of the world, giving years their frame (prefix like T.A.).',
    groups: [
      { header: 'Span', fields: [
        int('sequence', 'Sequence', 'Order of this era (1, 2, 3…) for timelines'),
        int('year_start', 'First year', 'First year of the era'),
        int('year_end', 'Last year', 'Last year of the era'),
        str('prefix', 'Prefix', 'Year prefix used in dates (e.g. T.A.)'),
        page('preceded_by', 'Preceded by', 'Previous era', 'Eras'),
        page('followed_by', 'Followed by', 'Next era', 'Eras'),
      ]},
      { header: 'Defining events', fields: [
        pages('defining_events', 'Defining events', 'Events that frame the era', 'Events'),
      ]},
    ],
    extra: [ text('description', 'Description', 'Summary of the era') ],
    sections: ['Overview', 'History', 'Timeline', 'Peoples and realms', 'See also', 'Notes'],
    leadHint: "The '''{{PAGENAME}}''' was ... <!-- lead -->",
  },
  {
    key: 'language', template: 'Infobox language', table: 'Languages', form: 'Language',
    category: 'Languages', singular: 'Language', icon: 'quill', accent: '#3b7a8c',
    description: 'A tongue or script of the world.',
    groups: [
      { header: 'Classification', fields: [
        page('family', 'Family', 'Language family', 'Languages'),
        page('parent', 'Derived from', 'Parent language', 'Languages'),
        str('writing', 'Writing system', 'Script used (e.g. Tengwar, Cirth)'),
        pages('speakers', 'Spoken by', 'Peoples speaking it', 'Peoples'),
        pages('region', 'Regions', 'Where it is spoken', 'Locations'),
        pages('era', 'Eras', 'Eras in use', 'Eras'),
      ]},
      { header: 'Sample', fields: [
        text('sample', 'Sample', 'A phrase in the language'),
        str('sample_script', 'Sample (script)', 'The same phrase in Tengwar characters', { format: 'tengwar' }),
        str('sample_meaning', 'Meaning', 'Translation of the sample'),
      ]},
    ],
    extra: [],
    sections: ['History', 'Phonology and grammar', 'Vocabulary', 'Writing', 'Samples', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' was the language of ... <!-- lead -->",
  },
  {
    key: 'power', template: 'Infobox power', table: 'Powers', form: 'Power',
    category: 'Powers', singular: 'Power', icon: 'star', accent: '#c9a227',
    description: 'Valar, Maiar, gods, spirits and other powers of the world.',
    groups: [
      { header: 'Divinity', fields: [
        pages('titles', 'Titles', 'Titles', null, { widget: 'tokens', type: 'List of String' }),
        page('pantheon', 'Order', 'Pantheon or order (e.g. Valar, Maiar)', 'Peoples'),
        pages('domain', 'Domains', 'Spheres of power', null, { widget: 'tokens', type: 'List of String' }),
        str('rank', 'Rank', 'Rank within the order'),
        str('allegiance', 'Allegiance', 'Light, Shadow, Neutral'),
        page('dwelling', 'Dwelling', 'Home or seat', 'Locations'),
        str('symbols', 'Symbols', 'Symbols and sacred things'),
      ]},
      { header: 'Relations', fields: [
        pages('followers', 'Followers', 'Servants and followers', 'Characters'),
        pages('relatives', 'Kin', 'Related powers', 'Characters'),
      ]},
    ],
    extra: [ text('notablefor', 'Notable for', 'Why this power matters') ],
    sections: ['History', 'Powers and domains', 'Worship and followers', 'Etymology', 'Other names', 'Gallery', 'See also', 'Notes'],
    leadHint: "'''{{PAGENAME}}''' was ... <!-- lead -->",
  },
  {
    key: 'chronicle', template: 'Infobox chronicle', table: 'Chronicles', form: 'Chronicle',
    category: 'Chronicles', singular: 'Chronicle', icon: 'book', accent: '#5b4a8a', namespace: 'Chronicle',
    description: 'Your own stories and narratives set in Westernis (lives in the Chronicle: namespace).',
    groups: [
      { header: 'Chronicle', fields: [
        str('status', 'Status', 'idea, draft, revised, final', { widget: 'dropdown', values: ['idea', 'draft', 'revised', 'final'] }),
        page('era', 'Era', 'Era the story is set in', 'Eras'),
        int('year_start', 'From year', 'First year covered'),
        int('year_end', 'To year', 'Last year covered'),
        int('sequence', 'Sequence', 'Order within the larger work'),
        page('part_of', 'Part of', 'Larger work or series', 'Chronicles'),
        int('wordcount', 'Word count', 'Approximate length'),
      ]},
      { header: 'Cast & setting', fields: [
        pages('pov', 'Point of view', 'POV characters', 'Characters'),
        pages('characters', 'Characters', 'Characters appearing', 'Characters'),
        pages('locations', 'Locations', 'Places appearing', 'Locations'),
        pages('events', 'Events', 'Events depicted', 'Events'),
      ]},
    ],
    extra: [ text('summary', 'Summary', 'One-paragraph synopsis') ],
    sections: ['Synopsis', 'Text', 'Notes'],
    leadHint: '<!-- A short synopsis, then the story under == Text == -->',
  },
];
