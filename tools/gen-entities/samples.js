#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Sample + help content for the Westernis wiki.  Run: node tools/gen-entities/samples.js
// Sample lore pages summarise well-known facts of Tolkien's legendarium in our own words
// (canon=Tolkien) so the templates, timeline, family tree and map have something to show.
// Delete or rewrite them freely — they are only scaffolding for your own Westernis.
// Reader-facing text is German (the wiki's default language); page titles, template and
// parameter names, stored dropdown values and Page-field values stay English identifiers,
// so links are written as [[English title|deutsche Form]].
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const write = (ns, title, text) => {
  const dir = path.join(root, 'content', 'pages', ns);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, title.replace(/\//g, '__').replace(/ /g, '_') + '.wiki');
  fs.writeFileSync(file, text.trim() + '\n', 'utf8');
  return path.relative(root, file);
};
const pages = [];
const P = (ns, title, text) => pages.push([ns, title, text]);

// ---------------------------------------------------------------- Eras
P('Main', 'Second Age', `
{{DISPLAYTITLE:Zweites Zeitalter}}
{{Infobox era
| name = Zweites Zeitalter
| othernames = Zeitalter Númenors, Dunkle Jahre
| sequence = 2
| year_start = 1
| year_end = 3441
| prefix = Z.Z.
| preceded_by = First Age
| followed_by = Third Age
| defining_events = Forging of the Rings of Power, Downfall of Númenor, War of the Last Alliance
| description = Das Zeitalter Númenors und der Ringe der Macht, das mit dem ersten Sturz Saurons endete.
| short = Das Zeitalter Númenors und der Ringe der Macht
| canon = Tolkien
}}
Das '''Zweite Zeitalter''' begann nach dem Sturz Morgoths und endete mit Saurons erster Niederlage gegen das Letzte Bündnis von Elben und Menschen. In diesen Jahren wurde den [[Men|Menschen]] des Westens die Insel Númenor geschenkt, die Ringe der Macht wurden geschmiedet, und die Reiche im Exil, [[Gondor]] und Arnor, wurden gegründet.

== Zeittafel ==
{{Timeline|era=Second Age}}

== Siehe auch ==
* [[Third Age|Drittes Zeitalter]]
`);

P('Main', 'Third Age', `
{{DISPLAYTITLE:Drittes Zeitalter}}
{{Infobox era
| name = Drittes Zeitalter
| othernames = Zeitalter des Rings, Zeitalter des Schwindens
| sequence = 3
| year_start = 1
| year_end = 3021
| prefix = D.Z.
| preceded_by = Second Age
| followed_by = Fourth Age
| defining_events = Council of Elrond, War of the Ring, Battle of the Pelennor Fields
| description = Das lange Zeitalter zwischen Saurons Sturz durch das Letzte Bündnis und seiner endgültigen Niederlage im Ringkrieg.
| short = Das Zeitalter des Ringkriegs
| canon = Tolkien
}}
Das '''Dritte Zeitalter''' währte 3021 Jahre, von Saurons Niederlage gegen das Letzte Bündnis bis zur Ausfahrt der Ringträger über das Meer. In diesen Jahren schwanden die Elben, [[Gondor]] sank langsam herab und erstand neu, und zuletzt entbrannte der [[War of the Ring|Ringkrieg]].

== Überblick ==
Jahreszahlen dieses Zeitalters tragen das Kürzel '''D.Z.''' – die Infobox-Vorlagen setzen es von selbst vor das Jahr, sobald ein Zeitalter angegeben ist.

== Zeittafel ==
{{Timeline|era=Third Age}}

== Völker und Reiche ==
<div class="wst-relations">{{#cargo_query:tables=Locations|fields=_pageName=Target,_pageTitle=Label,type=Kind|where=type='Realm'|order by=_pageName|format=template|template=Relationships/row|named args=yes|intro=<div class="wst-relations-group">|outro=</div>|default=''Noch keine Reiche verzeichnet.''}}</div>
`);

P('Main', 'Fourth Age', `
{{DISPLAYTITLE:Viertes Zeitalter}}
{{Infobox era
| name = Viertes Zeitalter
| othernames = Zeitalter der Menschen
| sequence = 4
| year_start = 1
| prefix = V.Z.
| preceded_by = Third Age
| description = Das Zeitalter, das mit dem Fortgang der Ringträger begann; die Zeit der Herrschaft der Menschen.
| short = Das Zeitalter der Menschen
| canon = Tolkien
}}
Das '''Vierte Zeitalter''' begann, als die letzten der Ringträger in den Westen segelten. Im ersten Jahrhundert dieses Zeitalters herrschte [[Aragorn II|Aragorn]] über das Wiedervereinigte Königreich.

== Zeittafel ==
{{Timeline|era=Fourth Age}}
`);

// ---------------------------------------------------------------- Peoples
P('Main', 'Men', `
{{DISPLAYTITLE:Menschen}}
{{Infobox people
| name = Menschen
| othernames = Atani, die Zweitgeborenen, Hildor
| origin = Erwachten in Hildórien beim ersten Aufgang der Sonne.
| homeland = Middle-earth
| subgroups = Dúnedain
| language = Westron
| lifespan = Sterblich; manche Geschlechter waren langlebig
| distinctions = Die Gabe der Menschen: die Sterblichkeit und die Freiheit vom Schicksal der Welt.
| short = Die sterblichen Zweitgeborenen
| canon = Tolkien
}}
Die '''Menschen''' waren die Zweitgeborenen unter den Kindern Ilúvatars. Anders als die [[Elves|Elben]] waren sie sterblich, und ihr Geschick jenseits des Todes blieb selbst den Valar verborgen.
`);

P('Main', 'Elves', `
{{DISPLAYTITLE:Elben}}
{{Infobox people
| name = Elben
| othernames = Quendi, die Erstgeborenen, Eldar
| origin = Erwachten unter den Sternen an den Wassern von Cuiviénen.
| homeland = Rivendell, Lothlórien, Mirkwood
| language = Sindarin, Quenya
| lifespan = Unsterblich innerhalb der Kreise der Welt
| notable_members = Elrond, Arwen
| distinctions = An die Welt gebunden, solange sie währt; scharfsichtig, unermüdlich und geschickter als alle anderen Völker.
| short = Die erstgeborenen Kinder Ilúvatars
| canon = Tolkien
}}
Die '''Elben''' waren die Erstgeborenen unter den Kindern Ilúvatars. Unsterblich innerhalb der Welt, war ihnen doch bestimmt zu schwinden, als das Zeitalter der [[Men|Menschen]] heraufzog.
`);

P('Main', 'Dúnedain', `
{{Infobox people
| othernames = Menschen des Westens, Númenórer im Exil
| parent = Men
| origin = Nachfahren der Edain, die mit der Insel Númenor belohnt wurden; nach deren Untergang gründeten die Getreuen Arnor und Gondor.
| homeland = Gondor, Eriador
| affiliation = Rangers of the North
| language = Westron, Sindarin
| notable_members = Aragorn II
| lifespan = In den frühen Tagen dreimal so lang wie bei geringeren Menschen
| distinctions = Hochgewachsen, grauäugig und langlebig; Hüter der Kunde von Númenor.
| short = Die Menschen des Westens, Erben Númenors
| canon = Tolkien
}}
Die '''Dúnedain''' waren die Menschen númenórischer Abstammung, die nach dem Untergang in Mittelerde wohnten. Im Norden zerfiel ihr Reich Arnor, und sie wurden zu den [[Rangers of the North|Waldläufern des Nordens]]; im Süden hielten sie [[Gondor]].
`);

P('Main', 'Maiar', `
{{Infobox people
| othernames = Die geringeren Ainur
| origin = Geister, die zu Anbeginn mit den Valar in die Welt eintraten.
| notable_members = Gandalf
| lifespan = Unsterblich
| distinctions = Diener und Helfer der [[Valar]]; manche nahmen die Gestalt der Kinder Ilúvatars an.
| short = Geringere Geister im Dienst der Valar
| canon = Tolkien
}}
Die '''Maiar''' waren Geister vom selben Stand wie die [[Valar]], doch von geringerer Macht. Zu ihnen gehörten die Istari, die Zauberer, die im [[Third Age|Dritten Zeitalter]] nach Mittelerde gesandt wurden.
`);

P('Main', 'Valar', `
{{Infobox people
| othernames = Die Mächte der Welt
| origin = Die Größten unter den Ainur, die in die Welt eintraten, um sie zu gestalten und zu hüten.
| homeland = Valinor
| notable_members = Manwë
| lifespan = Unsterblich
| distinctions = Herrscher der Welt unter Ilúvatar.
| short = Die Mächte, die die Welt gestalteten
| canon = Tolkien
}}
Die '''Valar''' waren die Mächte der Welt, die Größten unter den Ainur. [[Manwë]] war ihr König.
`);

// ---------------------------------------------------------------- Locations
P('Main', 'Eriador', `
{{Infobox location
| type = Region
| othernames = Die Einsamen Lande
| regions = The Shire, Bree-land
| settlements = Rivendell
| inhabitants = Dúnedain, Elves
| description = Die weiten Lande zwischen dem Nebelgebirge und den Blauen Bergen, einst das Königreich Arnor.
| map = Map:Westernis
| map_x = 32
| map_y = 36
| short = Die Lande westlich des Nebelgebirges
| canon = Tolkien
}}
'''Eriador''' war das Land zwischen dem Nebelgebirge und den Blauen Bergen. Einst gehörte es zum Königreich Arnor; gegen Ende des [[Third Age|Dritten Zeitalters]] war es nur noch dünn besiedelt und wurde von den [[Rangers of the North|Waldläufern des Nordens]] bewacht.
`);

P('Main', 'Rivendell', `
{{DISPLAYTITLE:Bruchtal}}
{{Infobox location
| name = Bruchtal
| script =
| type = Settlement
| othernames = Imladris, das Letzte Heimelige Haus
| parent = Eriador
| founded_year = 1697
| founded_era = Second Age
| ruler = Elrond
| inhabitants = Elves
| language = Sindarin
| events = Council of Elrond
| description = Eine verborgene Zuflucht in einem Tal am Fuß des Nebelgebirges, von Elrond im Krieg gegen Sauron gegründet.
| map = Map:Westernis
| map_x = 44
| map_y = 33
| short = Elronds verborgene Zuflucht im Tal
| canon = Tolkien
}}
'''Bruchtal''' war die verborgene Zuflucht [[Elrond]]s in einem tiefen Tal des Nebelgebirges. Im [[Second Age|Zweiten Zeitalter]] gegründet, wurde es zu einem Hort der Kunde und der Heilung; in den letzten Jahren des [[Third Age|Dritten Zeitalters]] tagte dort [[Council of Elrond|Elronds Rat]].

== Bewohner ==
{{Relationships}}
`);

P('Main', 'Gondor', `
{{Infobox location
| type = Realm
| othernames = Das Südkönigreich, Reich des Steinlandes
| capital = Minas Tirith
| regions = Ithilien, Anórien, Lebennin
| settlements = Minas Tirith
| inhabitants = Dúnedain, Men
| language = Westron, Sindarin
| ruler = Aragorn II
| founded_year = 3320
| founded_era = Second Age
| events = War of the Ring, Battle of the Pelennor Fields
| factions = Rangers of the North
| description = Das südliche Reich der Dúnedain im Exil, nach dem Untergang Númenors von Elendil und seinen Söhnen gegründet.
| map = Map:Westernis
| map_x = 58
| map_y = 72
| short = Das Südkönigreich der Dúnedain
| canon = Tolkien
}}
'''Gondor''' war das südliche Königreich der [[Dúnedain]], gegen Ende des [[Second Age|Zweiten Zeitalters]] von Elendil und seinen Söhnen Isildur und Anárion gegründet. Jahrhundertelang von Truchsessen regiert, erhielt es nach dem [[War of the Ring|Ringkrieg]] durch [[Aragorn II|Aragorn]] sein Königtum zurück.

== Geschichte ==
{{Timeline|location=Gondor}}

== Bewohner ==
{{Relationships}}
`);

P('Main', 'Minas Tirith', `
{{Infobox location
| type = Settlement
| othernames = Minas Anor, Turm der Wacht, die Weiße Stadt
| parent = Gondor
| realm = Gondor
| founded_year = 3320
| founded_era = Second Age
| ruler = Aragorn II
| inhabitants = Dúnedain, Men
| events = Battle of the Pelennor Fields
| description = Die siebenfach gestufte Hauptstadt Gondors, an die Knie des Berges Mindolluin gelehnt.
| map = Map:Westernis
| map_x = 60
| map_y = 70
| short = Die Weiße Stadt, Hauptstadt Gondors
| canon = Tolkien
}}
'''Minas Tirith''' war die Hauptstadt [[Gondor]]s, eine Stadt aus sieben Mauerringen, die den Hang des Mindolluin hinaufstieg. Im [[Second Age|Zweiten Zeitalter]] als Minas Anor erbaut, erhielt sie den Namen „Turm der Wacht“, als Minas Ithil an den Feind fiel.

== Geschichte ==
{{Timeline|location=Minas Tirith}}
`);

P('Main', 'Mordor', `
{{Infobox location
| type = Realm
| othernames = Das Schwarze Land, Land des Schattens
| capital = Barad-dûr
| ruler = Sauron
| events = War of the Ring
| description = Das von Gebirgen umwallte Reich Saurons im Südosten; in den Feuern des Orodruin wurde dort der Eine Ring geschmiedet.
| map = Map:Westernis
| map_x = 76
| map_y = 70
| short = Saurons Schwarzes Land
| canon = Tolkien
}}
'''Mordor''' war das Reich Saurons, an drei Seiten von Gebirgen umwallt. Darin standen Barad-dûr und der Feuerberg Orodruin, wo der [[One Ring|Eine Ring]] geschaffen und wieder vernichtet wurde.
`);

// ---------------------------------------------------------------- Factions
P('Main', 'Rangers of the North', `
{{DISPLAYTITLE:Waldläufer des Nordens}}
{{Infobox faction
| name = Waldläufer des Nordens
| type = Order
| othernames = Dúnedain von Arnor
| leader = Aragorn II
| members = Aragorn II
| race = Dúnedain
| affiliation = Fellowship of the Ring
| language = Westron, Sindarin
| colours = Grau und Grün
| purpose = Bewachten nach dem Fall Arnors im Verborgenen Eriador und das Auenland.
| short = Die verborgenen Hüter des Nordens
| canon = Tolkien
}}
Die '''Waldläufer des Nordens''' waren der Rest der [[Dúnedain]] von Arnor: grau gewandete, umherziehende Hüter [[Eriador]]s, geführt von den Häuptlingen aus Isildurs Geschlecht.

== Mitglieder ==
{{Relationships}}
`);

P('Main', 'Fellowship of the Ring', `
{{DISPLAYTITLE:Gemeinschaft des Rings}}
{{Infobox faction
| name = Gemeinschaft des Rings
| type = Fellowship
| othernames = Die Neun Gefährten
| founder = Elrond
| founded = 25. Dezember
| founded_year = 3018
| founded_era = Third Age
| leader = Gandalf
| seat = Rivendell
| members = Gandalf, Aragorn II, Frodo Baggins, Samwise Gamgee, Legolas, Gimli, Boromir, Meriadoc Brandybuck, Peregrin Took
| race = Men, Elves, Maiar
| rivalry = Mordor
| disbanded = Am Parth Galen zerbrochen, 26. Februar D.Z. 3019
| purpose = Den Einen Ring zum Orodruin zu tragen und dort zu vernichten.
| short = Die Neun Gefährten, in Bruchtal erwählt
| canon = Tolkien
}}
Die '''Gemeinschaft des Rings''' war die Schar von neun Gefährten, die bei [[Council of Elrond|Elronds Rat]] erwählt wurde, um den Ringträger zu begleiten. Sie brach am 25. Dezember D.Z. 3018 von [[Rivendell|Bruchtal]] auf und zerbrach zwei Monate später am Parth Galen.

== Mitglieder ==
{{Relationships}}
`);

// ---------------------------------------------------------------- Characters
P('Main', 'Aragorn II', `
{{Infobox character
| othernames = Streicher, Elessar, Estel, Thorongil
| titles = König des Wiedervereinigten Königreichs, Häuptling der Dúnedain
| race = Men
| culture = Dúnedain
| gender = männlich
| affiliation = Rangers of the North, Fellowship of the Ring
| position = König von Gondor und Arnor
| realm = Gondor
| location = Minas Tirith
| birth = 1. März
| birth_year = 2931
| birth_era = Third Age
| birthplace = Eriador
| death = 1. März
| death_year = 120
| death_era = Fourth Age
| deathplace = Minas Tirith
| age = 210
| rule = V.Z. 1 – 120
| parentage = Arathorn II, Gilraen
| spouse = Arwen
| children = Eldarion
| height = Hochgewachsen
| hair = Dunkel
| eyes = Grau
| weapons = Andúril
| language = Westron, Sindarin
| notablefor = Erbe Isildurs, der nach dem Ringkrieg das Königtum von Gondor und Arnor erneuerte.
| short = Erbe Isildurs, König Elessar
| canon = Tolkien
}}
'''Aragorn II.''', genannt '''Elessar''', war der letzte Häuptling der [[Rangers of the North|Waldläufer des Nordens]] und der erste König des Wiedervereinigten Königreichs. In [[Rivendell|Bruchtal]] unter dem Namen Estel aufgewachsen, zog er viele Jahre als Streicher durch die Wildnis, ehe ihn der [[War of the Ring|Ringkrieg]] auf den Thron [[Gondor]]s führte.

== Stammbaum ==
{{Family tree}}

== Beziehungen ==
{{Relationships}}

== Auftritte in den Chroniken ==
{{Appearances}}

== Anmerkungen ==
<references />
`);

P('Main', 'Arwen', `
{{Infobox character
| othernames = Undómiel, Abendstern
| titles = Königin des Wiedervereinigten Königreichs
| race = Elves
| culture = Half-elven
| gender = weiblich
| realm = Gondor
| location = Minas Tirith
| birth_year = 241
| birth_era = Third Age
| birthplace = Rivendell
| death_year = 121
| death_era = Fourth Age
| deathplace = Lothlórien
| parentage = Elrond, Celebrían
| siblings = Elladan, Elrohir
| spouse = Aragorn II
| children = Eldarion
| hair = Dunkel
| eyes = Grau
| language = Sindarin, Westron
| notablefor = Wählte ein sterbliches Leben, um sich mit Aragorn zu vermählen, und wurde Königin von Gondor.
| short = Abendstern ihres Volkes, Königin von Gondor
| canon = Tolkien
}}
'''Arwen''' Undómiel war die Tochter [[Elrond]]s und Celebríans. Sie wählte das Geschick der [[Men|Menschen]], um sich mit [[Aragorn II|Aragorn]] zu vermählen, und herrschte an seiner Seite als Königin.

== Stammbaum ==
{{Family tree}}

== Auftritte in den Chroniken ==
{{Appearances}}
`);

P('Main', 'Elrond', `
{{Infobox character
| othernames = Elrond Halbelb, Elrond Peredhel
| titles = Herr von Bruchtal, Meister von Imladris
| race = Elves
| culture = Half-elven
| gender = männlich
| affiliation = Fellowship of the Ring
| position = Herr von Bruchtal
| realm = Rivendell
| location = Rivendell
| birth_year = 532
| birth_era = First Age
| parentage = Eärendil, Elwing
| siblings = Elros
| spouse = Celebrían
| children = Elladan, Elrohir, Arwen
| hair = Dunkel
| eyes = Grau
| language = Sindarin, Quenya, Westron
| notablefor = Gründer und Herr von Bruchtal; berief den Rat ein, der die Gemeinschaft erwählte.
| short = Herr von Bruchtal
| canon = Tolkien
}}
'''Elrond''' war der Herr von [[Rivendell|Bruchtal]], Sohn Eärendils und Elwings, der wählte, zu den [[Elves|Elben]] gezählt zu werden. Er trug einen der Drei Ringe und berief den [[Council of Elrond|Rat]] ein, der seinen Namen trägt.

== Stammbaum ==
{{Family tree}}

== Beziehungen ==
{{Relationships}}

== Auftritte in den Chroniken ==
{{Appearances}}
`);

P('Main', 'Gandalf', `
{{Infobox character
| othernames = Mithrandir, Olórin, Tharkûn, Incánus, der Graue Pilger
| titles = Der Graue, der Weiße
| race = Maiar
| culture = Istari
| gender = männlich
| affiliation = Fellowship of the Ring
| position = Zauberer
| location = Minas Tirith
| weapons = Glamdring
| steed = Shadowfax
| language = Westron, Sindarin, Quenya
| notablefor = Der Zauberer, der die Freien Völker durch den Ringkrieg geleitete.
| short = Der Graue Pilger, Zauberer der Istari
| canon = Tolkien
}}
'''Gandalf''' war einer der Istari, ein [[Maiar|Maia]], der im [[Third Age|Dritten Zeitalter]] nach Mittelerde gesandt wurde, um den Widerstand gegen Sauron zu entfachen. Er führte die [[Fellowship of the Ring|Gemeinschaft des Rings]], bis er in Moria fiel, und kehrte als Gandalf der Weiße zurück.

== Beziehungen ==
{{Relationships}}

== Auftritte in den Chroniken ==
{{Appearances}}
`);

// ---------------------------------------------------------------- Artifacts
P('Main', 'Andúril', `
{{Infobox artifact
| othernames = Flamme des Westens, Narsil (vor der Neuschmiedung)
| type = Weapon
| appearance = Ein Langschwert, dessen Klinge aus den Bruchstücken Narsils neu geschmiedet und mit sieben Sternen, einer Mondsichel und einer strahlenden Sonne verziert war.
| creator = Telchar
| created_era = First Age
| created_location = Nogrod
| owner = Elendil, Isildur, Aragorn II
| location = Gondor
| notablefor = Das zerbrochene Schwert, das in Bruchtal für den Erben Isildurs neu geschmiedet wurde.
| short = Das für den König neu geschmiedete Schwert
| canon = Tolkien
}}
'''Andúril''' war das Schwert [[Aragorn II|Aragorns]], in [[Rivendell|Bruchtal]] aus den Bruchstücken Narsils neu geschmiedet – jener Klinge, mit der Isildur Sauron den [[One Ring|Einen Ring]] von der Hand geschnitten hatte.
`);

P('Main', 'One Ring', `
{{DISPLAYTITLE:Der Eine Ring}}
{{Infobox artifact
| name = Der Eine Ring
| othernames = Der Herrscherring, Isildurs Fluch, der Schatz
| type = Ring
| appearance = Ein schlichter Reif aus Gold, der in der Glut feurige Buchstaben in der Schwarzen Sprache zeigte.
| powers = Gebot über die anderen Ringe der Macht; machte sterbliche Träger unsichtbar und dehnte ihr Leben.
| creator = Sauron
| created_year = 1600
| created_era = Second Age
| created_location = Mordor
| owner = Sauron, Isildur, Gollum, Bilbo Baggins, Frodo Baggins
| destroyed = 25. März D.Z. 3019
| destroyed_location = Mordor
| notablefor = Der Herrscherring, mit dessen Vernichtung der Ringkrieg endete.
| short = Saurons Herrscherring
| canon = Tolkien
}}
Der '''Eine Ring''' wurde von Sauron in den Feuern des Orodruin geschmiedet, um die anderen Ringe der Macht zu beherrschen. Ein Zeitalter lang verschollen, gelangte er an Gollum, dann an Bilbo und Frodo Beutlin und wurde schließlich in demselben Feuer vernichtet, in dem er geschaffen worden war.

== Geschichte ==
{{Timeline|participant=One Ring}}
`);

// ---------------------------------------------------------------- Events
P('Main', 'War of the Ring', `
{{DISPLAYTITLE:Ringkrieg}}
{{Infobox event
| name = Ringkrieg
| type = War
| year_start = 3018
| year_end = 3019
| era = Third Age
| location = Gondor, Mordor, Eriador
| participants = Aragorn II, Gandalf, Elrond
| factions = Fellowship of the Ring, Rangers of the North
| followed_by = Fourth Age
| side1 = Gondor, Fellowship of the Ring
| side2 = Mordor
| commanders1 = Aragorn II, Gandalf
| commanders2 = Sauron
| result = Vernichtung des Einen Rings; endgültiger Sturz Saurons; Erneuerung des Königtums von Gondor und Arnor.
| description = Der große Krieg am Ende des Dritten Zeitalters zwischen den Freien Völkern und Sauron.
| short = Der Krieg, der das Dritte Zeitalter beendete
| canon = Tolkien
}}
Der '''Ringkrieg''' wurde in den letzten Jahren des [[Third Age|Dritten Zeitalters]] zwischen Sauron von [[Mordor]] und den Freien Völkern Mittelerdes ausgefochten. Er endete mit der Vernichtung des [[One Ring|Einen Rings]].

== Verlauf ==
{{Timeline|era=Third Age|from=3018|to=3019}}
`);

P('Main', 'Council of Elrond', `
{{DISPLAYTITLE:Elronds Rat}}
{{Infobox event
| name = Elronds Rat
| type = Council
| date = 25. Oktober
| year_start = 3018
| era = Third Age
| location = Rivendell
| participants = Elrond, Gandalf, Aragorn II
| factions = Fellowship of the Ring
| part_of = War of the Ring
| followed_by = Battle of the Pelennor Fields
| result = Die Gemeinschaft des Rings wurde erwählt, den Ring nach Mordor zu tragen.
| description = Die Ratsversammlung in Bruchtal, auf der über das Schicksal des Einen Rings entschieden wurde.
| short = Der Rat, der die Gemeinschaft erwählte
| canon = Tolkien
}}
'''Elronds Rat''' trat am 25. Oktober D.Z. 3018 in [[Rivendell|Bruchtal]] zusammen. Dort wurde die Geschichte des [[One Ring|Einen Rings]] vollständig erzählt, und die [[Fellowship of the Ring|Gemeinschaft des Rings]] wurde erwählt.
`);

P('Main', 'Battle of the Pelennor Fields', `
{{DISPLAYTITLE:Schlacht auf den Pelennor-Feldern}}
{{Infobox event
| name = Schlacht auf den Pelennor-Feldern
| type = Battle
| date = 15. März
| year_start = 3019
| era = Third Age
| location = Minas Tirith, Gondor
| participants = Aragorn II, Gandalf
| factions = Fellowship of the Ring
| part_of = War of the Ring
| preceded_by = Council of Elrond
| side1 = Gondor
| side2 = Mordor
| commanders1 = Aragorn II, Gandalf
| commanders2 = Witch-king of Angmar
| forces1 = Menschen Gondors, die Rohirrim, die Graue Schar
| forces2 = Orks, Haradrim, Ostlinge, Mûmakil
| result = Entscheidender Sieg Gondors und Rohans; Tod Théodens und des Hexenkönigs.
| description = Die größte Schlacht des Ringkriegs, geschlagen vor den Mauern von Minas Tirith.
| short = Die große Schlacht vor Minas Tirith
| canon = Tolkien
}}
Die '''Schlacht auf den Pelennor-Feldern''' wurde am 15. März D.Z. 3019 vor den Mauern von [[Minas Tirith]] geschlagen. Den Belagerungsring brachen zuerst die Rohirrim, die im Morgengrauen heranritten, und danach [[Aragorn II|Aragorn]], der mit den schwarzen Schiffen von Süden kam.
`);

// ---------------------------------------------------------------- Language, Power, Creature
P('Main', 'Sindarin', `
{{Infobox language
| othernames = Grauelbisch
| family = Eldarin
| writing = Tengwar, Cirth
| speakers = Elves, Dúnedain
| region = Gondor, Rivendell
| era = Second Age, Third Age
| sample = Mae govannen
| sample_meaning = Wohl getroffen
| short = Die Sprache der Grauelben
| canon = Tolkien
}}
'''Sindarin''' war die Sprache der Grauelben von Beleriand und in späteren Zeitaltern die gebräuchliche Elbensprache Mittelerdes. Die [[Dúnedain]] von [[Gondor]] pflegten sie als Sprache der Kunde und der höfischen Rede.

== Sprachproben ==
{{Quote|''Mae govannen!''|Glorfindel zu Aragorn|''Die Gefährten'', Buch I, Kap. 12}}
`);

P('Main', 'Manwë', `
{{Infobox power
| othernames = Súlimo, der Ältere König
| titles = König der Valar, Herr des Atems von Arda
| pantheon = Valar
| domain = Winde, Lüfte, Vögel
| rank = König der Valar
| allegiance = Licht
| dwelling = Taniquetil
| symbols = Adler, das Saphirzepter
| followers = Great Eagles
| short = Der Ältere König der Valar
| canon = Tolkien
}}
'''Manwë''' war der König der [[Valar]], der Ilúvatar am nächsten stand, und Herr der Lüfte. Die [[Great Eagles|Großen Adler]] waren seine Boten.
`);

P('Main', 'Great Eagles', `
{{DISPLAYTITLE:Große Adler}}
{{Infobox creature
| name = Große Adler
| othernames = Adler Manwës
| type = Bird
| origin = Manwë
| habitat = Misty Mountains
| alignment = Frei
| size = Gewaltig; die ältesten maßen dreißig Klafter von Schwinge zu Schwinge
| abilities = Sprache, große Schnelligkeit und Stärke; scharfe Augen.
| notable_individuals = Gwaihir, Thorondor
| first_era = First Age
| short = Die Boten Manwës
| canon = Tolkien
}}
Die '''Großen Adler''' waren die Boten [[Manwë]]s, die größten aller Vögel. Im [[War of the Ring|Ringkrieg]] trug Gwaihir, der Herr der Winde, [[Gandalf]] von Orthanc und vom Gipfel des Zirakzigil davon.
`);

// ---------------------------------------------------------------- Chronicle (your stories)
P('Chronicle', 'The Grey Road', `
{{Infobox chronicle
| status = idea
| era = Third Age
| year_start = 3017
| pov = Aragorn II
| locations = Eriador
| summary = Die winterliche Wanderung eines Waldläufers des Nordens von Bree zu den Ruinen von Fornost – eine Platzhalter-Chronik, die zeigt, wie Geschichten verzeichnet werden.
| short = Eine Platzhalter-Chronik
| canon = Draft
}}
{{Stub|needs=ein Verfasser; diese Chronik zeigt nur, wie Geschichten verzeichnet werden}}

== Abriss ==
Ersetze diesen Abriss durch deine eigene Geschichte. Chroniken haben einen eigenen Namensraum, werden unter [[:Category:Chronicles|Chroniken]] geführt und erscheinen von selbst im Abschnitt ''Auftritte in den Chroniken'' jeder Gestalt, jedes Ortes und jeder Begebenheit, die in ihrer Infobox genannt sind.

== Die Chronik ==
{{Drop cap|G}}rau war die Straße, und tief lag der Schnee …
`);

// ---------------------------------------------------------------- Westernis itself
P('Main', 'Westernis', `
{{SHORTDESC:Deine Welt – hier beginnt alles}}
{{Stub|needs=alles; diese Seite ist dir zum Schreiben überlassen}}
'''Westernis''' ist die Welt, deren Chronik dieses Wiki führt. Die Beispielseiten, die überall im Wiki verstreut liegen, fassen Tolkiens Legendarium zusammen, damit Vorlagen, Zeittafeln und Stammbäume etwas zu zeigen haben; dein eigener Kanon tritt neben sie oder legt sich über sie.

== Erste Schritte ==
* [[Westernis:Create|Einen Eintrag beginnen]] – Formulare für jede Art von Eintrag
* [[Westernis:Manual of Style|Stilregeln]] – wie hier geschrieben wird
* [[Westernis:Canon|Kanon]] – Tolkien-Kanon, Westernis-Kanon und Entwürfe
* [[Westernis:AI workflow|Arbeiten mit Claude Code]] – Kunde sammeln und weiterspinnen
* [[Map:Westernis|Weltkarte]] – die Karte der bekannten Lande

== Die Zeitalter ==
{{#cargo_query:tables=Eras|fields=_pageName=Zeitalter,prefix=Kürzel,year_start=Beginn,year_end=Ende,description=Beschreibung|order by=sequence|format=table}}
`);

// ---------------------------------------------------------------- Glossary (Lingo tooltips)
// Lingo matches the terms literally in article text, so every term must be spelled exactly as
// it appears in the (German) prose; the <div> lines are ignored by Lingo.
P('Main', 'Glossary', `
{{DISPLAYTITLE:Glossar}}
{{SHORTDESC:Begriffe, die überall beim Darüberfahren erklärt werden}}
Dieses '''Glossar''' versammelt die Worte der alten Tage, die in den Einträgen immer wiederkehren. Wo einer dieser Begriffe im Text steht, ist er unterstrichen; fährt man mit dem Zeiger darüber, erscheint seine Erklärung.

<div class="wst-glossary">
;Ainur
:Die Heiligen, Geister, die Ilúvatar vor der Welt erschuf; zu ihnen zählten die Valar und die Maiar.
;Dúnedain
:Die Menschen des Westens, Nachfahren der Númenórer.
;Eldar
:Die Elben, die dem Ruf nach Valinor folgten, und ihre Nachkommen.
;Istari
:Die fünf Zauberer, die im Dritten Zeitalter nach Mittelerde gesandt wurden; Gandalf war einer von ihnen.
;Maiar
:Geister vom selben Stand wie die Valar, doch von geringerer Macht.
;Mithril
:Moria-Silber; das seltenste und kostbarste Metall der Zwerge, silbern schimmernd, leicht und doch überaus fest.
;Palantír
:Ein Sehender Stein aus Númenor; sieben wurden nach Mittelerde gebracht.
;Tengwar
:Die von Fëanor ersonnene Schrift, in der Quenya, Sindarin und viele andere Sprachen geschrieben wurden.
;Valar
:Die Mächte der Welt, die Größten unter den Ainur.
;Westron
:Die Gemeinsprache Mittelerdes im Dritten Zeitalter.
</div>

== Anmerkungen ==
Neue Begriffe werden als Zeilenpaar eingetragen – <code>;Begriff</code>, darunter <code>:Erklärung</code> (Erweiterung Lingo). Der Begriff muss genau so geschrieben sein, wie er im Fließtext steht.
`);

// ---------------------------------------------------------------- Project pages
P('Project', 'Manual of Style', `
{{SHORTDESC:Wie Einträge in Westernis geschrieben werden}}
Diese Stilregeln gelten für alle Einträge des Wikis – für die Zusammenfassungen aus Tolkiens Werk ebenso wie für den eigenen Kanon von Westernis.

== Sprache und Zeitform ==
* Geschrieben wird auf Deutsch, aus Sicht der Welt und im Präteritum: „Aragorn ''war'' der Sohn Arathorns.“
* Der Ton ist der einer Chronik: gehoben, klar und ohne Blick von außen – kein „heute“, keine Hinweise auf Bücher oder Leser im Fließtext.
* Eingeführte deutsche Tolkien-Begriffe haben Vorrang: Mittelerde, Elben, Zwerge, Bruchtal, Nebelgebirge, Auenland, Drittes Zeitalter, Ringkrieg.
* Völker stehen im Plural („die Elben“, nicht „die Elbenrasse“).
* Fremdsprachliche Wörter werden kursiv gesetzt (''mae govannen''). Beinamen werden großgeschrieben, wenn sie als Name dienen („der Graue Pilger“).
* Deutsche Anführungszeichen („…“) und der Halbgeviertstrich mit Leerzeichen ( – ) für Einschübe.

== Lemma und Verlinkung ==
* Das Lemma – der Name, unter dem der Eintrag steht – erscheint bei seiner ersten Nennung in der Einleitung '''fett''' und in seiner deutschen Form: <code><nowiki>'''Bruchtal''' war …</nowiki></code>.
* Personen, Orte, Völker und Dinge werden bei ihrer ersten Erwähnung verlinkt, danach nicht erneut.
* Linkziel ist immer der bestehende Seitentitel, auch wenn er englisch ist; die deutsche Form steht hinter dem senkrechten Strich: <code><nowiki>[[Rivendell|Bruchtal]]</nowiki></code>, <code><nowiki>im [[Third Age|Dritten Zeitalter]]</nowiki></code>.

== Aufbau ==
Jeder Eintrag beginnt mit der Infobox seiner Art (siehe [[Westernis:Create|Einen Eintrag beginnen]]), dann folgt eine Einleitung von ein bis drei Absätzen, danach die Abschnitte in der Reihenfolge des Gerüsts – bei Gestalten etwa Geschichte, Vermächtnis, Namenskunde, Weitere Namen, Stammbaum, Beziehungen, Auftritte in den Chroniken, Bildnisse, Siehe auch, Anmerkungen. Abschnittstitel sind deutsch und werden aus dem Gerüst übernommen; leere Abschnitte entfallen.

== Daten ==
Jahr und Zeitalter stehen in der Infobox (<code>birth_year=2931</code>, <code>birth_era=Third Age</code>); die Vorlagen machen daraus „D.Z. 2931“. Jede Zeitalter-Seite legt ihr Kürzel selbst fest. Tag und Monat werden deutsch geschrieben (<code>birth=1. März</code>).

== Namen ==
Titel tragen keinen vorangestellten Artikel (<code>Shire</code>, nicht <code>The Shire</code>; Chroniken dürfen ihren behalten). Gleichnamige werden zuerst durch Ordnungszahlen unterschieden (Arathorn I, Arathorn II – im Fließtext mit Punkt: Arathorn II.), dann durch Zusätze in Klammern. Für weitere Namen, Schreibweisen und deutsche Formen werden Weiterleitungen angelegt.

== Kanon ==
Jede Infobox hat ein Feld <code>canon</code>: '''Tolkien''' für das Legendarium, '''Westernis''' für den eigenen Kanon, '''Draft''' für alles Ungeprüfte – auch für Seiten, die eine KI angelegt hat. Siehe [[Westernis:Canon|Kanon]].
`);

P('Project', 'Canon', `
{{SHORTDESC:Drei Schichten der Wahrheit}}
Westernis kennt drei Schichten des Kanons; welche für einen Eintrag gilt, steht im Feld <code>canon</code> seiner Infobox:

* '''Tolkien''' – das veröffentlichte Legendarium, stets in eigenen Worten zusammengefasst.
* '''Westernis''' – der eigene Kanon: neue Reiche, Häuser und Geschichten und alles, worin diese Welt von ihrer Vorlage abweicht.
* '''Draft''' (angezeigt als „Entwurf“) – alles Ungeprüfte. Seiten, die Claude Code anlegt, beginnen hier; freigegeben werden sie, indem man das Feld auf Tolkien oder Westernis setzt.

Kategorien: [[:Category:Tolkien canon|Tolkien-Kanon]] · [[:Category:Westernis canon|Westernis-Kanon]] · [[:Category:Draft articles|Entwürfe]].

Geheimnisse, überraschende Wendungen und Notizen allein für die Spielleitung gehören in <code><nowiki>{{Secret|title=…|text=…}}</nowiki></code>-Blöcke, die zunächst eingeklappt sind.
`);

P('Project', 'AI workflow', `
{{SHORTDESC:Kunde sammeln und weiterspinnen mit Claude Code}}
Der MCP-Server '''Forge''' (im Projektordner unter <code>tools/forge-mcp</code>) erlaubt Claude Code, dieses Wiki unmittelbar zu lesen und zu beschreiben. Öffne den Projektordner in Claude Code und bitte zum Beispiel:

* „Sammle alles, was wir über Gondor wissen, und entwirf einen Eintrag über Ithilien.“
* „Lege mit der Vorlage für Gestalten eine Seite über Halbarad an und markiere sie als Entwurf.“
* „Suche die roten Links zum Zweiten Zeitalter und schlage vor, welche zuerst geschrieben werden sollen.“
* „Prüfe Aragorn II auf fehlende Abschnitte und widersprüchliche Daten.“

== Was die Werkzeuge tun ==
* '''wiki_lore_context''' – holt die Seiten, Infobox-Daten und Suchtreffer zu einem Thema, damit neuer Text zu dem passt, was schon besteht.
* '''wiki_entity_schema''' – die Felder und Abschnitte jeder Eintragsart (dieselben Definitionen, die auch die Formulare nutzen).
* '''wiki_create_entity''' – schreibt aus Feldwerten und Fließtext einen richtig gegliederten Eintrag.
* '''wiki_suggest_links''' – findet bestehende Seiten, die ein Text erwähnt, und schlägt <nowiki>[[Links]]</nowiki> vor.
* '''wiki_wanted_pages''' – der Vorrat an roten Links, also die nächsten Einträge, die geschrieben werden wollen.
* '''wiki_lint_article''' – prüft Aufbau, Kanon-Feld, Kurzbeschreibung, rote Links und fehlende Abschnitte.
* dazu Suchen, Lesen, Speichern, das Bearbeiten einzelner Abschnitte (<code>wiki_edit_section</code>, Unterabschnitte bleiben erhalten), Vorschau, letzte Änderungen, Kategorien, Cargo-Abfragen und Uploads.

== Regeln, denen die Skills folgen ==
# Erst lesen, dann schreiben: Bestehende Seiten haben Vorrang vor Erfundenem.
# Neue Seiten beginnen mit <code>canon=Draft</code>, sofern nichts anderes verlangt ist.
# Verlinkt wird nur auf Seiten, die bestehen oder bestehen sollten; bewusst gesetzte rote Links bleiben als Arbeitsvorrat stehen.
# Infobox-Felder und Abschnittsfolge der Eintragsart werden eingehalten; Fließtext und Abschnittstitel sind deutsch.
`);

// Linked from the footer ("Rechtliches", SkinAddFooterLinks hook in wiki/LocalSettings.php).
P('Project', 'Legal', `
{{DISPLAYTITLE:Rechtliches}}
{{SHORTDESC:Lizenzen und Hinweis zum Fanprojekt}}
== Ein inoffizielles Fanprojekt ==
Westernis ist ein inoffizielles Fanprojekt. Es steht in keiner Verbindung zum Tolkien Estate, zum Tolkien Trust, zu Middle-earth Enterprises, zu den Verlagen HarperCollins und Klett-Cotta oder zu Lizenznehmern von Filmen und Spielen und wird von ihnen weder unterstützt noch genehmigt. J. R. R. Tolkiens Werke sind urheberrechtlich geschützt; „Der Herr der Ringe“, „Der Hobbit“, „Mittelerde“ sowie die Namen von Gestalten, Orten, Ereignissen und Dingen daraus sind Marken oder anderweitig geschützte Bezeichnungen ihrer jeweiligen Inhaber und werden hier nur verwendet, um zu benennen, wovon die Beispielseiten handeln.

Die Beispielseiten fassen das veröffentlichte Legendarium in eigenen Worten zusammen; kurze Zitate sind mit Quelle angegeben. Deutsche Namensformen folgen den eingeführten deutschen Übersetzungen.

== Lizenzen ==
* '''Code''' – Konfiguration, Skripte, Theme (CSS und JavaScript), Lua-Module, Generatoren und der MCP-Server: GNU Affero General Public License, Version 3 oder neuer (AGPL-3.0-or-later).
* '''Texte''' – die mitgelieferten Wiki-Seiten (Beispielartikel, Hauptseite, Hilfe- und Projektseiten, Vorlagendokumentation): Creative Commons Namensnennung – Weitergabe unter gleichen Bedingungen 4.0 International (CC BY-SA 4.0).
* '''Grafiken''' – Karte, Landschaft, Symbole, Ornamente und Logos: CC BY-SA 4.0 (die Skripte, die sie zeichnen, gehören zum Code).
* '''Schriften''' – SIL Open Font License 1.1; Tengwar Telcontar: GNU General Public License, Version 3 oder neuer, mit Ausnahme für eingebettete Schriften. Die Lizenztexte liegen bei den Schriftdateien unter <code>/assets/fonts</code>.
* '''MediaWiki''' und seine Erweiterungen werden beim Bau des Docker-Images geladen und stehen unter ihren eigenen Lizenzen.

Die Lizenzen dieses Projekts (AGPL-3.0-or-later für den Code, CC BY-SA 4.0 für Texte und Grafiken) erfassen nur die eigenen Beiträge und räumen keine Rechte an Tolkiens Werken oder an Marken Dritter ein. Einzelheiten und Urheberangaben stehen in den Dateien <code>LICENSE</code>, <code>content/LICENSE.md</code> und <code>THIRD_PARTY_NOTICES.md</code> des Quellcodes.

== Quellcode ==
Der Quellcode von Westernis ist frei verfügbar: [https://github.com/shiftbloom-studio/westernis github.com/shiftbloom-studio/westernis]. Der Link „Quellcode (AGPL)“ in der Fußzeile führt zum Quellcode der Fassung, die dieses Wiki betreibt.
`);

P('Help', 'Editing', `
{{SHORTDESC:Der Rundgang in fünf Minuten}}
== Einen Eintrag anlegen ==
# Öffne [[Westernis:Create|Einen Eintrag beginnen]] und wähle eine Art – oder geh zu einer der Hauptkategorien (etwa [[:Category:Characters|Gestalten]]) und nutze dort das Feld '''Anlegen'''.
# Fülle das Formular aus. Felder mit Listen (Eltern, Mitglieder, Orte) werden durch Kommata getrennt und von selbst verlinkt.
# Der Text des Eintrags ist mit einem Gerüst vorbefüllt; ersetze die Kommentare.
# Speichere. Infobox, Kategorien, Zeittafel, Stammbaum und die Liste der „Auftritte in den Chroniken“ aktualisieren sich von selbst.

== Bearbeiten ==
* '''Bearbeiten''' öffnet wieder das Formular (sein Textfeld trägt die Wiki-Werkzeugleiste); '''Quelltext bearbeiten''' öffnet den vollständigen Wikitext-Editor mit Syntaxhervorhebung, der Schnipselleiste darunter und dem Hochladen von Bildern per Ziehen und Ablegen (MsUpload). Der visuelle Editor steht auf jeder Seite bereit.
* Mit [[Special:BatchUpload|Mehrfach-Hochladen]] lädst du viele Dateien auf einmal hoch, mit [[Special:Upload|Hochladen]] eine einzelne.
* Drücke <kbd>/</kbd>, um die Befehlspalette zu öffnen und zu jeder Seite zu springen.

== Nützliche Vorlagen ==
* <code><nowiki>{{Quote|Text|Wer|Werk}}</nowiki></code> – illuminiertes Zitat
* <code><nowiki>{{Secret|title=…|text=…}}</nowiki></code> – verborgene Kunde
* <code><nowiki>{{Drop cap|G}}</nowiki></code> – illuminierte Initiale
* <code><nowiki>{{Timeline|era=Third Age}}</nowiki></code> – Zeittafel eines Zeitalters, eines Ortes oder einer Person
* <code><nowiki>{{Family tree}}</nowiki></code>, <code><nowiki>{{Relationships}}</nowiki></code>, <code><nowiki>{{Appearances}}</nowiki></code> – Stammbaum, Beziehungen, Auftritte in den Chroniken
* <code><nowiki>{{Divider}}</nowiki></code> – Zierlinie
* <code><nowiki>{{Map:Westernis}}</nowiki></code> – die Weltkarte

== Karten ==
Karten sind JSON-Seiten im Namensraum <code>Map:</code> (Erweiterung DataMaps). Die Markierungen werden auf der Kartenseite selbst festgelegt: Öffne [[Map:Westernis]], klicke auf den Stift und füge einen Eintrag mit <code>x</code>/<code>y</code> (0–100), <code>name</code> und <code>article</code> hinzu. Die Felder <code>map</code>, <code>map_x</code> und <code>map_y</code> eines Ortes sind nur Merkhilfen, damit die Koordinaten auch beim Eintrag vermerkt bleiben.
`);

// ---------------------------------------------------------------- housekeeping categories
const CATS = {
  // name: [German display title, description, hidden?]
  'Westernis': ['Der Kodex', 'Die Wurzel des Kodex. Jede Eintragskategorie hängt hier.'],
  'Tolkien canon': ['Tolkien-Kanon', 'Einträge, die Tolkiens veröffentlichtes Legendarium zusammenfassen (Kanon = Tolkien).'],
  'Westernis canon': ['Westernis-Kanon', 'Der eigene Kanon von Westernis (Kanon = Westernis).'],
  'Draft articles': ['Entwürfe', 'Ungeprüfte Seiten, darunter alles, was Claude Code anlegt (Kanon = Draft). Freigegeben wird über das Kanon-Feld.'],
  'Stubs': ['Unvollendete Einträge', 'Seiten mit der Vorlage {{tl|Stub}}.'],
  'Articles without an image': ['Einträge ohne Bild', 'Einträge, deren Infobox noch kein Bild hat.', true],
  'Pages with secrets': ['Seiten mit Geheimnissen', 'Seiten mit einem {{tl|Secret}}-Block.', true],
  'Infobox templates': ['Infobox-Vorlagen', 'Die Infobox-Vorlagen der Eintragsarten (erzeugt aus tools/gen-entities/entities.js).', true],
  'Forms': ['Formulare', 'Page-Forms-Formulare, eines je Eintragsart.', true],
  'Skeleton templates': ['Gerüst-Vorlagen', 'Artikelgerüste, die die Formulare vorladen.', true],
  'Layout templates': ['Gestaltungsvorlagen', 'Zierende und gliedernde Vorlagen (Zitate, Trenner, Initialen, Kopfbanner).', true],
  'Query templates': ['Abfragevorlagen', 'Vorlagen, die ihren Inhalt aus den Cargo-Tabellen ziehen (Zeittafel, Stammbaum, Beziehungen, Auftritte).', true],
  'Notice templates': ['Hinweisvorlagen', 'Banner wie {{tl|Stub}}.', true],
  'Documentation templates': ['Dokumentationsvorlagen', 'Helfer für Vorlagendokumentationen.', true],
  'Wartung': ['Wartung', 'Technische und Wartungskategorien. Sie sind versteckt und erscheinen nicht unter den Einträgen.', true],
  // system tracking categories (German and English names, depending on the interface language)
  'Seiten mit kurzer Beschreibung': ['Seiten mit kurzer Beschreibung', 'Von ShortDescription geführt.', true],
  'Pages with short description': ['Pages with short description', 'Von ShortDescription geführt.', true],
  'Seiten, die DynamicPageList4 parser function nutzen': ['Seiten mit DPL-Abfragen', 'Von DynamicPageList4 geführt.', true],
  'Pages using DynamicPageList4 parser function': ['Pages using DynamicPageList4 parser function', 'Von DynamicPageList4 geführt.', true],
  'Pages using DynamicPageList4': ['Pages using DynamicPageList4', 'Von DynamicPageList4 geführt.', true],
  'Seiten mit interaktiven Karten': ['Seiten mit interaktiven Karten', 'Von DataMaps geführt.', true],
  'Pages including interactive maps': ['Pages including interactive maps', 'Von DataMaps geführt.', true],
  'Karten ohne bestandene Datenüberprüfung': ['Karten ohne bestandene Datenüberprüfung', 'Von DataMaps geführt.', true],
  'Seiten mit defekten Dateilinks': ['Seiten mit defekten Dateilinks', 'Von MediaWiki geführt.', true],
  'Versteckte Kategorien': ['Versteckte Kategorien', 'Von MediaWiki geführt.', true],
};
const catText = (name, [title, desc, hidden]) => [
  title !== name ? `{{DISPLAYTITLE:${title}}}` : '',
  hidden ? '__HIDDENCAT__' : '',
].filter(Boolean).join('') + `
${desc}
${name === 'Westernis' || name === 'Wartung' ? '' : hidden ? '[[Category:Wartung]]' : '[[Category:Westernis]]'}`;
for (const [name, def] of Object.entries(CATS)) {
  P('Category', name, catText(name, def));
}

// ---------------------------------------------------------------- run
for (const [ns, title, text] of pages) console.log('  ' + write(ns, title, text));
console.log(`\n${pages.length} sample/help pages written`);
